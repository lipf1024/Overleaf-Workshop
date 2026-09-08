import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fork } from 'child_process';
import { once } from 'events';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';
import { SyncCoordinator, SyncAdapter } from '../../scm/localReplicaSync/coordinator';
import { PathPolicy } from '../../scm/localReplicaSync/pathPolicy';
import { contentHash } from '../../scm/localReplicaSync/hash';
import { DraftQueue } from '../../scm/localReplicaSync/draftQueue';
import { JournalEntry, RemoteSnapshot } from '../../scm/localReplicaSync/model';
import { isolatedModule } from '../helpers/isolatedModule';

suite('0.16.7 replica regressions',()=>{
    let root:string,store:SyncStateStore;
    const project={projectId:'p',serverIdentityHash:'s'};
    setup(async()=>{ root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-robustness-')); store=new SyncStateStore(root,project); await store.initialize(); });
    teardown(async()=>{ await store.close(); await fs.rm(root,{recursive:true,force:true}); });
    const file=()=>path.join(root,'main.tex');
    const inject=(stage:'prepared'|'captured',action:(entry:JournalEntry)=>Promise<void>)=>{
        const put=store.putJournal.bind(store); let done=false;
        store.putJournal=async entry=>{ await put(entry); if (!done && entry.localStage===stage) { done=true; await action(entry); } };
    };

    test('B02: excludes every descendant of a symlink and never reads or overwrites its target',async()=>{
        const outside=await fs.mkdtemp(path.join(os.tmpdir(),'ol-outside-'));
        try {
            await fs.writeFile(path.join(outside,'main.tex'),'outside');
            await fs.symlink(outside,path.join(root,'linked'),'dir');
            const policy=new PathPolicy(store.access,()=>[]);
            assert.strictEqual((await policy.check('linked/main.tex')).type,'blocked');
            await assert.rejects(()=>store.access.read('linked/main.tex'));
            await assert.rejects(()=>store.atomicLocalWrite('linked/main.tex',Buffer.from('remote'),'download'));
            assert.strictEqual(await fs.readFile(path.join(outside,'main.tex'),'utf8'),'outside');
        } finally { await fs.rm(outside,{recursive:true,force:true}); }
    });

    test('B02: metadata symlinks cannot redirect initialization or cleanup',async()=>{
        await store.close();
        const other=await fs.mkdtemp(path.join(os.tmpdir(),'ol-metadata-outside-'));
        const fresh=await fs.mkdtemp(path.join(os.tmpdir(),'ol-linked-metadata-'));
        const linked=new SyncStateStore(fresh,project);
        try {
            await fs.writeFile(path.join(other,'sentinel'),'keep'); await fs.symlink(other,path.join(fresh,'.overleaf'),'dir');
            await assert.rejects(()=>linked.initialize(),/parent|Symbolic/);
            assert.deepStrictEqual(await fs.readdir(other),['sentinel']);
        } finally { await linked.close(); await fs.rm(fresh,{recursive:true,force:true}); await fs.rm(other,{recursive:true,force:true}); }
    });

    test('B02: a parent replaced after preparation stops the mutation',async()=>{
        await fs.mkdir(path.join(root,'chapter')); await fs.writeFile(path.join(root,'chapter','main.tex'),'base');
        const outside=await fs.mkdtemp(path.join(os.tmpdir(),'ol-parent-outside-'));
        try {
            await fs.writeFile(path.join(outside,'main.tex'),'outside');
            inject('prepared',async()=>{ await fs.rename(path.join(root,'chapter'),path.join(root,'saved-chapter')); await fs.symlink(outside,path.join(root,'chapter'),'dir'); });
            await assert.rejects(()=>store.atomicLocalWrite('chapter/main.tex',Buffer.from('remote'),'download',undefined,contentHash(Buffer.from('base')),true));
            assert.strictEqual(await fs.readFile(path.join(outside,'main.tex'),'utf8'),'outside');
            assert.strictEqual(await fs.readFile(path.join(root,'saved-chapter','main.tex'),'utf8'),'base');
        } finally { await fs.rm(outside,{recursive:true,force:true}); }
    });

    test('B03: preserves an external save between the prepared journal and replacement',async()=>{
        await fs.writeFile(file(),'base'); inject('prepared',async()=>{ await fs.writeFile(file(),'external edit'); });
        await assert.rejects(()=>store.atomicLocalWrite('main.tex',Buffer.from('remote'),'download',undefined,contentHash(Buffer.from('base')),true),/changed/);
        assert.strictEqual(await fs.readFile(file(),'utf8'),'external edit');
        const entry=(await store.listJournal())[0];
        assert.strictEqual(Buffer.from((await store.access.read(entry.localRecoveryPath!,true))!).toString(),'external edit');
        await store.recoverLocalOperations();
        assert.strictEqual((await store.listJournal()).length,0);
    });

    test('B03: preserves writes through a file descriptor opened before capture',async()=>{
        await fs.writeFile(file(),'base'); const handle=await fs.open(file(),'r+');
        try {
            inject('captured',async()=>{ await handle.truncate(0); await handle.write(Buffer.from('late descriptor edit'),0,20,0); await handle.sync(); });
            await assert.rejects(()=>store.atomicLocalWrite('main.tex',Buffer.from('remote'),'download',undefined,contentHash(Buffer.from('base')),true));
            assert.strictEqual(await fs.readFile(file(),'utf8'),'late descriptor edit');
        } finally { await handle.close(); }
    });

    test('B03: a recreated target is not clobbered during a move',async()=>{
        await fs.writeFile(file(),'base');
        inject('captured',async()=>{ await fs.writeFile(path.join(root,'new.tex'),'new target'); });
        await assert.rejects(()=>store.atomicLocalMove('main.tex','new.tex'));
        assert.strictEqual(await fs.readFile(file(),'utf8'),'base');
        assert.strictEqual(await fs.readFile(path.join(root,'new.tex'),'utf8'),'new target');
    });

    test('B03: a concurrent edit also survives remote deletion',async()=>{
        await fs.writeFile(file(),'base'); inject('prepared',async()=>{ await fs.writeFile(file(),'external edit'); });
        await assert.rejects(()=>store.atomicLocalDelete('main.tex',undefined,contentHash(Buffer.from('base'))));
        assert.strictEqual(await fs.readFile(file(),'utf8'),'external edit');
    });

    test('B03: restart recovers a capture whose phase update never reached the journal',async()=>{
        await fs.writeFile(file(),'base');
        const id='11111111-1111-4111-8111-111111111111',directory=`.overleaf-sync-${id}`;
        await fs.mkdir(path.join(root,directory)); await fs.writeFile(path.join(root,directory,'result'),'remote');
        await store.putJournal({id,path:'main.tex',operation:'download',phase:'prepared',localStage:'prepared',localRecoveryPath:`${directory}/original`,localStagingPath:`${directory}/result`,localExpectedHash:contentHash(Buffer.from('base')),localExpectedExists:true,targetHash:contentHash(Buffer.from('remote')),createdAt:Date.now()});
        await fs.rename(file(),path.join(root,directory,'original'));
        await store.close(); store=new SyncStateStore(root,project); await store.loadState();
        await store.recoverLocalOperations();
        assert.strictEqual(await fs.readFile(file(),'utf8'),'base');
        assert.strictEqual((await store.listJournal()).length,0);
        assert.ok((await fs.readdir(path.join(root,'.overleaf','sync','backups'))).some(name=>name.endsWith('.json')));
    });

    test('B03: unsupported installation is detected before the original file is captured',async()=>{
        await fs.writeFile(file(),'base');
        (store as any).verifyInstallCapability=async()=>{ throw new Error('Hard links unavailable'); };
        await assert.rejects(()=>store.atomicLocalWrite('main.tex',Buffer.from('remote'),'download'),/Hard links/);
        assert.strictEqual(await fs.readFile(file(),'utf8'),'base'); assert.strictEqual((await store.listJournal()).length,0);
    });
    test('B03: a recreated same-path target and its captured original survive recovery',async()=>{
        await fs.writeFile(file(),'base'); inject('captured',async()=>{await fs.writeFile(file(),'recreated');});
        await assert.rejects(()=>store.atomicLocalWrite('main.tex',Buffer.from('remote'),'download'));
        const blocked=await store.recoverLocalOperations(); assert.ok(blocked.has('main.tex'));
        assert.strictEqual(await fs.readFile(file(),'utf8'),'recreated');
        const review=(await store.listLocalRecoveryReviews())[0];
        await fs.writeFile(file(),'newer recreated');
        await assert.rejects(()=>store.acknowledgeLocalRecovery(review),/changed since review/);
        assert.strictEqual((await store.listJournal()).length,1);
        await store.acknowledgeLocalRecovery((await store.listLocalRecoveryReviews())[0]);
        assert.strictEqual((await store.listJournal()).length,0); assert.strictEqual(await fs.readFile(file(),'utf8'),'newer recreated');
        assert.strictEqual(Buffer.from((await store.access.read(review.entry.localRecoveryPath!,true))!).toString(),'base');
    });
    for (const stage of ['prepared','captured','installed']) {
        test(`B03/B04: takeover recovers a process killed at journal stage ${stage}`,async function(){
            this.timeout(10000); await store.close();
            const child=fork(path.resolve(__dirname,'../helpers/replicaLockChild.js'),[root,stage],{stdio:['ignore','ignore','pipe','ipc']});
            let error=''; child.stderr?.on('data',chunk=>{error+=chunk;});
            try {
                const [message]=await once(child,'message'); assert.strictEqual(message,stage,error);
                const exited=once(child,'exit'); child.kill('SIGKILL'); await exited;
                store=new SyncStateStore(root,project); await store.loadState(); assert.strictEqual(store.isOwner,true);
                assert.strictEqual((await store.recoverLocalOperations()).size,0);
                assert.strictEqual(await fs.readFile(file(),'utf8'),stage==='installed'?'installed':'base');
                if (stage==='installed') {
                    const entry=(await store.listJournal())[0]; assert.strictEqual(entry.localStage,'installed');
                    assert.strictEqual(Buffer.from((await store.access.read(entry.localRecoveryPath!,true))!).toString(),'base');
                } else { assert.strictEqual((await store.listJournal()).length,0); }
            } finally { if (child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); } }
        });
    }

    test('B04: a second store observes state and cannot append or overwrite it',async()=>{
        await store.beginJournal({path:'a.tex',operation:'upload'});
        const observer=new SyncStateStore(root,project);
        try {
            await observer.loadState(); assert.strictEqual(observer.isOwner,false);
            await assert.rejects(()=>observer.beginJournal({path:'b.tex',operation:'upload'}),/another|Another/);
            assert.deepStrictEqual((await store.listJournal()).map(entry=>entry.path),['a.tex']);
            await store.close(); assert.strictEqual(await observer.tryTakeOwnership(),true);
            await observer.beginJournal({path:'b.tex',operation:'upload'});
            assert.strictEqual((await observer.listJournal()).length,2);
        } finally { await observer.close(); }
    });

    test('B04: the operating system releases ownership after a separate process crashes',async function(){
        this.timeout(10000); await store.close();
        const child=fork(path.resolve(__dirname,'../helpers/replicaLockChild.js'),[root],{stdio:['ignore','ignore','pipe','ipc']});
        let error=''; child.stderr?.on('data',chunk=>{ error+=chunk; });
        try {
            const [message]=await once(child,'message'); assert.strictEqual(message,'locked',error);
            store=new SyncStateStore(root,project); await store.initialize(); assert.strictEqual(store.isOwner,false);
            const exited=once(child,'exit'); child.kill('SIGKILL'); await exited;
            assert.strictEqual(await store.tryTakeOwnership(),true);
            assert.strictEqual((await store.listJournal())[0].path,'from-child.tex');
        } finally { if (child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); } }
    });

    test('B04: real-root aliases contend for the same lock and project identity is checked',async()=>{
        const alias=path.join(root,'..',path.basename(root)+'-alias'); await fs.symlink(root,alias,'dir');
        const observer=new SyncStateStore(alias,project),wrong=new SyncStateStore(root,{projectId:'other',serverIdentityHash:'s'});
        try {
            await store.saveState(store.emptyState()); await observer.loadState(); assert.strictEqual(observer.isOwner,false);
            await assert.rejects(()=>wrong.loadState(),/project identity/);
        } finally { await observer.close(); await wrong.close(); await fs.unlink(alias); }
    });

    test('B05: ignored recovery journals and all their data stay untouched',async()=>{
        await fs.writeFile(file(),'base'); inject('captured',async()=>{await fs.writeFile(file(),'recreated');});
        await assert.rejects(()=>store.atomicLocalWrite('main.tex',Buffer.from('remote'),'download'));
        const entry=(await store.listJournal())[0],policy=new PathPolicy(store.access,()=>['main.tex']); store.setMutationPolicy(name=>policy.check(name));
        await store.recoverLocalOperations(); await store.collectGarbage(store.emptyState());
        assert.strictEqual((await store.listJournal()).length,1); assert.strictEqual(await fs.readFile(file(),'utf8'),'recreated');
        assert.strictEqual(Buffer.from((await store.access.read(entry.localRecoveryPath!,true))!).toString(),'base');
    });

    test('B05: ignored watcher paths and previously tracked paths cannot upload',async()=>{
        let patterns:string[]=['**/*.aux']; const policy=new PathPolicy(store.access,()=>patterns);
        const remote=new Map<string,Uint8Array>(); let writes=0;
        const snapshot=(name:string):RemoteSnapshot|undefined=>{ const content=remote.get(name); if (!content) { return; } const hash=contentHash(content)!; return {path:name,entityId:name,kind:'text',content,hash,revision:{kind:'document',documentVersion:1,contentHash:hash}}; };
        const adapter:SyncAdapter={checkPath:name=>policy.check(name),listPaths:async()=>['main.tex','main.aux'],readLocal:name=>store.access.read(name),readRemote:async name=>snapshot(name),isLocalDirty:()=>false,
            applyRemote:async(name,_expected,content)=>{ writes++; remote.set(name,content); return {type:'verified',snapshot:snapshot(name)}; },deleteRemote:async()=>({type:'verified'})};
        await fs.writeFile(file(),'base'); remote.set('main.tex',Buffer.from('base'));
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.aux'),'generated'); await coordinator.handleLocal('main.aux'); await coordinator.syncNow();
        assert.strictEqual(writes,0); assert.strictEqual(coordinator.records().some(record=>record.path==='main.aux'),false);
        patterns=['**/*.aux','main.tex']; await fs.writeFile(file(),'local'); await coordinator.handleLocal('main.tex'); await coordinator.syncNow();
        assert.strictEqual(writes,0); assert.strictEqual(coordinator.records()[0].suspension,'ignored');
    });

    test('B13: draft bursts coalesce and an explicit flush saves the latest edit',async()=>{
        const saved:string[]=[]; const queue=new DraftQueue(async(_id,content)=>{ saved.push(Buffer.from(content).toString()); },error=>{ throw error; },100,1000);
        for (let i=0;i<20;i++) { queue.schedule('conflict',Buffer.from('draft '+i)); }
        await queue.flush(); assert.deepStrictEqual(saved,['draft 19']); queue.cancelTimers();
    });

    test('B13: sustained draft editing is flushed by the maximum delay',async()=>{
        let saved=0; const queue=new DraftQueue(async()=>{saved++;},error=>{throw error;},40,60);
        const editing=setInterval(()=>queue.schedule('conflict',Buffer.from('draft')),10);
        try { await new Promise(resolve=>setTimeout(resolve,115)); assert.ok(saved>=1); }
        finally { clearInterval(editing); await queue.flush(); queue.cancelTimers(); }
    });
    test('B13: an interrupted metadata recovery prevents object and backup cleanup',async()=>{
        const object=await store.putObject(Buffer.from('possibly referenced by corrupt journal'));
        await fs.writeFile(path.join(root,'.overleaf','sync','journal.json.corrupt-test'),'{broken');
        await store.collectGarbage(store.emptyState()); assert.ok(await store.getObject(object));
    });

    test('B02/B05: a watcher checks policy before reading ignored files and stops after disposal',async()=>{
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const event=()=>({dispose:()=>{}}),vscode={RelativePattern:class {},workspace:{createFileSystemWatcher:()=>({dispose:()=>{},onDidCreate:event,onDidChange:event,onDidDelete:event}),onDidSaveTextDocument:event}};
        const monitorModule=isolatedModule('scm/localReplicaSync/monitors',{vscode});
        let reads=0,changes=0; const policy=new PathPolicy(store.access,()=>['main.tex']);
        const read=store.access.read.bind(store.access); store.access.read=async(...args)=>{reads++;return read(...args);};
        const monitor=new monitorModule.LocalChangeMonitor({scheme:'file',fsPath:root},async()=>{changes++;},async()=>{},async()=>{},policy);
        await monitor.waitStable('main.tex'); assert.strictEqual(reads,0); assert.strictEqual(changes,1);
        monitor.dispose(); await monitor.waitStable('main.tex'); assert.strictEqual(changes,1);
    });

    test('B13: object GC preserves conflict, journal and open-session roots only',async()=>{
        const state=store.emptyState(),base=await store.putObject(Buffer.from('base'));
        state.files.doc={key:'doc',path:'main.tex',kind:'text',status:'conflict',pendingConflictId:'c',base:{objectId:base,hash:base,remoteRevision:{kind:'document',documentVersion:1,contentHash:base}},observed:{}};
        await store.saveState(state);
        await store.saveConflict({id:'c',path:'main.tex',kind:'text',reason:'test',baseObjectId:base,hunks:[],createdAt:Date.now()});
        let latest='';
        for (let i=0;i<20;i++) { latest=await store.putObject(Buffer.from('draft '+i)); await store.updateConflictDraft('c',latest,[],{}); }
        const recover=await store.putObject(Buffer.from('recover')),open=await store.putObject(Buffer.from('open'));
        const entry=await store.beginJournal({path:'main.tex',operation:'upload',remoteBeforeObjectId:recover});
        const unpin=store.pinObjects([open]); await store.collectGarbage(state);
        assert.deepStrictEqual((await fs.readdir(path.join(root,'.overleaf','sync','objects'))).sort(),[base,latest,recover,open].sort());
        unpin(); await store.removeJournal(entry.id); await store.removeConflict('c'); state.files.doc.pendingConflictId=undefined; state.files.doc.status='clean'; await store.saveState(state); await store.collectGarbage(state);
        assert.deepStrictEqual(await fs.readdir(path.join(root,'.overleaf','sync','objects')),[base]);
    });

    test('unknown journal versions stop writing without renaming or deleting data',async()=>{
        const journal=path.join(root,'.overleaf','sync','journal.json'); await fs.writeFile(journal,JSON.stringify({schemaVersion:99,entries:[]}));
        await assert.rejects(()=>store.loadState(),/Unsupported/);
        assert.strictEqual(JSON.parse(await fs.readFile(journal,'utf8')).schemaVersion,99);
    });
});
