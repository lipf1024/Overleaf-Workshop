import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SyncAdapter, SyncCoordinator } from '../../scm/localReplicaSync/coordinator';
import { ApplyResult, RemoteSnapshot } from '../../scm/localReplicaSync/model';
import { contentHash } from '../../scm/localReplicaSync/hash';
import { hasUnresolvedConflict } from '../../scm/localReplicaSync/conflictState';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';

// Exercise command routing with the real coordinator and persisted conflict
// state. Native merge-model behavior belongs to the extension-host suite.
class Uri {
    constructor(readonly scheme:string,readonly path:string) {}
    static file(value:string):Uri { return new Uri('file',value); }
    static joinPath(base:Uri,...parts:string[]):Uri { return new Uri(base.scheme,path.posix.join(base.path,...parts)); }
    get fsPath():string { return this.path; }
    with(change:{scheme?:string}):Uri { return new Uri(change.scheme??this.scheme,this.path); }
    toString():string { return this.scheme+':'+this.path; }
}

class Disposable {
    constructor(private readonly release:()=>void=()=>{}) {}
    dispose():void { this.release(); }
    static from(...values:Disposable[]):Disposable { return new Disposable(()=>values.forEach(value=>value.dispose())); }
}

class Emitter {
    private readonly listeners=new Set<(event:any)=>void>();
    readonly event=(listener:(event:any)=>void):Disposable=>{
        this.listeners.add(listener); return new Disposable(()=>this.listeners.delete(listener));
    };
    fire(event:any):void { this.listeners.forEach(listener=>listener(event)); }
    dispose():void { this.listeners.clear(); }
}

class TextInput { constructor(readonly uri:Uri) {} }
interface DraftDocument { uri:Uri; isDirty:boolean; save():Promise<boolean>; }
const tabsChanged=new Emitter(),groupsChanged=new Emitter(),editorChanged=new Emitter(),documentsChanged=new Emitter();
const commands=new Map<string,(...args:any[])=>unknown>();
const contexts=new Map<string,unknown>();
const tabs:any[]=[];
let activeTab:any;
let nativeOpens=0,nativeAccepts=0,nativeLoadingAttempts=0,nativeAcceptance=true;
const buttons:Array<{id:string;text:string;visible:boolean;command?:{command:string;arguments:unknown[]}}>=[];
const information:Array<{message:string;actions:string[]}>=[],warnings:string[]=[],errors:string[]=[];
const markCommand='overleaf-workshop.localReplica.markResolved';

const vscodeMock={
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Match the public VS Code API names.
    Uri,Disposable,EventEmitter:Emitter,TabInputText:TextInput,StatusBarAlignment:{Left:1},FilePermission:{Readonly:1},
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Match the public VS Code API names.
    FileSystemError:{FileNotFound:()=>new Error('missing'),NoPermissions:()=>new Error('read-only')},
    l10n:{t:(value:string,...args:unknown[])=>value.replace(/\{(\d+)\}/g,(_,index)=>String(args[Number(index)]))},
    window:{
        activeTextEditor:undefined as {document:DraftDocument}|undefined,
        tabGroups:{
            get activeTabGroup() { return {activeTab}; },
            get all() { return [{tabs}]; },
            onDidChangeTabs:tabsChanged.event,onDidChangeTabGroups:groupsChanged.event,
        },
        onDidChangeActiveTextEditor:editorChanged.event,
        createStatusBarItem:(id:string)=>{
            const button={id,text:'',visible:false,show(){this.visible=true;},hide(){this.visible=false;},dispose(){this.visible=false;}};
            buttons.push(button); return button;
        },
        showInformationMessage:async(message:string,...actions:string[])=>{ information.push({message,actions}); return undefined; },
        showWarningMessage:async(message:string)=>{ warnings.push(message); return undefined; },
        showErrorMessage:async(message:string)=>{ errors.push(message); return undefined; },
        showQuickPick:async()=>undefined,
    },
    workspace:{
        textDocuments:[] as DraftDocument[],onDidChangeTextDocument:documentsChanged.event,
        registerFileSystemProvider:()=>new Disposable(),
        fs:{readFile:(uri:Uri)=>fs.readFile(uri.fsPath)},
    },
    commands:{
        registerCommand:(name:string,handler:(...args:any[])=>unknown)=>{
            commands.set(name,handler); return new Disposable(()=>{commands.delete(name);});
        },
        executeCommand:async(name:string,...args:any[]):Promise<any>=>{
            if (name==='setContext') { contexts.set(args[0],args[1]); return; }
            if (name==='_open.mergeEditor') {
                nativeOpens++;
                const options=args[0];
                activeTab=tabs.find(tab=>tab.input.result?.toString()===options.output.toString());
                if (!activeTab) {
                    activeTab={input:{base:options.base,input1:options.input1.uri,input2:options.input2.uri,result:options.output}};
                    tabs.push(activeTab);
                }
                tabsChanged.fire({opened:[activeTab],closed:[],changed:[]}); return;
            }
            if (name==='mergeEditor.acceptMerge') {
                assert.ok(activeTab?.input.result,'Only the native merge tab may be completed');
                if (nativeLoadingAttempts>0) { nativeLoadingAttempts--; return undefined; }
                nativeAccepts++;
                if (!nativeAcceptance) { return {successful:false}; }
                const tab=activeTab; tabs.splice(tabs.indexOf(tab),1); activeTab=tabs[tabs.length-1];
                tabsChanged.fire({opened:[],closed:[tab],changed:[]});
                return {successful:true};
            }
            assert.ok(commands.has(name),'Command must be registered: '+name);
            return commands.get(name)!(...args);
        },
    },
};

const nodeModule=require('module');
const originalLoad=nodeModule._load;
let conflictManagerClass:typeof import('../../scm/localReplicaSync/conflictManager').ConflictManager;
try {
    nodeModule._load=function(request:string,...args:unknown[]) {
        return request==='vscode'?vscodeMock:originalLoad.call(this,request,...args);
    };
    conflictManagerClass=require('../../scm/localReplicaSync/conflictManager').ConflictManager;
} finally { nodeModule._load=originalLoad; }

class ActionAdapter implements SyncAdapter {
    readonly remote=new Map([['main.tex',Buffer.from('base\n')]]);
    private readonly versions=new Map([['main.tex',1]]);
    writes=0;
    failVerification=false;
    constructor(private readonly root:string) {}
    updateRemote(name:string,content:Uint8Array):void {
        this.remote.set(name,Buffer.from(content)); this.versions.set(name,(this.versions.get(name)??0)+1);
    }
    async listPaths():Promise<string[]> { return [...this.remote.keys()]; }
    async readLocal(name:string):Promise<Uint8Array> { return fs.readFile(path.join(this.root,name)); }
    async readRemote(name:string):Promise<RemoteSnapshot> {
        const content=this.remote.get(name)!;
        const hash=contentHash(content)!;
        return {path:name,entityId:'doc:'+name,kind:'text',content,hash,
            revision:{kind:'document',documentVersion:this.versions.get(name)!,contentHash:hash},connectionEpoch:1};
    }
    async applyRemote(name:string,_expected:unknown,content:Uint8Array):Promise<ApplyResult> {
        this.writes++;
        if (this.failVerification) { return {type:'unknown',message:'Upload could not be verified'}; }
        this.updateRemote(name,content);
        return {type:'verified',snapshot:await this.readRemote(name)};
    }
    async deleteRemote():Promise<ApplyResult> { throw new Error('Unexpected deletion'); }
    isLocalDirty():boolean { return false; }
    connectionEpoch():number { return 1; }
}

suite('Overleaf mark-as-resolved actions',()=>{
    let root:string,manager:InstanceType<typeof conflictManagerClass>,coordinator:SyncCoordinator,adapter:ActionAdapter,id:string;
    const working=()=>Uri.file(path.join(root,'main.tex'));
    const button=()=>buttons.find(item=>item.id==='overleaf-workshop.completeMerge')!;
    const record=()=>coordinator.records().find(item=>item.path==='main.tex')!;

    setup(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-resolution-action-'));
        buttons.length=0; contexts.clear(); tabs.length=0; information.length=0; warnings.length=0; errors.length=0;
        activeTab=undefined; nativeOpens=0; nativeAccepts=0; nativeLoadingAttempts=0; nativeAcceptance=true;
        vscodeMock.workspace.textDocuments.length=0; vscodeMock.window.activeTextEditor=undefined;
        await fs.writeFile(working().fsPath,'base\n');
        adapter=new ActionAdapter(root);
        coordinator=new SyncCoordinator(new SyncStateStore(root,{projectId:'action-test',serverIdentityHash:'test'}),adapter,'safeAuto');
        await coordinator.initialize();
        await fs.writeFile(working().fsPath,'local\n');
        adapter.updateRemote('main.tex',Buffer.from('remote\n'));
        await coordinator.handleRemote('main.tex');
        id=record().pendingConflictId!;
        assert.ok(id);
        manager=new conflictManagerClass(coordinator,Uri.file(root) as any);
    });

    teardown(async()=>{
        await manager.shutdown(); await coordinator.shutdown();
        await new Promise(resolve=>setImmediate(resolve));
        await fs.rm(root,{recursive:true,force:true});
        assert.deepStrictEqual(errors,[]);
    });

    async function saveAndClose(content='merged result\n'):Promise<Uri> {
        await manager.open(id);
        const output=activeTab.input.result as Uri;
        await fs.writeFile(output.fsPath,content);
        await vscodeMock.commands.executeCommand('mergeEditor.acceptMerge');
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        return output;
    }

    async function activateText(uri:Uri):Promise<void> {
        activeTab={input:new TextInput(uri)}; tabs.push(activeTab);
        tabsChanged.fire({opened:[activeTab],closed:[],changed:[]});
        await new Promise(resolve=>setImmediate(resolve));
    }

    async function assertResolved(content='merged result\n'):Promise<void> {
        assert.strictEqual(adapter.writes,1);
        assert.strictEqual(adapter.remote.get('main.tex')!.toString(),content);
        assert.strictEqual(await fs.readFile(working().fsPath,'utf8'),content);
        assert.strictEqual(record().status,'clean');
        assert.strictEqual(hasUnresolvedConflict(record()),false);
        assert.strictEqual(await coordinator.getConflict(id),undefined);
        assert.strictEqual((contexts.get('overleaf-workshop.localReplica.conflictResources') as string[]).includes(working().toString()),false);
    }

    test('shows a labeled action and resolves the result when invoked from an input pane',async()=>{
        await manager.open(id);
        const input=activeTab.input;
        assert.ok(button().visible);
        assert.ok(button().text.includes('Mark as Resolved'));
        assert.strictEqual(button().command?.command,markCommand);
        assert.strictEqual(button().command?.arguments[0],id);
        assert.strictEqual(contexts.get('overleaf-workshop.localReplica.mergeActive'),true);
        await fs.writeFile(input.result.fsPath,'merged result\n');
        nativeLoadingAttempts=2;
        await vscodeMock.commands.executeCommand(markCommand,input.input1);
        assert.strictEqual(nativeAccepts,1);
        await assertResolved();
        assert.strictEqual(button().visible,false);
    });

    test('marks a saved and closed merge as resolved from its Source Control resource',async()=>{
        await saveAndClose();
        assert.strictEqual(button().visible,false);
        await vscodeMock.commands.executeCommand(markCommand,{resourceUri:working()});
        await assertResolved();
        assert.strictEqual(nativeOpens,1,'A saved result must not require reopening the merge editor');
    });

    test('the native Result button resolves its result URI and preserves cancellation',async()=>{
        await manager.open(id);
        const result=activeTab.input.result;
        await fs.writeFile(result.fsPath,'merged result\n');
        nativeAcceptance=false;
        await vscodeMock.commands.executeCommand('overleaf-workshop.localReplica.markResolvedInEditor',result);
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        nativeAcceptance=true;
        await vscodeMock.commands.executeCommand('overleaf-workshop.localReplica.markResolvedInEditor',result);
        await assertResolved();
    });

    test('marks a saved merge as resolved from Explorer after restarting the manager and coordinator',async()=>{
        await saveAndClose();
        await manager.shutdown(); await coordinator.shutdown();
        coordinator=new SyncCoordinator(new SyncStateStore(root,{projectId:'action-test',serverIdentityHash:'test'}),adapter,'safeAuto');
        await coordinator.initialize();
        manager=new conflictManagerClass(coordinator,Uri.file(root) as any);
        await vscodeMock.commands.executeCommand(markCommand,working());
        await assertResolved();
        assert.strictEqual(nativeOpens,1);
    });

    test('offers the action while the original conflicted working file is active',async()=>{
        await saveAndClose();
        await activateText(working());
        assert.ok(button().visible);
        assert.strictEqual(button().command?.arguments[0],id);
        await vscodeMock.commands.executeCommand(markCommand);
        await assertResolved();
        assert.strictEqual(button().visible,false);
        assert.strictEqual(nativeOpens,1);
    });

    test('saves a dirty merge draft opened as an ordinary text file before marking it resolved',async()=>{
        const output=await saveAndClose('earlier draft\n');
        await activateText(output);
        let saves=0;
        vscodeMock.workspace.textDocuments.push({uri:output,isDirty:true,save:async()=>{
            saves++; await fs.writeFile(output.fsPath,'merged result\n'); return true;
        }});
        assert.ok(button().visible);
        await vscodeMock.commands.executeCommand(button().command!.command,...button().command!.arguments);
        await assertResolved();
        assert.strictEqual(saves,1);
        assert.strictEqual(nativeOpens,1);
    });

    test('targets the selected conflict even while another merge is active',async()=>{
        await saveAndClose();
        const chapter=path.join(root,'chapter.tex');
        await fs.writeFile(chapter,'base\n'); adapter.updateRemote('chapter.tex',Buffer.from('base\n'));
        await coordinator.handleLocal('chapter.tex');
        await fs.writeFile(chapter,'chapter local\n'); adapter.updateRemote('chapter.tex',Buffer.from('chapter remote\n'));
        await coordinator.handleRemote('chapter.tex');
        const chapterId=coordinator.records().find(item=>item.path==='chapter.tex')!.pendingConflictId!;
        await manager.open(chapterId);
        const chapterTab=activeTab;
        await vscodeMock.commands.executeCommand(markCommand,{resourceUri:working()});
        await assertResolved();
        assert.strictEqual(activeTab,chapterTab);
        assert.ok(coordinator.records().find(item=>item.path==='chapter.tex')!.pendingConflictId);
        assert.strictEqual(adapter.remote.get('chapter.tex')!.toString(),'chapter remote\n');
    });

    test('cancelling the native remaining-conflicts confirmation preserves the conflict',async()=>{
        await manager.open(id);
        await fs.writeFile(activeTab.input.result.fsPath,'merged result\n');
        nativeAcceptance=false;
        await vscodeMock.commands.executeCommand(markCommand);
        assert.strictEqual(nativeAccepts,1);
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        assert.ok(button().visible);
        assert.ok(activeTab.input.result);
    });

    test('requires review when marking a conflict that has no saved merge result',async()=>{
        await vscodeMock.commands.executeCommand(markCommand,{resourceUri:working()});
        assert.strictEqual(nativeOpens,1);
        assert.strictEqual(nativeAccepts,0);
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        assert.ok(information.some(item=>item.message.includes('Review the merged result')));
    });

    test('opens updated inputs instead of applying a saved result from an older conflict snapshot',async()=>{
        const oldOutput=await saveAndClose('old reviewed result\n');
        adapter.updateRemote('main.tex',Buffer.from('newer remote\n'));
        await coordinator.handleRemote('main.tex');
        await vscodeMock.commands.executeCommand(markCommand,working());
        assert.strictEqual(nativeOpens,2);
        assert.notStrictEqual(activeTab.input.result.toString(),oldOutput.toString());
        assert.strictEqual(await fs.readFile(oldOutput.fsPath,'utf8'),'old reviewed result\n');
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        assert.strictEqual(adapter.remote.get('main.tex')!.toString(),'newer remote\n');
    });

    test('rejects a changed remote version even when the background scan has not seen it',async()=>{
        await saveAndClose();
        adapter.updateRemote('main.tex',Buffer.from('newer remote\n'));
        await vscodeMock.commands.executeCommand(markCommand,working());
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        assert.strictEqual(await fs.readFile(working().fsPath,'utf8'),'local\n');
        assert.strictEqual(adapter.remote.get('main.tex')!.toString(),'newer remote\n');
    });

    test('does not mark a saved result containing conflict markers as resolved',async()=>{
        await saveAndClose('<<<<<<< Local\nlocal\n=======\nremote\n>>>>>>> Overleaf\n');
        await vscodeMock.commands.executeCommand(markCommand,{resourceUri:working()});
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        assert.ok(warnings.some(message=>message.includes('Conflict markers')));
    });

    test('keeps the conflict marker and actions until the remote write is verified',async()=>{
        await saveAndClose();
        adapter.failVerification=true;
        await vscodeMock.commands.executeCommand(markCommand,{resourceUri:working()});
        assert.strictEqual(adapter.writes,1);
        assert.strictEqual(record().pendingConflictId,id);
        assert.strictEqual(record().status,'pending-upload');
        assert.strictEqual(hasUnresolvedConflict(record()),true);
        assert.ok(await coordinator.getConflict(id));
        assert.ok((contexts.get('overleaf-workshop.localReplica.conflictResources') as string[]).includes(working().toString()));
        assert.strictEqual(information.some(item=>item.message.startsWith('Marked as resolved:')),false);
    });

    test('retains the old completion command as a compatible alias',async()=>{
        await saveAndClose();
        await vscodeMock.commands.executeCommand('overleaf-workshop.localReplica.completeMerge',working());
        await assertResolved();
    });

    test('closing a draft preserves the conflict and offers an explicit mark-as-resolved action',async()=>{
        await saveAndClose();
        const deadline=Date.now()+2000;
        while (!information.some(item=>item.actions.includes('Mark as Resolved')) && Date.now()<deadline) {
            await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(record().pendingConflictId,id);
        assert.strictEqual(button().visible,false);
        assert.strictEqual(contexts.get('overleaf-workshop.localReplica.mergeActive'),false);
        assert.ok(information.some(item=>item.actions.includes('Mark as Resolved') && item.actions.includes('Reopen Merge Editor')));
    });
});
