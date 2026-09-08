/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { isolatedModule } from '../helpers/isolatedModule';
import { ProjectMetadataCache } from '../../core/projectMetadataCache';

function clock() {
    let now=0,id=0;
    const jobs=new Map<number,{at:number;run:()=>void}>();
    const timers={setTimeout:(run:()=>void,ms:number)=>{ jobs.set(++id,{at:now+ms,run}); return id; },clearTimeout:(key:number)=>jobs.delete(key)};
    const debounce=isolatedModule('utils/debouncedTasks',{},timers);
    return {timers,debounce,async tick(ms:number) {
        const end=now+ms;
        while (true) {
            const next=[...jobs].sort((a,b)=>a[1].at-b[1].at).find(([,job])=>job.at<=end);
            if (!next) { break; }
            now=next[1].at; jobs.delete(next[0]); next[1].run();
            for (let i=0;i<20;i++) { await Promise.resolve(); }
        }
        now=end;
    }};
}

suite('official request scheduling',()=>{
    test('typing waits one second and checks the final text, closing cancels pending work',async()=>{
        const time=clock(),sent:string[][]=[];
        const {MisspellingCheckProvider}=isolatedModule('intellisense/langMisspellingCheckProvider',{
            vscode:{languages:{createDiagnosticCollection:()=>({})}},'.':{IntellisenseProvider:class {}},
            '../utils/eventBus':{},'../utils/debouncedTasks':time.debounce,'../consts':{ROOT_NAME:'overleaf-workshop'},
        });
        const provider=new MisspellingCheckProvider();
        provider.vfsm={prefetch:async()=>({getDictionary:()=>[],spellCheck:async(_uri:unknown,words:string[])=>{sent.push(words);return [];}})};
        provider.updateDiagnostics=async()=>{};
        let text='he';
        const doc={uri:{toString:()=> 'project/main.tex'},version:1,isClosed:false,getText:()=>text};
        provider.scheduleCheck(doc); await time.tick(900);
        text='hello';doc.version++;provider.scheduleCheck(doc);await time.tick(999);
        assert.strictEqual(sent.length,0);
        await time.tick(1);assert.deepStrictEqual(sent,[['hello']]);
        provider.scheduleCheck(doc);await time.tick(1000);assert.strictEqual(sent.length,1,'successful words use cache');
        text='another';doc.version++;provider.scheduleCheck(doc);doc.isClosed=true;await time.tick(1000);
        assert.strictEqual(sent.length,1);
    });

    test('queued spelling work skips a document version superseded while another request ran',async()=>{
        const time=clock(),sent:string[][]=[];
        const {MisspellingCheckProvider}=isolatedModule('intellisense/langMisspellingCheckProvider',{
            vscode:{languages:{createDiagnosticCollection:()=>({})}},'.':{IntellisenseProvider:class {}},
            '../utils/eventBus':{},'../utils/debouncedTasks':time.debounce,'../consts':{ROOT_NAME:'overleaf-workshop'},
        });
        const provider=new MisspellingCheckProvider();
        provider.vfsm={prefetch:async()=>({getDictionary:()=>[],spellCheck:async(_uri:unknown,words:string[])=>{sent.push(words);return [];}})};
        provider.updateDiagnostics=async()=>{};
        let release!:()=>void,text='oldword';provider.checkQueue=new Promise<void>(resolve=>{release=resolve;});
        const doc={uri:{toString:()=> 'p/doc'},version:1,isClosed:false,getText:()=>text};
        provider.scheduleCheck(doc);await time.tick(1000);
        text='newword';doc.version++;provider.scheduleCheck(doc);release();
        await time.tick(1000);await provider.checkQueue;
        assert.deepStrictEqual(sent,[['newword']]);
    });

    test('cursor messages use 500 ms with peers, 5 minutes alone, and never send after disconnect',async()=>{
        const time=clock(),sent:unknown[][]=[];
        const {ClientManager}=isolatedModule('collaboration/clientManager',{
            vscode:{},'./chatViewProvider':{},'../scm/localReplicaSCM':{},'../utils/debouncedTasks':time.debounce,'../consts':{ROOT_NAME:'overleaf-workshop'},
        });
        const client=Object.create(ClientManager.prototype);
        Object.assign(client,{cursorTasks:new time.debounce.DebouncedTasks(),cursorDelay:500,onlineUsers:{peer:{}},publicId:'self',connectedFlag:true,
            socket:{isReady:true,updatePosition:async(...args:unknown[])=>{sent.push(args);}}});
        client.latestCursor={docId:'d',row:1,column:1};client.scheduleCursor();await time.tick(400);
        client.latestCursor={docId:'d',row:2,column:3};client.scheduleCursor();await time.tick(499);
        assert.strictEqual(sent.length,0);await time.tick(1);assert.deepStrictEqual(sent,[['d',2,3]]);
        delete client.onlineUsers.peer;client.updateCursorDelay();await time.tick(299999);assert.strictEqual(sent.length,1);
        await time.tick(1);assert.strictEqual(sent.length,2);
        client.onlineUsers.peer={};client.updateCursorDelay();client.connectedFlag=false;await time.tick(500);
        assert.strictEqual(sent.length,2);
        client.connectedFlag=true;client.scheduleCursor();client.cursorTasks.dispose();await time.tick(500);
        assert.strictEqual(sent.length,2);
    });

    test('forced disconnect stops transport and blocks automatic reinitialization until manual retry',async()=>{
        const time=clock();
        const {SocketIOAPI}=isolatedModule('api/socketio',{'../consts':{}},time.timers);
        const {EventEmitter}=require('events');let connects=0,disconnects=0,notified=0;
        const transport=new EventEmitter();transport.disconnect=()=>{disconnects++;};
        const socket=Object.create(SocketIOAPI.prototype);
        Object.assign(socket,{_disposed:false,_epoch:0,_handlers:[{onDisconnected:()=>{notified++;}}],epochAbort:new AbortController(),scheme:'v1',
            api:{_initSocketV0:()=>{connects++;return transport;}}});
        socket.init();transport.emit('forceDisconnect','maintenance',2);
        assert.strictEqual(socket.isForcedDisconnected,true);
        assert.throws(()=>socket.init(),/manual reconnect/);assert.strictEqual(connects,1);
        await time.tick(1999);assert.strictEqual(disconnects,0);
        await time.tick(1);assert.strictEqual(disconnects,1);assert.strictEqual(notified,1);
        socket.allowManualReconnect();socket.init();assert.strictEqual(connects,2);socket.dispose();
    });

    test('document metadata refresh coalesces saved changes for two seconds and updates the read cache',async()=>{
        const time=clock(),calls:string[]=[];
        const {VirtualFileSystem}=isolatedModule('core/remoteFileSystemProvider',{
            vscode:{Disposable:class {}},'../consts':{},'../collaboration/clientManager':{},'../scm/scmCollectionProvider':{},
            '../api/extendedBase':{},'../utils/eventBus':{},'../utils/debouncedTasks':time.debounce,
            '../utils/globalStateManager':{GlobalStateManager:{authenticate:async()=>({})}},
        });
        const vfs=Object.create(VirtualFileSystem.prototype);
        Object.assign(vfs,{root:{},metadataRunning:new Set(),socket:{connectionEpoch:1,isReady:true},_resolveById:()=>({}),
            api:{getMetadata:async()=>({type:'success',meta:{projectMeta:{d:{labels:['old'],packages:{}}}}}),
                refreshDocMetadata:async(_identity:unknown,_project:string,id:string,broadcast:boolean)=>{
                    calls.push(id);assert.strictEqual(broadcast,false);
                    return {type:'success',meta:{projectMeta:{d:{labels:['new'],packages:{}}}}};
                }}});
        await vfs.metadata();vfs.scheduleMetadataRefresh('d');await time.tick(1900);
        vfs.scheduleMetadataRefresh('d');await time.tick(1999);assert.strictEqual(calls.length,0);
        await time.tick(1);assert.deepStrictEqual(calls,['d']);assert.deepStrictEqual((await vfs.metadata()).d.labels,['new']);
        vfs.scheduleMetadataRefresh('d');vfs.metadataTasks.dispose();await time.tick(2000);assert.strictEqual(calls.length,1);
    });

    test('metadata coalesces reads and preserves broadcasts and deletes arriving during a read',async()=>{
        const cache=new ProjectMetadataCache();let count=0,release!:(value:any)=>void;
        const load=()=>{count++;return new Promise<any>(resolve=>{release=resolve;});};
        const first=cache.get(load),second=cache.get(load);
        cache.update({docId:'a',meta:{labels:['new'],packages:{}}});cache.remove('b');
        release({a:{labels:['old'],packages:{}},b:{labels:['deleted'],packages:{}}});
        const expected={a:{labels:['new'],packages:{}}};
        assert.deepStrictEqual(await first,expected);assert.deepStrictEqual(await second,expected);
        assert.deepStrictEqual(await cache.get(load),expected);assert.strictEqual(count,1);
        cache.reset();const obsolete=cache.get(load);cache.reset();release({a:{labels:['stale'],packages:{}}});
        assert.strictEqual(await obsolete,undefined);
        assert.strictEqual(await cache.get(async()=>undefined),undefined);
        assert.deepStrictEqual(await cache.get(async()=>expected),expected,'failed reads must not poison cache');
    });
});
