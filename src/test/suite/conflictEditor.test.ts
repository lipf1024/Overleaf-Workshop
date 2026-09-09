import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConflictManager, CONFLICT_SNAPSHOT_SCHEME, isNativeMergeInput } from '../../scm/localReplicaSync/conflictManager';
import { ConflictPresentation } from '../../scm/localReplicaSync/conflictPresentation';
import { SyncAdapter, SyncCoordinator } from '../../scm/localReplicaSync/coordinator';
import { contentHash } from '../../scm/localReplicaSync/hash';
import { ApplyResult, RemoteSnapshot } from '../../scm/localReplicaSync/model';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';

const bytes=(text:string)=>Buffer.from(text);
const text=(content:Uint8Array)=>Buffer.from(content).toString('utf8');

async function until(check:()=>boolean|Promise<boolean>):Promise<void> {
    const deadline=Date.now()+15000;
    while (Date.now()<deadline) {
        if (await check()) { return; }
        await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.fail('Timed out waiting for the native merge editor');
}

class EditorAdapter implements SyncAdapter {
    remote=bytes('base\n');
    version=1;
    writes=0;
    constructor(private readonly root:string) {}
    async listPaths():Promise<string[]> { return ['main.tex']; }
    async readLocal(name:string):Promise<Uint8Array> { return fs.readFile(path.join(this.root,name)); }
    async readRemote(name:string):Promise<RemoteSnapshot> {
        const hash=contentHash(this.remote)!;
        return {path:name,entityId:'doc-1',kind:'text',content:this.remote,hash,
            revision:{kind:'document',documentVersion:this.version,contentHash:hash},connectionEpoch:1};
    }
    async applyRemote(name:string,_expected:unknown,content:Uint8Array):Promise<ApplyResult> {
        this.writes++; this.remote=Buffer.from(content); this.version++;
        return {type:'verified',snapshot:await this.readRemote(name)};
    }
    async deleteRemote():Promise<ApplyResult> { throw new Error('Unexpected deletion'); }
    isLocalDirty(name:string):boolean {
        return vscode.workspace.textDocuments.some(doc=>doc.uri.fsPath===path.join(this.root,name) && doc.isDirty);
    }
    connectionEpoch():number { return 1; }
}

suite('Native Overleaf conflict editor',function(){
    this.timeout(25000);
    let root:string,adapter:EditorAdapter,coordinator:SyncCoordinator,manager:ConflictManager,id:string;

    setup(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-native-merge-'));
        await fs.writeFile(path.join(root,'main.tex'),'base\n');
        adapter=new EditorAdapter(root);
        coordinator=new SyncCoordinator(new SyncStateStore(root,{projectId:'native-test',serverIdentityHash:'test'}),adapter,'safeAuto');
        await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),'local\n');
        adapter.remote=bytes('remote\n'); adapter.version++;
        await coordinator.handleRemote('main.tex');
        id=coordinator.records()[0].pendingConflictId!;
        manager=new ConflictManager(coordinator,vscode.Uri.file(root));
    });

    teardown(async()=>{
        await manager.shutdown();
        await coordinator.shutdown();
        // Finish the isolated editor draft without applying anything to the adapter.
        const input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (isNativeMergeInput(input)) {
            await acceptLocal();
            await vscode.commands.executeCommand('mergeEditor.acceptMerge');
        }
        await coordinator.flush();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await fs.rm(root,{recursive:true,force:true});
    });

    async function openEditor() {
        await manager.open(id);
        await until(()=>isNativeMergeInput(vscode.window.tabGroups.activeTabGroup.activeTab?.input));
        const input=vscode.window.tabGroups.activeTabGroup.activeTab!.input;
        assert.ok(isNativeMergeInput(input));
        const document=await vscode.workspace.openTextDocument(input.result);
        await until(()=>!document.getText().includes('<<<<<<<'));
        return {input,document};
    }

    async function acceptLocal():Promise<void> {
        await until(async()=>{
            await vscode.commands.executeCommand('merge.acceptAllInput1');
            const input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            return isNativeMergeInput(input) && (await vscode.workspace.openTextDocument(input.result)).getText()==='local\n';
        });
    }

    test('uses native read-only inputs and clears the conflict only when explicitly marked resolved',async()=>{
        const presentation=new ConflictPresentation(vscode.Uri.file(root),target=>manager.open(target??id));
        const stop=coordinator.onDidChange(records=>presentation.update(records,false));
        try {
            presentation.update(coordinator.records(),false);
            const working=vscode.Uri.file(path.join(root,'main.tex'));
            assert.strictEqual((await presentation.provideFileDecoration(working))?.badge,'!');
            assert.strictEqual((await presentation.provideFileDecoration(working))?.color?.id,'gitDecoration.conflictingResourceForeground');
            const {input,document}=await openEditor();
            assert.strictEqual(input.input1.scheme,CONFLICT_SNAPSHOT_SCHEME);
            assert.strictEqual(text(await vscode.workspace.fs.readFile(input.input1)),'local\n');
            assert.strictEqual(text(await vscode.workspace.fs.readFile(input.input2)),'remote\n');
            assert.strictEqual((await vscode.workspace.fs.stat(input.input1)).permissions,vscode.FilePermission.Readonly);
            await assert.rejects(async()=>vscode.workspace.fs.writeFile(input.input1,bytes('must not write')));
            assert.notStrictEqual(input.result.toString(),working.toString());
            await acceptLocal();
            assert.strictEqual(await document.save(),true);
            await until(async()=>{
                const conflict=await coordinator.getConflict(id);
                const draft=await coordinator.getObject(conflict?.draftObjectId);
                return Boolean(draft && text(draft)==='local\n');
            });
            assert.strictEqual(adapter.writes,0);
            assert.strictEqual(coordinator.records()[0].status,'conflict');
            await vscode.commands.executeCommand('overleaf-workshop.localReplica.markResolved');
            assert.strictEqual(adapter.writes,1);
            assert.strictEqual(coordinator.records()[0].status,'clean');
            assert.strictEqual(await coordinator.getConflict(id),undefined);
            assert.strictEqual(await presentation.provideFileDecoration(working),undefined);
        } finally { stop(); presentation.dispose(); }
    });

    test('closing the native editor saves a draft without resolving or uploading it',async()=>{
        const {document}=await openEditor();
        await acceptLocal();
        await document.save();
        const accepted=await vscode.commands.executeCommand<{successful:boolean}>('mergeEditor.acceptMerge');
        assert.strictEqual(accepted?.successful,true);
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(coordinator.records()[0].status,'conflict');
        assert.strictEqual(await fs.readFile(path.join(root,'main.tex'),'utf8'),'local\n');
    });

    test('a closed native merge can be marked resolved from its Source Control resource',async()=>{
        const {document}=await openEditor();
        await acceptLocal();
        await document.save();
        await vscode.commands.executeCommand('mergeEditor.acceptMerge');
        const resource={resourceUri:vscode.Uri.file(path.join(root,'main.tex'))};
        await vscode.commands.executeCommand('overleaf-workshop.localReplica.markResolved',resource);
        assert.strictEqual(adapter.writes,1);
        assert.strictEqual(coordinator.records()[0].status,'clean');
        assert.strictEqual(await coordinator.getConflict(id),undefined);
        assert.strictEqual(vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>isNativeMergeInput(tab.input))),false);
    });

    test('a saved result can be marked resolved from the original file after the manager restarts',async()=>{
        const {document}=await openEditor();
        await acceptLocal();
        await document.save();
        await vscode.commands.executeCommand('mergeEditor.acceptMerge');
        await manager.shutdown(); await coordinator.flush();
        manager=new ConflictManager(coordinator,vscode.Uri.file(root));
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root,'main.tex')),{preview:false});
        await vscode.commands.executeCommand('overleaf-workshop.localReplica.markResolved');
        assert.strictEqual(adapter.writes,1);
        assert.strictEqual(coordinator.records()[0].status,'clean');
        assert.strictEqual(await coordinator.getConflict(id),undefined);
        assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText);
    });

    test('the old completion command still targets the result from an input pane',async()=>{
        const {input}=await openEditor();
        await acceptLocal();
        await vscode.commands.executeCommand('overleaf-workshop.localReplica.completeMerge',input.input1);
        assert.strictEqual(adapter.writes,1);
        assert.strictEqual(coordinator.records()[0].status,'clean');
        assert.strictEqual(await coordinator.getConflict(id),undefined);
    });

    test('the in-page Result button saves the merge and clears the conflict',async()=>{
        const {input}=await openEditor();
        await acceptLocal();
        await vscode.commands.executeCommand('overleaf-workshop.localReplica.markResolvedInEditor',input.result);
        assert.strictEqual(adapter.writes,1);
        assert.strictEqual(coordinator.records()[0].status,'clean');
        assert.strictEqual(await coordinator.getConflict(id),undefined);
    });

    test('a saved draft opened as a text file can be completed with one action',async()=>{
        const {input,document}=await openEditor();
        await acceptLocal();
        await document.save();
        await vscode.commands.executeCommand('mergeEditor.acceptMerge');
        await vscode.window.showTextDocument(input.result,{preview:false});
        assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText);
        await vscode.commands.executeCommand('overleaf-workshop.localReplica.markResolved',input.result);
        assert.strictEqual(adapter.writes,1);
        assert.strictEqual(coordinator.records()[0].status,'clean');
    });

    test('keeps immutable inputs and rejects application after an Overleaf update',async()=>{
        const {input}=await openEditor();
        await acceptLocal();
        adapter.remote=bytes('newer remote\n'); adapter.version++;
        await coordinator.handleRemote('main.tex');
        assert.strictEqual(text(await vscode.workspace.fs.readFile(input.input2)),'remote\n');
        await vscode.commands.executeCommand('overleaf-workshop.localReplica.markResolved');
        assert.strictEqual(adapter.writes,0);
        assert.strictEqual(coordinator.records()[0].status,'conflict');
        assert.strictEqual(text(adapter.remote),'newer remote\n');
        assert.strictEqual(await fs.readFile(path.join(root,'main.tex'),'utf8'),'local\n');
    });

    test('reopening a deliberately empty draft does not replace it with the local version',async()=>{
        await coordinator.saveConflictDraft(id,bytes(''),[]);
        const {document}=await openEditor();
        assert.strictEqual(document.getText(),'');
        assert.strictEqual(adapter.writes,0);
    });
});
