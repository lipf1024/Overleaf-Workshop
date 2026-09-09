/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { isolatedModule } from '../helpers/isolatedModule';
import { contentHash } from '../../scm/localReplicaSync/hash';
import { NetworkRequestError } from '../../api/network';

class Uri {
    constructor(readonly scheme:string,readonly authority:string,readonly path:string,readonly query='') {}
    static file(value:string):Uri { return new Uri('file','',value); }
    static parse(value:string):Uri { const url=new URL(value); return new Uri(url.protocol.slice(0,-1),url.host,decodeURIComponent(url.pathname),url.search.slice(1)); }
    static joinPath(base:Uri,...parts:string[]):Uri { return new Uri(base.scheme,base.authority,path.posix.join(base.path,...parts),base.query); }
    get fsPath():string { return this.path; }
    with(change:any):Uri { return new Uri(change.scheme??this.scheme,change.authority??this.authority,change.path??this.path,change.query??this.query); }
    toString():string { return `${this.scheme}://${this.authority}${this.path}${this.query?'?'+this.query:''}`; }
}
class Disposable { constructor(private release=()=>{}) {} dispose():void { this.release(); } static from(...items:Disposable[]):Disposable { return new Disposable(()=>items.forEach(item=>item.dispose())); } }
class Emitter { event=()=>new Disposable(); fire():void {} dispose():void {} }
class MarkdownString { constructor(public value='') {} appendMarkdown(value:string):void { this.value+=value; } }
class ThemeColor { constructor(readonly id:string) {} }
class Position { constructor(readonly line:number,readonly character:number) {} }
class Range { constructor(readonly start:Position,readonly end:Position) {} }
class Selection extends Range {}
class Diagnostic { constructor(readonly range:Range,readonly message:string,readonly severity:number) {} }
class FileSystemError extends Error {
    constructor(readonly code:string,message?:unknown) { super(String(message??code)); }
    static FileNotFound(value?:unknown):FileSystemError { return new FileSystemError('FileNotFound',value); }
    static FileExists(value?:unknown):FileSystemError { return new FileSystemError('FileExists',value); }
    static NoPermissions(value?:unknown):FileSystemError { return new FileSystemError('NoPermissions',value); }
    static FileIsADirectory(value?:unknown):FileSystemError { return new FileSystemError('FileIsADirectory',value); }
    static Unavailable(value?:unknown):FileSystemError { return new FileSystemError('Unavailable',value); }
}
const constants={ROOT_NAME:'overleaf-workshop',ELEGANT_NAME:'Overleaf Workshop',OUTPUT_FOLDER_NAME:'.output'};
const remote=(project='p',file='main.tex')=>Uri.parse(`overleaf-workshop://overleaf.test/Project${project}/${file}?user=u&project=${project}`);
const noEvent=()=>new Disposable();

function runtime() {
    const commands=new Map<string,(...args:any[])=>any>(),opened:Uri[]=[],diagnostics=new Map<string,unknown>();
    const messages:string[]=[],saveListeners=new Set<(document:any)=>unknown>(),eventListeners=new Map<string,Set<(payload:any)=>unknown>>();
    const vscode:any={Uri,Disposable,EventEmitter:Emitter,MarkdownString,ThemeColor,Position,Range,Selection,Diagnostic,FileSystemError,
        FileType:{File:1,Directory:2,SymbolicLink:64},FileChangeType:{Changed:1,Created:2,Deleted:3},DiagnosticSeverity:{Error:0,Warning:1,Information:2},StatusBarAlignment:{Left:1},ViewColumn:{Beside:2},TextEditorRevealType:{InCenter:0},
        l10n:{t:(value:string)=>value},languages:{createDiagnosticCollection:()=>({clear:()=>diagnostics.clear(),delete:(uri:Uri)=>diagnostics.delete(uri.toString()),set:(uri:Uri,values:unknown)=>diagnostics.set(uri.toString(),values),dispose:()=>{}})},
        workspace:{workspaceFolders:[],textDocuments:[],saveAll:async()=>true,onDidSaveTextDocument:(handler:(document:any)=>unknown)=>{ saveListeners.add(handler); return new Disposable(()=>saveListeners.delete(handler)); },getConfiguration:()=>({get:(_key:string,fallback:unknown)=>fallback}),
            fs:{readFile:(uri:Uri)=>fs.readFile(uri.fsPath),writeFile:(uri:Uri,content:Uint8Array)=>fs.writeFile(uri.fsPath,content),createDirectory:(uri:Uri)=>fs.mkdir(uri.fsPath,{recursive:true})},
            openTextDocument:async(uri:Uri)=>{ const text=await fs.readFile(uri.fsPath,'utf8'); return {uri,lineCount:text.split('\n').length,getText:()=>text}; }},
        window:{activeTextEditor:undefined,visibleTextEditors:[],setStatusBarMessage:()=>new Disposable(),showErrorMessage:async(value:string)=>{messages.push(value);},showWarningMessage:async(value:string)=>{messages.push(value);},
            createStatusBarItem:()=>({text:'',show:()=>{},hide:()=>{},dispose:()=>{}}),
            showTextDocument:async(uri:Uri)=>{ opened.push(uri); return {document:{uri,lineCount:20,lineAt:()=>({text:'sample'})},selections:[{}],revealRange:()=>{}};}},
        commands:{registerCommand:(name:string,handler:any)=>{commands.set(name,handler);return new Disposable(()=>commands.delete(name));},executeCommand:async(name:string,...args:any[])=>commands.get(name)?.(...args)},
    };
    const eventBus={on:(name:string,handler:(payload:any)=>unknown)=>{ const listeners=eventListeners.get(name)??new Set(); listeners.add(handler); eventListeners.set(name,listeners); return new Disposable(()=>listeners.delete(handler)); },
        fire:(name:string,payload:any)=>{ for (const listener of eventListeners.get(name)??[]) { listener(payload); } }};
    const common={vscode,'../consts':constants,'../utils/eventBus':{EventBus:eventBus},'./syncProgress':isolatedModule('scm/syncProgress',{vscode})};
    const coreMocks={...common,'../utils/globalStateManager':{GlobalStateManager:{authenticate:async()=>({})}},'../collaboration/clientManager':{},'../scm/scmCollectionProvider':{},'../api/extendedBase':{}};
    const core=isolatedModule('core/remoteFileSystemProvider',coreMocks);
    return {vscode,common,coreMocks,core,commands,messages,opened,diagnostics,eventBus,fireSave:async(document:any)=>Promise.all([...saveListeners].map(listener=>listener(document)))};
}

suite('0.16.7 remote and runtime regressions',()=>{
    test('unsupported spelling service is reported once and transient failures remain retryable',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype); let calls=0,status=503;
        Object.assign(vfs,{root:{spellCheckLanguage:'en'},_resolveUri:async()=>({fileType:'doc'}),api:{proxyRequestToSpellingApi:async()=>{calls++;return {type:'error',statusCode:status};}}});
        assert.strictEqual(await vfs.spellCheck(remote(),['word']),undefined);
        status=404;
        await vfs.spellCheck(remote(),['word']); await vfs.spellCheck(remote(),['another']);
        assert.strictEqual(calls,2); assert.strictEqual(r.messages.length,1);
    });

    test('failed spelling checks do not cache words as correct and queued duplicates reuse successful results',async()=>{
        const r=runtime();
        const {MisspellingCheckProvider}=isolatedModule('intellisense/langMisspellingCheckProvider',{
            ...r.common,'.':{IntellisenseProvider:class {}},'../core/remoteFileSystemProvider':r.core,
        });
        const provider=new MisspellingCheckProvider();let calls=0,fail=true;
        provider.vfsm={prefetch:async()=>({getDictionary:()=>[],spellCheck:async()=>{calls++;return fail?undefined:[];}})};
        await provider.check(remote(),'hello');
        assert.strictEqual(provider.learnedWords.has('hello'),false);
        fail=false;
        await Promise.all([provider.check(remote(),'hello'),provider.check(remote(),'hello')]);
        assert.strictEqual(calls,2); assert.strictEqual(provider.learnedWords.has('hello'),true);
    });

    test('PDF previews reuse the same build and retain the displayed source until a new PDF loads',async()=>{
        const r=runtime();const {PdfDocument}=isolatedModule('core/pdfViewEditorProvider',{...r.common,'../utils/globalStateManager':{}});
        let version='one',opens=0,fail=false;const disposed:string[]=[];
        const doc=new PdfDocument(remote('p','.output/output.pdf'),async()=>({key:version,open:async()=>{
            opens++;if(fail){throw new Error('download failed');}
            const key=version;return {initialData:new Uint8Array([1,2]),length:100,isDisposed:false,ranged:true,dispose:()=>disposed.push(key)};
        }}));
        await Promise.all([doc.refresh(),doc.refresh()]);await doc.refresh();assert.strictEqual(opens,1);doc.sourceLoaded(1);
        version='two';fail=true;await assert.rejects(()=>doc.refresh(),/download failed/);assert.strictEqual(doc.sourceId,1);assert.deepStrictEqual(disposed,[]);
        fail=false;await doc.refresh();assert.ok(doc.getSource(1));assert.deepStrictEqual(disposed,[]);
        doc.sourceLoaded(2);assert.deepStrictEqual(disposed,['one']);assert.strictEqual(doc.getSource(1),undefined);
        doc.dispose();assert.deepStrictEqual(disposed,['one','two']);
    });

    test('restored output preview registers before requesting its missing first build',async()=>{
        const r=runtime();
        const {PdfViewEditorProvider}=isolatedModule('core/pdfViewEditorProvider',{...r.common,'../utils/globalStateManager':{}});
        const provider=new PdfViewEditorProvider({extensionUri:Uri.file('/extension')});
        provider.getHtmlForWebview=async()=>'<head></head>';
        r.vscode.workspace.fs.readFile=async(uri:Uri)=>{
            if (uri.scheme===constants.ROOT_NAME) { throw FileSystemError.FileNotFound(uri); }
            return Buffer.from('<head></head>');
        };
        const uri=remote('p','.output/output.pdf');
        const doc=await provider.openCustomDocument(uri);
        assert.strictEqual(doc.cache.length,0);
        assert.strictEqual(doc.compileState.busy,true);
        let registered=false,compiled=false;
        r.eventBus.on('pdfWillOpenEvent',()=>{registered=true;});
        r.commands.set(`${constants.ROOT_NAME}.compileManager.compile`,(requested:Uri)=>{
            assert.strictEqual(registered,true); assert.strictEqual(requested,uri); compiled=true;
        });
        await provider.resolveCustomEditor(doc,{webview:{postMessage:()=>{},onDidReceiveMessage:()=>{}},onDidDispose:()=>{},onDidChangeViewState:()=>{}});
        assert.strictEqual(compiled,true);
        r.vscode.workspace.fs.readFile=async()=>Buffer.from('%PDF-1.7');
        await doc.refresh();
        assert.strictEqual(Buffer.from(doc.cache).toString(),'%PDF-1.7');
    });

    test('PDF opening still reports missing source PDFs and download errors',async()=>{
        const r=runtime();
        const {PdfViewEditorProvider}=isolatedModule('core/pdfViewEditorProvider',{...r.common,'../utils/globalStateManager':{}});
        const provider=new PdfViewEditorProvider({});
        r.vscode.workspace.fs.readFile=async()=>{throw FileSystemError.FileNotFound();};
        await assert.rejects(()=>provider.openCustomDocument(remote('p','figure.pdf')),/FileNotFound/);
        r.vscode.workspace.fs.readFile=async()=>{throw new Error('Download failed');};
        await assert.rejects(()=>provider.openCustomDocument(remote('p','.output/output.pdf')),/Download failed/);
    });

    test('B01: online saves use the established session without reading a remote snapshot',async()=>{
        const r=runtime(),uri=remote(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype);
        const targets:string[]=[];
        const session={save:async(content:string)=>{targets.push(content);}};
        Object.assign(vfs,{otDocuments:{peek:()=>session,get:async()=>session},otEditors:new Map(),
            _resolveUri:async()=>({fileType:'doc',fileEntity:{_id:'doc'}}),notify:()=>{},scheduleMetadataRefresh:()=>{},
            readRemoteSnapshot:async()=>{throw new Error('unexpected network read');}});
        await vfs.writeFile(uri,Buffer.from('first'),true,true);
        await vfs.writeFile(uri,Buffer.from('second'),true,true);
        assert.deepStrictEqual(targets,['first','second']);
    });
    test('B01: missing OT baseline and unconfirmed application both reject saving',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype);
        Object.assign(vfs,{_resolveUri:async()=>({fileType:'doc',fileEntity:{_id:'doc'}}),otEditors:new Map(),
            otDocuments:{peek:()=>undefined}});
        await assert.rejects(vfs.writeFile(remote(),Buffer.from('edit'),true,true),/baseline/);
        const session={save:async()=>{throw new Error('application confirmation lost');}};
        vfs.otDocuments={peek:()=>session,get:async()=>session};
        await assert.rejects(vfs.writeFile(remote(),Buffer.from('edit'),true,true),/confirmation lost/);
    });

    test('B04: re-enabling a replica waits for its old owner to stop and gets a fresh shutdown',async()=>{
        const r=runtime();
        const {LocalReplicaSCMProvider}=isolatedModule('scm/localReplicaSCM',{...r.common,'.':{BaseSCM:class {}},'../core/remoteFileSystemProvider':r.core,'./localReplicaSync':{},'./localReplicaSync/conflictPresentation':{ConflictPresentation:class {}}});
        const provider:any=Object.create(LocalReplicaSCMProvider.prototype); let starts=0,stops=0,release!:()=>void;
        provider.loggedErrors=new Map();
        provider.initWatch=async()=>{starts++;provider.stop=async()=>{stops++;if(stops===1){await new Promise<void>(resolve=>{release=resolve;});}};return [];};
        await Promise.all([provider.triggers,provider.triggers]); assert.strictEqual(starts,1);
        const firstStop=provider.shutdown(),restarted=provider.triggers;
        await new Promise(resolve=>setTimeout(resolve,0)); assert.strictEqual(starts,1); release();
        await Promise.all([firstStop,restarted]); assert.strictEqual(starts,2);
        await provider.shutdown(); assert.strictEqual(stops,2);
    });

    test('B07: compile preparation synchronizes only the requested local path',async()=>{
        const r=runtime();
        const {LocalReplicaSCMProvider}=isolatedModule('scm/localReplicaSCM',{...r.common,'.':{BaseSCM:class {}},'../core/remoteFileSystemProvider':r.core,'./localReplicaSync':{},'./localReplicaSync/conflictPresentation':{ConflictPresentation:class {}}});
        const provider:any=Object.create(LocalReplicaSCMProvider.prototype),handled:string[]=[]; let flushes=0,fullScans=0;
        Object.assign(provider,{baseUri:Uri.file('/replica'),coordinator:{isOwner:true,flushCurrent:async()=>{flushes++;},prepareLocalForCompile:async(value:string)=>{handled.push(value);},
            refreshLocalChanges:async()=>{fullScans++;},records:()=>[{path:'chapters/main.tex',status:'clean'}]}});
        LocalReplicaSCMProvider.instances.add(provider);
        try {
            assert.strictEqual(await LocalReplicaSCMProvider.prepareForCompile(Uri.file('/replica/chapters/main.tex')),true);
            assert.deepStrictEqual(handled,['chapters/main.tex']); assert.strictEqual(flushes,0); assert.strictEqual(fullScans,0);
        } finally { LocalReplicaSCMProvider.instances.delete(provider); }
    });

    test('compile permits unrelated pending files but blocks a saved file with a reason',async()=>{
        const r=runtime();
        const {LocalReplicaSCMProvider}=isolatedModule('scm/localReplicaSCM',{...r.common,'.':{BaseSCM:class {}},'../core/remoteFileSystemProvider':r.core,'./localReplicaSync':{},'./localReplicaSync/conflictPresentation':{ConflictPresentation:class {}}});
        const records=[{path:'main.tex',status:'clean'}, {path:'notes.md',status:'pending-upload'},
            {path:'figure.pdf',status:'pending-upload',message:'Binary uploads require explicit confirmation'}];
        const handled:string[]=[];
        const provider={baseUri:Uri.file('/replica'),coordinator:{isOwner:true,records:()=>records,
            flushCurrent:()=>{throw new Error('Unrelated queue must not be awaited');},prepareLocalForCompile:async(p:string)=>{handled.push(p);}}};
        LocalReplicaSCMProvider.instances.add(provider);
        try {
            assert.strictEqual(await LocalReplicaSCMProvider.prepareForCompile(Uri.file('/replica'),[Uri.file('/replica/main.tex')]),true);
            assert.deepStrictEqual(handled,['main.tex']);
            assert.ok(r.messages[0].includes('2 other local file(s)'));
            let reason='';
            assert.strictEqual(await LocalReplicaSCMProvider.prepareForCompile(Uri.file('/replica'),[Uri.file('/replica/main.tex'),Uri.file('/replica/figure.pdf')],(value:string)=>{reason=value;}),false);
            assert.ok(reason.includes('figure.pdf')); assert.ok(reason.includes('explicit confirmation'));
            records[0].status='conflict';
            assert.strictEqual(await LocalReplicaSCMProvider.prepareForCompile(Uri.file('/replica/main.tex')),false);
            provider.coordinator.prepareLocalForCompile=async()=>{throw new Error('confirmation unknown');};
            assert.strictEqual(await LocalReplicaSCMProvider.prepareForCompile(Uri.file('/replica/main.tex'),[],(value:string)=>{reason=value;}),false);
            assert.ok(reason.includes('main.tex')); assert.ok(reason.includes('confirmation unknown'));
        } finally { LocalReplicaSCMProvider.instances.delete(provider); }
    });

    test('scoped VFS wait includes only selected OT IDs and tolerates absent ignored paths',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype);
        let ids:string[]=[];
        vfs.otDocuments={barrier:async(value:string[])=>{ids=value;}};
        vfs._resolveUri=async(uri:Uri)=>{
            if (uri.path.endsWith('.aux')) { throw FileSystemError.FileNotFound(); }
            return {fileEntity:{_id:'selected-document'}};
        };
        await vfs.waitForSavedText([remote(),remote('p','ignored/file.aux')]);
        assert.deepStrictEqual(ids,['selected-document']);
        vfs._resolveUri=async()=>{throw new Error('connection failed');};
        await assert.rejects(vfs.waitForSavedText([remote()]),/connection failed/);
    });

    test('compile observer checks every saved path and excludes other projects',async()=>{
        const r=runtime();
        const {LocalReplicaSCMProvider}=isolatedModule('scm/localReplicaSCM',{...r.common,'.':{BaseSCM:class {}},'../core/remoteFileSystemProvider':r.core,'./localReplicaSync':{},'./localReplicaSync/conflictPresentation':{ConflictPresentation:class {}}});
        const checked:string[]=[];
        const provider={baseUri:Uri.file('/replica'),coordinator:{isOwner:false,records:()=>[],
            isObservedLocalPathPublished:async(p:string)=>{checked.push(p);return p==='main.tex';}}};
        LocalReplicaSCMProvider.instances.add(provider);
        try {
            assert.strictEqual(await LocalReplicaSCMProvider.prepareForCompile(Uri.file('/replica'),[Uri.file('/replica/main.tex'),Uri.file('/replica/chapter.tex'),Uri.file('/other/main.tex')]),false);
            assert.deepStrictEqual(checked,['main.tex','chapter.tex']);
        } finally { LocalReplicaSCMProvider.instances.delete(provider); }
    });

    test('Explorer decorations clear after synchronization and distinguish pending directions',()=>{
        const r=runtime();
        r.vscode.window.registerFileDecorationProvider=()=>new Disposable();
        const {ConflictPresentation}=isolatedModule('scm/localReplicaSync/conflictPresentation',{vscode:r.vscode});
        const presentation=new ConflictPresentation(Uri.file('/replica'),async()=>{});
        const file=Uri.file('/replica/figure.pdf');
        const record:any={path:'figure.pdf',status:'pending-upload',kind:'binary',observed:{}};
        try {
            presentation.update([record],false);
            assert.strictEqual(presentation.provideFileDecoration(file).badge,'A');
            record.base={}; presentation.update([record],false);
            assert.strictEqual(presentation.provideFileDecoration(file).badge,'M');
            record.status='pending-download'; presentation.update([record],false);
            assert.ok(presentation.provideFileDecoration(file).tooltip.includes('pending download'));
            record.suspension='blocked'; presentation.update([record],false);
            assert.strictEqual(presentation.provideFileDecoration(file).badge,'P');
            record.suspension='ignored'; presentation.update([record],false);
            assert.strictEqual(presentation.provideFileDecoration(file).badge,'Ⅱ');
            assert.strictEqual(presentation.provideFileDecoration(file).color.id,'gitDecoration.ignoredResourceForeground');
            assert.strictEqual(presentation.provideFileDecoration(file).propagate,false);
            record.base=undefined; presentation.update([record],false);
            assert.strictEqual(presentation.provideFileDecoration(file).badge,undefined);
            record.suspension=undefined; record.status='clean'; presentation.update([record],false);
            assert.strictEqual(presentation.provideFileDecoration(file),undefined);
        } finally { presentation.dispose(); }
    });

    test('untracked ignored paths are gray without propagating to parents and refresh after rule changes',async()=>{
        const r=runtime();
        r.vscode.window.registerFileDecorationProvider=()=>new Disposable();
        const {ConflictPresentation}=isolatedModule('scm/localReplicaSync/conflictPresentation',{vscode:r.vscode});
        let ignored=true;
        const presentation=new ConflictPresentation(Uri.file('/replica'),async()=>{},async(uri:any)=>ignored&&uri.fsPath.startsWith('/replica/private'));
        try {
            const file=Uri.file('/replica/private/a.tex');
            const decoration=await presentation.provideFileDecoration(file);
            assert.strictEqual(decoration.color.id,'gitDecoration.ignoredResourceForeground');
            assert.strictEqual(decoration.badge,undefined);
            assert.strictEqual(decoration.propagate,false);
            assert.strictEqual(await presentation.provideFileDecoration(Uri.file('/replica')),undefined);
            ignored=false; presentation.refreshIgnored();
            assert.strictEqual(await presentation.provideFileDecoration(file),undefined);
        } finally { presentation.dispose(); }
    });

    test('B06: Unicode is decoded exactly once for each WebSocket transport',async()=>{
        const r=runtime(),socketModule=isolatedModule('api/socketio',r.common);
        const sample='中文 é 😀 𠮷\nsecond line';
        for (const mode of ['v1','v2']) {
            const api:any=Object.create(socketModule.SocketIOAPI.prototype); api.scheme=mode; api._socketInitScheme=mode;
            api.emit=async()=>[Buffer.from(sample).toString('latin1').split('\n'),2,[],[]];
            assert.strictEqual((await api.joinDoc('doc')).docLines.join('\n'),sample);
        }
    });

    test('B08: failed settings initialization stops after five attempts and needs explicit retry',async()=>{
        const r=runtime();
        const core=isolatedModule('core/remoteFileSystemProvider',r.coreMocks,{setTimeout:(callback:()=>void)=>setTimeout(callback,0)});
        const vfs:any=Object.create(core.VirtualFileSystem.prototype); let joins=0,settings=0;
        Object.assign(vfs,{origin:remote(),serverName:'test',retryConnection:0,runtimeInitialized:true,handlersRegistered:true,disposed:false});
        vfs.socket={needsReinit:false,pause:()=>{},init:()=>{},joinProject:async()=>{joins++;return {};},completeProjectRefresh:()=>{}};
        vfs.fetchProjectSettings=async()=>{settings++;throw new Error('settings temporarily unavailable');};
        await assert.rejects(()=>vfs.init()); assert.strictEqual(joins,5); assert.strictEqual(settings,5);
        await assert.rejects(()=>vfs.init()); assert.strictEqual(joins,5);
        vfs.fetchProjectSettings=async()=>({}); await vfs.retryInitialization(); assert.strictEqual(joins,6); assert.strictEqual(vfs.retryConnection,0);
    });

    test('B08: authentication failure is terminal for the automatic retry loop',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype); let joins=0;
        Object.assign(vfs,{origin:remote(),serverName:'test',retryConnection:0,runtimeInitialized:true,handlersRegistered:true,disposed:false});
        vfs.socket={needsReinit:false,pause:()=>{},joinProject:async()=>{ joins++;throw new NetworkRequestError('auth-required','sign in'); }};
        await assert.rejects(()=>vfs.init(),/sign in/); assert.strictEqual(joins,1);
    });

    test('B08: a Socket.IO authentication rejection stops and closes the attempt immediately',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype); let joins=0,pauses=0;
        Object.assign(vfs,{origin:remote(),serverName:'test',retryConnection:0,runtimeInitialized:true,handlersRegistered:true,disposed:false});
        vfs.socket={needsReinit:false,pause:()=>{pauses++;},joinProject:async()=>{joins++;throw new Error('not authorized');}};
        await assert.rejects(()=>vfs.init(),/not authorized/); assert.strictEqual(joins,1); assert.strictEqual(pauses,1);
    });

    test('B08: explicit retry shares an initialization already in flight',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype); let joins=0,release!:(value:any)=>void;
        Object.assign(vfs,{origin:remote(),serverName:'test',retryConnection:0,runtimeInitialized:true,handlersRegistered:true,disposed:false});
        vfs.socket={needsReinit:false,pause:()=>{},joinProject:()=>{joins++;return new Promise(resolve=>{release=resolve;});},completeProjectRefresh:()=>{}};
        vfs.fetchProjectSettings=async()=>({});
        const initial=vfs.init(); await new Promise(resolve=>setTimeout(resolve,0));
        const retry=vfs.retryInitialization(); assert.strictEqual(joins,1); release({});
        await Promise.all([initial,retry]); assert.strictEqual(joins,1); assert.strictEqual(vfs.retryConnection,0);
    });

    test('B08: disposal cancels backoff and prevents another join',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype); let joins=0;
        Object.assign(vfs,{origin:remote(),serverName:'test',retryConnection:0,runtimeInitialized:true,handlersRegistered:true,disposed:false});
        vfs.socket={needsReinit:false,pause:()=>{},joinProject:async()=>{joins++;throw new Error('offline');}};
        const stopped=assert.rejects(()=>vfs.init(),/cancelled/);
        await new Promise(resolve=>setTimeout(resolve,10)); vfs.disposed=true; vfs.reconnectAbort.abort();
        await stopped; assert.strictEqual(joins,1);
    });

    test('B08: pausing tears down transport timers and released handlers do not return on retry',async()=>{
        const r=runtime(),{SocketIOAPI}=isolatedModule('api/socketio',r.common);
        const {EventEmitter}=require('events');
        const old=new EventEmitter(),next=new EventEmitter(); let stopped=0,updates=0;
        old.disconnect=()=>{stopped++;}; next.disconnect=()=>{};
        const socket:any=Object.create(SocketIOAPI.prototype);
        Object.assign(socket,{_disposed:false,_epoch:1,_state:'ready',_handlers:[],epochAbort:new AbortController(),scheme:'v1',_socketInitScheme:'v1',socket:old,api:{_initSocketV0:()=>next}});
        const release=socket.updateEventHandlers({onFileChanged:()=>{updates++;}});
        old.emit('otUpdateApplied',{}); assert.strictEqual(updates,1);
        release(); socket.pause(); assert.strictEqual(stopped,1); assert.strictEqual(socket.isReady,false); assert.strictEqual(socket.needsReinit,true);
        socket.init(); next.emit('otUpdateApplied',{}); assert.strictEqual(updates,1); assert.strictEqual(socket.handlers.length,0); socket.dispose();
    });


    function renameFixture(failRename=false) {
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype),calls:string[]=[],source:any={_id:'doc',name:'a.tex'};
        const folders:any={one:{_id:'one',name:'one',docs:[source],fileRefs:[],folders:[]},two:{_id:'two',name:'two',docs:[],fileRefs:[],folders:[]}};
        const server={parent:'one',name:'a.tex'};
        vfs._resolveUri=async(uri:Uri)=>{ const [,folder,name]=uri.path.slice(1).split('/'),parentFolder=folders[folder],entity=parentFolder.docs.find((item:any)=>item.name===name); return {parentFolder,fileName:name,fileType:entity?'doc':undefined,fileEntity:entity}; };
        vfs._resolveById=()=>({path:`/${server.parent}/${server.name}`,fileEntity:source}); vfs.notify=()=>{}; vfs.refreshProjectTree=async()=>{ for (const folder of Object.values(folders) as any[]) { folder.docs=folder.docs.filter((item:any)=>item._id!=='doc'); } source.name=server.name; folders[server.parent].docs.push(source); };
        vfs.api={moveEntity:async()=>{calls.push('move');server.parent='two';return {type:'success'};},renameEntity:async(_identity:any,_project:any,_type:any,_id:any,name:string)=>{calls.push('rename');if(failRename){return {type:'error',message:'rename denied'};}server.name=name;return {type:'success'};}};
        return {r,vfs,calls,server,folders};
    }
    test('B10: changing parent and name sends both operations and updates the cache after confirmation',async()=>{
        const {vfs,calls,server}=renameFixture(); await vfs.rename(remote('p','one/a.tex'),remote('p','two/b.tex'),false);
        assert.deepStrictEqual(calls,['move','rename']); assert.deepStrictEqual(server,{parent:'two',name:'b.tex'});
        assert.strictEqual((await vfs._resolveUri(remote('p','two/b.tex'))).fileEntity._id,'doc');
    });
    test('B10: partial rename failure reports the actual moved path and never invents the final name',async()=>{
        const {vfs,server}=renameFixture(true); await assert.rejects(()=>vfs.rename(remote('p','one/a.tex'),remote('p','two/b.tex'),false),/two\/a.tex/);
        assert.deepStrictEqual(server,{parent:'two',name:'a.tex'}); assert.strictEqual((await vfs._resolveUri(remote('p','two/b.tex'))).fileEntity,undefined);
    });

    test('B10: overwrite=false leaves an existing target and source untouched',async()=>{
        const {vfs,calls,folders,server}=renameFixture(); folders.two.docs.push({_id:'target',name:'b.tex'});
        await assert.rejects(()=>vfs.rename(remote('p','one/a.tex'),remote('p','two/b.tex'),false),(error:any)=>error.code==='FileExists');
        assert.deepStrictEqual(calls,[]); assert.deepStrictEqual(server,{parent:'one',name:'a.tex'}); assert.strictEqual(folders.two.docs[0]._id,'target');
    });
    test('B10: a move through an occupied intermediate name keeps both entity IDs',async()=>{
        const {vfs,calls,folders}=renameFixture(); folders.two.docs.push({_id:'occupied',name:'a.tex'});
        await vfs.rename(remote('p','one/a.tex'),remote('p','two/b.tex'),false);
        assert.deepStrictEqual(calls,['rename','move','rename']);
        assert.strictEqual((await vfs._resolveUri(remote('p','two/a.tex'))).fileEntity._id,'occupied');
        assert.strictEqual((await vfs._resolveUri(remote('p','two/b.tex'))).fileEntity._id,'doc');
    });
    test('B10: overwrite backs up the target before deletion and preserves it after partial failure',async()=>{
        const {vfs,calls,folders}=renameFixture(true),storage=await fs.mkdtemp(path.join(os.tmpdir(),'ol-rename-backup-'));
        try {
            const content=Buffer.from('target before overwrite'),hash=contentHash(content)!;
            folders.two.docs.push({_id:'target',name:'b.tex'}); vfs.context={globalStorageUri:Uri.file(storage)};
            vfs.readRemoteSnapshot=async()=>({entityId:'target',content,hash,revision:{kind:'document',documentVersion:1,contentHash:hash}});
            vfs.remove=async()=>{calls.push('delete');folders.two.docs=folders.two.docs.filter((item:any)=>item._id!=='target');};
            await assert.rejects(()=>vfs.rename(remote('p','one/a.tex'),remote('p','two/b.tex'),true),/backed up at/);
            assert.deepStrictEqual(calls,['delete','move','rename']);
            const backupDir=path.join(storage,'remote-replacement-backups'),entries=await fs.readdir(backupDir);
            assert.deepStrictEqual(await fs.readFile(path.join(backupDir,entries[0],'content')),content);
        } finally { await fs.rm(storage,{recursive:true,force:true}); }
    });
    test('B10: a lost move acknowledgement refreshes the tree to the real server path',async()=>{
        const {vfs,server}=renameFixture();
        vfs.api.moveEntity=async()=>{server.parent='two';return {type:'error',message:'acknowledgement lost'};};
        await assert.rejects(()=>vfs.rename(remote('p','one/a.tex'),remote('p','two/b.tex'),false),/two\/a.tex/);
        assert.strictEqual((await vfs._resolveUri(remote('p','two/a.tex'))).fileEntity._id,'doc');
        assert.strictEqual((await vfs._resolveUri(remote('p','two/b.tex'))).fileEntity,undefined);
    });

    test('local compile and PDF preview setting is live and overrides the legacy replica value',()=>{
        const r=runtime(); let explicit:boolean|undefined,value=false;
        r.vscode.workspace.getConfiguration=()=>({
            get:(_key:string,fallback:unknown)=>explicit===undefined?fallback:value,
            inspect:()=>({workspaceFolderValue:explicit}),
        });
        const context=isolatedModule('compile/projectContext',{...r.common,'../core/remoteFileSystemProvider':r.core});
        assert.deepStrictEqual(context.localCompilePreviewSetting(Uri.file('/replica'),true),{enabled:true,explicit:false});
        explicit=false; value=false;
        assert.deepStrictEqual(context.localCompilePreviewSetting(Uri.file('/replica'),true),{enabled:false,explicit:true});
        explicit=true; value=true;
        assert.deepStrictEqual(context.localCompilePreviewSetting(Uri.file('/replica'),false),{enabled:true,explicit:true});
    });

    async function compileFixture(timers:Record<string,unknown>={}) {
        const r=runtime(),root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-compile-context-'));
        for (const project of ['p','q']) {
            const dir=path.join(root,project); await fs.mkdir(path.join(dir,'.overleaf'),{recursive:true}); await fs.mkdir(path.join(dir,'chapters'));
            await fs.writeFile(path.join(dir,'.overleaf','settings.json'),JSON.stringify({uri:remote(project,'').toString(),enableCompileNPreview:true}));
            await fs.writeFile(path.join(dir,'chapters','main.tex'),'sample\n');
            r.vscode.workspace.workspaceFolders.push({uri:Uri.file(dir)});
        }
        const source=Uri.file(path.join(root,'p','chapters','main.tex'));
        r.vscode.window.activeTextEditor={document:{uri:source},selection:{start:{line:2,character:3}}};
        const context=isolatedModule('compile/projectContext',{...r.common,'../core/remoteFileSystemProvider':r.core});
        const prepared:Uri[][]=[];
        const compile=isolatedModule('compile/compileManager',{...r.common,'../core/remoteFileSystemProvider':r.core,'./projectContext':context,
            '../scm/localReplicaSCM':{LocalReplicaSCMProvider:{prepareForCompile:async(_root:Uri,uris:Uri[])=>{prepared.push(uris);return true;}}},
            './compileLogParser':{LatexParser:class {parse(){return {all:[{file:'./chapters/main.tex',line:1,level:'error',message:'test diagnostic'}]};}}}},timers);
        let compiles=0,refreshes=0; const forward:string[]=[],previewStates:{busy:boolean;message:string}[]=[];
        const vfs:any={logSyncStage:()=>{},waitForSavedText:async()=>{},getRootDocName:()=>'/main.tex',getCompiler:()=>({name:'pdfLaTeX'}),openFile:async()=>Buffer.from('sample\n'),pathToUri:(value:string)=>remote('p',value),
            compile:async()=>{compiles++;return true;},syncCode:async(file:string)=>{forward.push(file);return undefined;},syncPdf:async()=>({file:'chapters/main.tex',line:1,column:0})};
        const provider={prefetch:async()=>vfs}; const manager=new compile.CompileManager(provider); const disposables=manager.triggers;
        let closePreview=()=>{};
        r.eventBus.fire('pdfWillOpenEvent',{uri:remote('p','.output/output.pdf'),doc:{setCompileState:(busy:boolean,message:string)=>previewStates.push({busy,message}),refresh:async()=>{refreshes++;}},webviewPanel:{onDidDispose:(callback:()=>void)=>{closePreview=callback;return new Disposable();}}});
        return {...r,root,source,context,compile,manager,provider,vfs,forward,previewStates,prepared,closePreview:()=>closePreview(),compiles:()=>compiles,refreshes:()=>refreshes,close:async()=>{closePreview();disposables.forEach((item:Disposable)=>item.dispose());await fs.rm(root,{recursive:true,force:true});}};
    }

    test('compile from PDF includes the main source and every dirty file in its project',async()=>{
        const f=await compileFixture();
        try {
            const chapter=Uri.file(path.join(f.root,'p','chapters','main.tex'));
            f.vscode.workspace.textDocuments=[{uri:chapter,isDirty:true,save:async()=>true}];
            await f.manager.compile(true,remote('p','.output/output.pdf'));
            assert.strictEqual(f.compiles(),1);
            const prepared=f.prepared[0].map(uri=>path.relative(path.join(f.root,'p'),uri.fsPath));
            assert.deepStrictEqual(prepared,['main.tex','chapters/main.tex']);
        } finally { await f.close(); }
    });

    test('coalesced compile retains all saved paths without extending the running batch',async()=>{
        const f=await compileFixture(); let release!:()=>void,started!:()=>void,calls=0;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        const reached=new Promise<void>(resolve=>{started=resolve;});
        try {
            f.vfs.compile=async()=>{if (++calls===1) { started(); await gate; } return true;};
            const current=f.manager.compile(false,f.source); await reached;
            const a=Uri.file(path.join(f.root,'p','a.tex')),b=Uri.file(path.join(f.root,'p','b.tex'));
            await f.manager.compile(false,a); await f.manager.compile(false,b);
            assert.strictEqual(f.prepared.length,1);
            assert.deepStrictEqual(f.prepared[0].map(uri=>uri.fsPath),[f.source.fsPath]);
            release(); await current;
            assert.strictEqual(calls,2);
            assert.deepStrictEqual([...new Set(f.prepared[1].map(uri=>uri.fsPath))].sort(),[a.fsPath,b.fsPath].sort());
        } finally { release?.(); await f.close(); }
    });

    test('compile mode offers explicit choices, recompiles the captured project and supports cancellation',async()=>{
        const f=await compileFixture();
        try {
            f.vscode.QuickPickItemKind={Separator:-1};
            const builds:any[]=[];
            f.manager.compile=async(force:boolean,uri:Uri)=>{builds.push({force,uri,draft:f.manager.compileAsDraft});};
            for (const draft of [true,false,undefined]) {
                let calls=0;
                f.vscode.window.showQuickPick=async(items:any[])=>{
                    if (++calls===1) { return items.find(item=>item.label==='Compile Mode'); }
                    assert.deepStrictEqual(items.map(item=>item.draft),[false,true]);
                    return items.find(item=>item.draft===draft);
                };
                await f.manager.compileSettings();
                assert.strictEqual(calls,2);
            }
            assert.deepStrictEqual(builds.map(build=>build.draft),[true,false]);
            assert.ok(builds.every(build=>build.force && build.uri.toString().includes('project=p')));
        } finally { await f.close(); }
    });

    test('saving without a matching PDF preview skips compilation but manual compile works',async()=>{
        const f=await compileFixture();
        try {
            const other=Uri.file(path.join(f.root,'q','chapters','main.tex'));
            await f.fireSave({uri:other,fileName:other.fsPath});
            assert.strictEqual(f.compiles(),0);
            f.closePreview();
            await f.fireSave({uri:f.source,fileName:f.source.fsPath});
            assert.strictEqual(f.compiles(),0);
            await f.manager.compile(true,f.source);
            assert.strictEqual(f.compiles(),1);
        } finally { await f.close(); }
    });

    test('closing preview during preparation prevents the compile request',async()=>{
        const f=await compileFixture();
        try {
            f.vfs.openFile=async()=>{f.closePreview();return Buffer.from('sample');};
            await f.manager.compile(false,f.source);
            assert.strictEqual(f.compiles(),0);
        } finally { await f.close(); }
    });

    test('closing PDF preview discards queued automatic compilation',async()=>{
        const f=await compileFixture();
        try {
            let release!:()=>void,started!:()=>void,calls=0;
            const gate=new Promise<void>(resolve=>{release=resolve;});
            const running=new Promise<void>(resolve=>{started=resolve;});
            f.vfs.compile=async()=>{calls++;started();await gate;return true;};
            const first=f.manager.compile(false,f.source); await running;
            await f.manager.compile(false,f.source);
            f.closePreview();release();await first;
            assert.strictEqual(calls,1);
        } finally { await f.close(); }
    });

    test('PDF progress covers sync, compile and download and ends after success or failure',async()=>{
        const f=await compileFixture();
        try {
            await f.manager.compile();
            assert.deepStrictEqual(f.previewStates.slice(0,3).map(s=>s.message),['Syncing saved changes…','Compiling PDF…','Downloading PDF…']);
            assert.strictEqual(f.previewStates[f.previewStates.length-1].busy,false);
            f.vfs.compile=async()=>{throw new Error('offline');};
            await f.manager.compile();
            assert.strictEqual(f.previewStates[f.previewStates.length-1].busy,false);
            assert.match(f.previewStates[f.previewStates.length-1].message,/failed/);
        } finally { await f.close(); }
    });

    test('Explorer progress groups concurrent tasks and clears on completion and disposal',async()=>{
        let bars=0,ended=0,labels=0;
        const {SyncProgress}=isolatedModule('scm/syncProgress',{vscode:{window:{
            withProgress:(options:any,task:any)=>{assert.strictEqual(options.location.viewId,'workbench.explorer.fileView');bars++;return task().then(()=>{ended++;});},
            setStatusBarMessage:()=>{labels++;return new Disposable(()=>{labels--;});},
        }}});
        const progress=new SyncProgress('paper');
        progress.activity('a.tex',true); progress.activity('b.tex',true);
        assert.strictEqual(bars,1); assert.strictEqual(labels,1);
        progress.activity('a.tex',false); await Promise.resolve(); assert.strictEqual(ended,0);
        progress.activity('b.tex',false); await Promise.resolve(); assert.strictEqual(ended,1); assert.strictEqual(labels,0);
        progress.activity('c.tex',true); progress.dispose(); await Promise.resolve();
        assert.strictEqual(ended,2); assert.strictEqual(labels,0);
    });

    test('failed PDF download retains the previous document cache',async()=>{
        const r=runtime(); r.vscode.workspace.fs.readFile=async()=>{throw new Error('download failed');};
        const {PdfDocument}=isolatedModule('core/pdfViewEditorProvider',{...r.common,'../utils/globalStateManager':{}});
        const doc=new PdfDocument(remote('p','.output/output.pdf'));
        doc.cache=Buffer.from('previous PDF');
        await assert.rejects(()=>doc.refresh(),/download failed/);
        assert.strictEqual(Buffer.from(doc.cache).toString(),'previous PDF');
        doc.dispose();
    });

    test('B07: compile errors release the guard and the next request can compile',async()=>{
        const f=await compileFixture();
        try {
            const prefetch=f.provider.prefetch; f.provider.prefetch=async()=>{throw new Error('offline');};
            await f.manager.compile(); assert.strictEqual(f.manager.inCompiling,false); assert.strictEqual(f.compiles(),0);
            f.provider.prefetch=prefetch; await f.manager.compile(); assert.strictEqual(f.compiles(),1); assert.strictEqual(f.manager.inCompiling,false);
        } finally { await f.close(); }
    });
    test('failed outputs publish logs without clearing cache and the next build recovers non-incrementally',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype),calls:any[]=[],outputs:any[]=[];
        let status='failure';
        Object.assign(vfs,{root:{rootDoc_id:null},isDirty:true,
            resolve:async()=>{throw new Error('Missing local output index');},
            updateOutputs:async(value:any)=>outputs.push(value),
            api:{compile:async(...args:any[])=>{
                calls.push(args);return {type:'success',compile:{status,outputFiles:[{path:'output.log',url:'new-log'}]}};
            }}});
        assert.strictEqual(await vfs.compile(true),false);
        assert.strictEqual(vfs.lastCompileHasLog,true);
        assert.strictEqual(vfs.lastCompileStatus,'failure');
        assert.strictEqual(outputs.length,1);
        status='success';
        await vfs.compile(true); await vfs.compile(true);
        assert.deepStrictEqual(calls.map(args=>args[5]),[false,false,false]);
        assert.deepStrictEqual(calls.map(args=>args[6]),[true,false,true]);
    });

    test('failed compilation still parses its fresh log while preserving the PDF',async()=>{
        const f=await compileFixture();
        try {
            f.vfs.compile=async()=>false; f.vfs.lastCompileHasLog=true; f.vfs.lastCompileStatus='stopped-on-first-error';
            let diagnosed=0;
            f.commands.set('overleaf-workshop.compileManager.compileErrorCheck',async()=>{diagnosed++;return true;});
            await f.manager.compile(true,f.source);
            assert.strictEqual(diagnosed,1); assert.strictEqual(f.refreshes(),0);
            assert.match(f.previewStates.at(-1)!.message,/stopped at the first error/);
        } finally { await f.close(); }
    });

    test('SyncTeX converts the editor row to a one-based line exactly once',async()=>{
        const f=await compileFixture();
        try {
            let line=-1;
            f.vfs.syncCode=async(_file:string,row:number)=>{line=row;};
            await f.manager.syncCode(); assert.strictEqual(line,3);
        } finally { await f.close(); }
    });

    test('a PDF download failure still publishes diagnostics from the current build',async()=>{
        const f=await compileFixture();
        try {
            let diagnosed=0;
            f.vfs.lastCompileHasLog=true;
            f.eventBus.fire('pdfWillOpenEvent',{uri:remote('p','.output/output.pdf'),
                doc:{setCompileState:()=>{},refresh:async()=>{throw new Error('PDF download failed');}},
                webviewPanel:{onDidDispose:()=>new Disposable()}});
            f.commands.set('overleaf-workshop.compileManager.compileErrorCheck',async()=>{diagnosed++;return true;});
            await f.manager.compile(true,f.source);
            assert.strictEqual(diagnosed,1);
            assert.strictEqual(f.manager.inCompiling,false);
        } finally { await f.close(); }
    });

    test('an unknown compile outcome drops queued work instead of submitting it again',async()=>{
        const f=await compileFixture();
        try {
            let release!:()=>void,started!:()=>void,builds=0;
            const began=new Promise<void>(resolve=>{started=resolve;});
            f.vfs.compile=async()=>{builds++;started();await new Promise<void>(resolve=>{release=resolve;});throw new NetworkRequestError('unknown-outcome','Request timed out');};
            const first=f.manager.compile(false,f.source); await began;
            await f.manager.compile(false,f.source); release(); await first;
            assert.strictEqual(builds,1);
            assert.match(f.previewStates.at(-1)!.message,/result unknown/);
        } finally { await f.close(); }
    });

    test('B07: a failed VFS compile remains eligible for the next non-forced request',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype); let builds=0;
        Object.assign(vfs,{root:{rootDoc_id:null},isDirty:true,resolve:async()=>({}),pathToUri:()=>remote(),updateOutputs:async()=>{},api:{compile:async()=>{builds++;if(builds===1){throw new Error('network failed');}return {type:'success',compile:{status:'success',outputFiles:[]}};}}});
        await assert.rejects(()=>vfs.compile(),/network failed/); assert.strictEqual(vfs.isDirty,true);
        assert.strictEqual(await vfs.compile(),true); assert.strictEqual(builds,2);
    });
    test('B07: a verified local document upload marks the project dirty only when content changed',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype),uri=remote();
        let content=Buffer.from('before'),version=1;
        const snapshot=()=>{ const hash=contentHash(content)!; return {entityId:'doc',kind:'text',content,hash,revision:{kind:'document',documentVersion:version,contentHash:hash},connectionEpoch:1}; };
        Object.assign(vfs,{isDirty:false,snapshotReads:new Map(),socket:{connectionEpoch:1,isReady:true,leaveDoc:async()=>{}},
            confirmedTextSnapshot:async()=>snapshot(),textSession:async()=>({get confirmed(){return content.toString();},save:async(next:string)=>{if(next!==content.toString()){content=Buffer.from(next);version++;}}})});
        const before=snapshot();
        assert.strictEqual((await vfs.applyDocumentSnapshot(uri,before.revision,Buffer.from('after'))).type,'verified');
        assert.strictEqual(vfs.isDirty,true);
        vfs.isDirty=false;
        const unchanged=snapshot();
        assert.strictEqual((await vfs.applyDocumentSnapshot(uri,unchanged.revision,Buffer.from('after'))).type,'verified');
        assert.strictEqual(vfs.isDirty,false);
    });
    test('B07: a verified local binary replacement marks the project dirty only when content changed',async()=>{
        const r=runtime(),vfs:any=Object.create(r.core.VirtualFileSystem.prototype),uri=remote('p','figure.png');
        const files=new Map<string,{entityId:string;content:Buffer}>(); files.set(uri.path,{entityId:'old',content:Buffer.from('before')});
        const snapshot=(target:Uri)=>{ const file=files.get(target.path); if (!file) { return; } const hash=contentHash(file.content)!; return {path:target.path,entityId:file.entityId,kind:'binary',content:file.content,hash,revision:{kind:'file',entityId:file.entityId,contentHash:hash},connectionEpoch:1}; };
        Object.assign(vfs,{isDirty:false,socket:{connectionEpoch:1},readRemoteSnapshot:async(target:Uri)=>snapshot(target),
            createUploadedFile:async(target:Uri,content:Uint8Array)=>{ files.set(target.path,{entityId:'staged',content:Buffer.from(content)}); },
            remove:async(target:Uri)=>{ files.delete(target.path); },rename:async(from:Uri,to:Uri)=>{ const file=files.get(from.path)!; files.delete(from.path); files.set(to.path,file); }});
        const before=snapshot(uri)!;
        assert.strictEqual((await vfs.applyFileSnapshot(uri,before.revision,Buffer.from('after'),'op')).type,'verified');
        assert.strictEqual(vfs.isDirty,true);
        vfs.isDirty=false;
        const unchanged=snapshot(uri)!;
        assert.strictEqual((await vfs.applyFileSnapshot(uri,unchanged.revision,Buffer.from('after'),'same')).type,'verified');
        assert.strictEqual(vfs.isDirty,false);
    });
    test('server autocompile backoff persists across saves until a successful manual build',async()=>{
        const f=await compileFixture();
        try {
            let calls=0,backoff=true;
            f.vfs.compile=async()=>{ calls++; f.vfs.lastCompileStatus=backoff?'autocompile-backoff':'success'; return !backoff; };
            await f.manager.compile(false,f.source);
            await f.manager.compile(false,f.source); await f.manager.compile(false,f.source);
            assert.strictEqual(calls,1);
            backoff=false;await f.manager.compile(true,f.source);await f.manager.compile(false,f.source);
            assert.strictEqual(calls,3);
        } finally { await f.close(); }
    });

    test('B07: save cancellation releases the compile guard',async()=>{
        const f=await compileFixture();
        try {
            f.vscode.workspace.textDocuments=[{uri:f.source,isDirty:true,save:async()=>false}]; await f.manager.compile(); assert.strictEqual(f.compiles(),0); assert.strictEqual(f.manager.inCompiling,false);
            f.vscode.workspace.textDocuments[0].save=async()=>true; await f.manager.compile(); assert.strictEqual(f.compiles(),1);
        } finally { await f.close(); }
    });
    test('compile waits for applied OT and never saves an unrelated project',async()=>{
        const f=await compileFixture(); let release!:()=>void,waiting!:()=>void,saved=0,unrelated=0;
        const reached=new Promise<void>(resolve=>{waiting=resolve;});
        try {
            f.vscode.workspace.textDocuments=[{uri:f.source,isDirty:true,save:async()=>{saved++;return true;}},
                {uri:Uri.file(f.source.fsPath.replace('/p/','/q/')),isDirty:true,save:async()=>{unrelated++;return false;}}];
            f.vfs.waitForSavedText=async(uris:Uri[])=>{assert.ok(uris.length);assert.ok(uris.every(uri=>uri.toString().includes('project=p')));waiting();await new Promise<void>(resolve=>{release=resolve;});};
            const compiling=f.manager.compile(); await reached;
            assert.strictEqual(saved,1); assert.strictEqual(unrelated,0); assert.strictEqual(f.compiles(),0);
            release(); await compiling; assert.strictEqual(f.compiles(),1);
        } finally { release?.(); await f.close(); }
    });
    test('failed synchronization preserves the PDF and never sends compile',async()=>{
        const f=await compileFixture();
        try {
            f.vfs.waitForSavedText=async()=>{throw new Error('application confirmation unknown');};
            await f.manager.compile();
            assert.strictEqual(f.compiles(),0); assert.strictEqual(f.refreshes(),0);
            assert.ok(f.previewStates.at(-1)?.message.includes('keeping the previous PDF'));
        } finally { await f.close(); }
    });

    test('B07: auto-save compiles immediately and refreshes the PDF before diagnostics',async()=>{
        const f=await compileFixture();
        try {
            const document={uri:f.source,fileName:f.source.fsPath};
            const diagnostic=f.commands.get('overleaf-workshop.compileManager.compileErrorCheck')!;
            f.commands.set('overleaf-workshop.compileManager.compileErrorCheck',async(...args:any[])=>{ assert.strictEqual(f.refreshes(),1); return diagnostic(...args); });
            await f.fireSave(document);
            assert.strictEqual(f.compiles(),1); assert.strictEqual(f.refreshes(),1);
        } finally { await f.close(); }
    });
    test('B07: a save during compilation queues one follow-up and manual force wins',async()=>{
        const f=await compileFixture();
        try {
            let release!:()=>void,started!:()=>void; const began=new Promise<void>(resolve=>{started=resolve;}),forces:boolean[]=[];
            f.vfs.compile=async(force:boolean)=>{ forces.push(force); if (forces.length===1) { started(); await new Promise<void>(resolve=>{release=resolve;}); } return true; };
            const first=f.manager.compile(false,f.source); await began;
            await f.manager.compile(false,f.source); await f.manager.compile(true,f.source); await f.manager.compile(false,f.source);
            release(); await first;
            assert.deepStrictEqual(forces,[false,true]); assert.strictEqual(f.refreshes(),2);
        } finally { await f.close(); }
    });
    test('B07: stopping compilation clears the queued follow-up',async()=>{
        const f=await compileFixture();
        try {
            let release!:()=>void,started!:()=>void; const began=new Promise<void>(resolve=>{started=resolve;});
            f.vfs.compile=async()=>{ started(); await new Promise<void>(resolve=>{release=resolve;}); return true; };
            f.vfs.stopCompile=async()=>{ release(); };
            const first=f.manager.compile(false,f.source); await began; await f.manager.compile(false,f.source); await f.manager.stopCompile(); await first;
            assert.strictEqual(f.refreshes(),0); assert.strictEqual(f.manager.inCompiling,false);
        } finally { await f.close(); }
    });
    test('B12: local forward sync, PDF-owned reverse sync and diagnostics use the correct local project',async()=>{
        const f=await compileFixture();
        try {
            const checked=await f.compile.CompileManager.check(f.source); assert.strictEqual(checked.path,'/Projectp/chapters/main.tex');
            await f.manager.syncCode(); assert.deepStrictEqual(f.forward,['chapters/main.tex']);
            f.vscode.window.activeTextEditor.document.uri=Uri.file(path.join(f.root,'q','chapters','main.tex'));
            await f.manager.syncPdf({page:1,h:0,v:0,identifier:'',pdfUri:remote('p','.output/output.pdf').toString()});
            assert.strictEqual(f.opened[0].fsPath,f.source.fsPath);
            await f.commands.get('overleaf-workshop.compileManager.compileErrorCheck')!(await f.context.resolveProjectContext(f.source));
            assert.ok(f.diagnostics.has(f.source.toString()));
            assert.ok([...f.diagnostics.keys()].every(uri=>uri.startsWith('file:')));
            assert.strictEqual(await f.context.resolveProjectContext(Uri.file(path.join(f.root,'p','.overleaf','sync','merge','result.tex'))),undefined);
        } finally { await f.close(); }
    });
});
