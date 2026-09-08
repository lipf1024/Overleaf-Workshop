import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SyncAdapter, SyncCoordinator } from '../../scm/localReplicaSync/coordinator';
import { contentHash } from '../../scm/localReplicaSync/hash';
import { ApplyResult, FileKind, JournalEntry, RemoteRevision, RemoteSnapshot } from '../../scm/localReplicaSync/model';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';
import { conflictSnapshotKey, hasUnresolvedConflict } from '../../scm/localReplicaSync/conflictState';

const bytes=(value:string)=>new TextEncoder().encode(value);

class FakeAdapter implements SyncAdapter {
    remote=new Map<string,Uint8Array>();
    remoteIds=new Map<string,string>();
    version=1;
    epoch=1;
    ready=true;
    remoteReads=0;
    applyCount=0;
    lastApplyKind?:FileKind;
    dirty=false;
    applyBehavior?: (path:string,content:Uint8Array,kind:FileKind)=>Promise<ApplyResult>;
    deleteBehavior?: (path:string)=>Promise<ApplyResult>;
    recoverBehavior?: (entry:JournalEntry,original?:Uint8Array)=>Promise<ApplyResult>;
    constructor(private readonly root:string) {}
    async listPaths():Promise<string[]> { return [...new Set([...this.remote.keys(),'main.tex'])]; }
    async readLocal(name:string):Promise<Uint8Array|undefined> { try { return await fs.readFile(path.join(this.root,name)); } catch { return undefined; } }
    async readRemote(name:string):Promise<RemoteSnapshot|undefined> {
        this.remoteReads++;
        const content=this.remote.get(name); if (!content) { return undefined; }
        const hash=contentHash(content)!;
        return {path:name,entityId:this.remoteIds.get(name)??`id:${name}`,kind:'text',content,hash,revision:{kind:'document',documentVersion:this.version,contentHash:hash},connectionEpoch:this.epoch};
    }
    async applyRemote(name:string,_expected:RemoteRevision|undefined,content:Uint8Array,kind:FileKind):Promise<ApplyResult> {
        this.applyCount++; this.lastApplyKind=kind; if (this.applyBehavior) { return this.applyBehavior(name,content,kind); }
        this.remote.set(name,content); this.version++; return {type:'verified',snapshot:await this.readRemote(name)};
    }
    async deleteRemote(name:string):Promise<ApplyResult> {
        if (this.deleteBehavior) { return this.deleteBehavior(name); }
        this.remote.delete(name); return {type:'verified',connectionEpoch:this.epoch};
    }
    isLocalDirty():boolean { return this.dirty; }
    connectionEpoch():number { return this.epoch; }
    isConnectionReady():boolean { return this.ready; }
    async recoverRemote(entry:JournalEntry,original?:Uint8Array):Promise<ApplyResult> {
        return this.recoverBehavior?.(entry,original)??{type:'unknown',message:'recovery unavailable'};
    }
    async locateRemotePath(entityId:string):Promise<string|undefined> { return [...this.remoteIds].find(([,id])=>id===entityId)?.[0]; }
    async findLocalPathsByHash(hash:string,exclude:string):Promise<string[]> {
        const result:string[]=[];
        const walk=async(dir:string,prefix=''):Promise<void>=>{ for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
            if (entry.name==='.overleaf' || entry.name.startsWith('.overleaf-sync-')) { continue; } const relative=prefix?`${prefix}/${entry.name}`:entry.name,full=path.join(dir,entry.name);
            if (entry.isDirectory()) { await walk(full,relative); } else if (relative!==exclude && contentHash(await fs.readFile(full))===hash) { result.push(relative); }
        }};
        await walk(this.root); return result;
    }
    async renameRemote(oldPath:string,newPath:string):Promise<ApplyResult> {
        const content=this.remote.get(oldPath); if (!content || this.remote.has(newPath)) { return {type:'conflict'}; }
        const id=this.remoteIds.get(oldPath)??`id:${oldPath}`; this.remote.delete(oldPath); this.remoteIds.delete(oldPath);
        this.remote.set(newPath,content); this.remoteIds.set(newPath,id); this.version++;
        return {type:'verified',snapshot:await this.readRemote(newPath)};
    }
}

suite('SyncCoordinator fault safety',()=>{
    let root:string,store:SyncStateStore,adapter:FakeAdapter;
    setup(async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-coordinator-'));
        await fs.writeFile(path.join(root,'main.tex'),bytes('base\n'));
        store=new SyncStateStore(root,{projectId:'p',serverIdentityHash:'s'});
        adapter=new FakeAdapter(root); adapter.remote.set('main.tex',bytes('base\n')); adapter.remoteIds.set('main.tex','doc-1');
    });
    teardown(async()=>{ await store.close(); await fs.rm(root,{recursive:true,force:true}); });

    test('repeated manual sync clicks share one run and allow another after completion',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        const first=coordinator.syncNow(),second=coordinator.syncNow();
        assert.strictEqual(first,second);
        await first;
        const next=coordinator.syncNow(); assert.notStrictEqual(next,first); await next;
    });
    test('single-file sync uploads a new file without scanning or uploading its neighbors',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'new.tex'),bytes('new file\n'));
        await fs.writeFile(path.join(root,'other.tex'),bytes('keep local\n'));
        adapter.listPaths=async()=>{throw new Error('Single-file sync must not scan the project');};
        await coordinator.syncPath('new.tex');
        assert.strictEqual(Buffer.from(adapter.remote.get('new.tex')!).toString(),'new file\n');
        assert.strictEqual(adapter.remote.has('other.tex'),false); assert.strictEqual(adapter.applyCount,1);
    });
    test('single-file sync also updates an existing file with automatic sync disabled',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'manual'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('edited\n'));
        await coordinator.syncPath('main.tex');
        assert.strictEqual(Buffer.from(adapter.remote.get('main.tex')!).toString(),'edited\n');
        assert.strictEqual(coordinator.records().find(record=>record.path==='main.tex')?.status,'clean');
    });
    test('single-file sync does not overwrite a same-name file without a shared baseline',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.remote.set('new.tex',bytes('remote\n')); await fs.writeFile(path.join(root,'new.tex'),bytes('local\n'));
        await coordinator.syncPath('new.tex');
        assert.strictEqual(adapter.applyCount,0);
        assert.strictEqual(coordinator.records().find(record=>record.path==='new.tex')?.status,'conflict');
    });

    test('manual sync waits for automatic upload without sending it twice',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('saved\n'));
        let release!:()=>void,started!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        const applying=new Promise<void>(resolve=>{started=resolve;});
        adapter.applyBehavior=async(name,content)=>{
            started(); await gate; adapter.remote.set(name,content); adapter.version++;
            return {type:'verified',snapshot:await adapter.readRemote(name)};
        };
        const automatic=coordinator.handleLocal('main.tex'); await applying;
        let finished=false;
        const manual=coordinator.syncNow().then(()=>{finished=true;});
        await new Promise(resolve=>setImmediate(resolve));
        assert.strictEqual(finished,false); assert.strictEqual(adapter.applyCount,1);
        release(); await Promise.all([automatic,manual]);
        assert.strictEqual(adapter.applyCount,1);
        assert.strictEqual(coordinator.records()[0].status,'clean');
    });

    test('manual sync does not enable concurrent watchers or undo a changed setting',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'manual'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('manual edit\n'));
        let release!:()=>void,started!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        const applying=new Promise<void>(resolve=>{started=resolve;});
        adapter.applyBehavior=async(name,content)=>{
            started(); await gate; adapter.remote.set(name,content); adapter.version++;
            return {type:'verified',snapshot:await adapter.readRemote(name)};
        };
        const manual=coordinator.syncNow(); await applying;
        adapter.remote.set('other.tex',bytes('remote\n'));
        await coordinator.handleRemote('other.tex');
        assert.strictEqual(await adapter.readLocal('other.tex'),undefined);
        coordinator.setMode('safeAuto');
        release(); await manual;
        assert.strictEqual((await coordinator.diagnostics() as any).mode,'safeAuto');
    });

    test('compile reuses a current connection confirmation without a remote read',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        const reads=adapter.remoteReads;
        await coordinator.prepareLocalForCompile('main.tex');
        assert.strictEqual(adapter.remoteReads,reads);
        assert.strictEqual(adapter.applyCount,0);
    });

    test('compile uploads the saved contents before reusing their confirmation',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('saved\n'));
        await coordinator.prepareLocalForCompile('main.tex');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'saved\n');
        assert.strictEqual(adapter.applyCount,1);
        const reads=adapter.remoteReads;
        await coordinator.prepareLocalForCompile('main.tex');
        assert.strictEqual(adapter.remoteReads,reads);
    });

    test('compile shares a queued upload confirmation instead of checking remote again',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('saved\n'));
        let release!:()=>void,started!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        const applying=new Promise<void>(resolve=>{started=resolve;});
        let confirmedReads=0;
        adapter.applyBehavior=async(name,content)=>{
            started(); await gate; adapter.remote.set(name,content); adapter.version++;
            const snapshot=await adapter.readRemote(name); confirmedReads=adapter.remoteReads;
            return {type:'verified',snapshot};
        };
        const save=coordinator.handleLocal('main.tex'); await applying;
        let finished=false;
        const compile=coordinator.prepareLocalForCompile('main.tex').then(()=>{finished=true;});
        await new Promise(resolve=>setImmediate(resolve));
        assert.strictEqual(finished,false); release(); await Promise.all([save,compile]);
        assert.strictEqual(adapter.remoteReads,confirmedReads);
        assert.strictEqual(coordinator.records()[0].status,'clean');
    });

    test('remote events still synchronize changes after an optimistic compile check',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.remote.set('main.tex',bytes('remote edit\n')); adapter.version++;
        await coordinator.prepareLocalForCompile('main.tex');
        await coordinator.handleRemote('main.tex');
        assert.strictEqual(new TextDecoder().decode(await adapter.readLocal('main.tex')),'remote edit\n');
        assert.strictEqual(adapter.applyCount,0);
    });

    for (const condition of ['reconnect','offline','dirty','conflict','uncertain'] as const) {
        test(`compile checks remote state when ${condition}`,async()=>{
            const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
            if (condition==='reconnect') { adapter.epoch++; }
            if (condition==='offline') { adapter.ready=false; }
            if (condition==='dirty') { adapter.dirty=true; }
            if (condition==='conflict') { coordinator.records()[0].pendingConflictId='unresolved'; }
            if (condition==='uncertain') { coordinator.records()[0].status='pending-upload'; }
            const reads=adapter.remoteReads;
            await coordinator.prepareLocalForCompile('main.tex');
            assert.ok(adapter.remoteReads>reads);
        });
    }

    test('compile waits for a queued upload and does not accept a newer unconfirmed save',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('first\n'));
        let release!:()=>void,started!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        const applying=new Promise<void>(resolve=>{started=resolve;});
        adapter.applyBehavior=async(name,content)=>{
            started(); await gate; adapter.remote.set(name,content); adapter.version++;
            return {type:'verified',snapshot:await adapter.readRemote(name)};
        };
        const save=coordinator.handleLocal('main.tex'); await applying;
        let finished=false;
        const compile=coordinator.prepareLocalForCompile('main.tex').then(()=>{finished=true;});
        await fs.writeFile(path.join(root,'main.tex'),bytes('second\n'));
        assert.strictEqual(finished,false); release();
        await Promise.all([save,compile]);
        assert.strictEqual(new TextDecoder().decode(await adapter.readLocal('main.tex')),'second\n');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'first\n');
        assert.ok(coordinator.records()[0].pendingConflictId);
        assert.notStrictEqual(coordinator.records()[0].status,'clean');
    });

    test('uploads a sole local change and verifies it',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'local\n');
        assert.strictEqual(coordinator.records()[0].status,'clean');
    });

    test('first association never writes local-only or remote-only files',async()=>{
        adapter.remote.delete('main.tex'); adapter.remoteIds.delete('main.tex');
        let coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        assert.strictEqual(coordinator.records()[0].status,'pending-upload'); assert.strictEqual(adapter.applyCount,0);
        await store.close(); await fs.rm(root,{recursive:true,force:true}); root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-coordinator-'));
        store=new SyncStateStore(root,{projectId:'p',serverIdentityHash:'s'}); adapter=new FakeAdapter(root);
        adapter.remote.set('main.tex',bytes('remote only\n')); adapter.remoteIds.set('main.tex','doc-1');
        coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        assert.strictEqual(coordinator.records()[0].status,'pending-download'); await assert.rejects(fs.access(path.join(root,'main.tex')));
    });

    test('an ASCII-only PDF is still treated as binary and requires confirmation',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'paper.pdf'),bytes('%PDF-1.4\nASCII fixture\n'));
        await coordinator.handleLocal('paper.pdf');
        const record=coordinator.records().find(item=>item.path==='paper.pdf')!;
        assert.strictEqual(record.kind,'binary'); assert.strictEqual(record.status,'pending-upload'); assert.strictEqual(adapter.applyCount,0);
        await coordinator.syncNow();
        assert.strictEqual(adapter.lastApplyKind,'binary');
    });

    test('a newly created local text file also requires explicit confirmation',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'chapter.tex'),bytes('new chapter\n'));
        await coordinator.handleLocal('chapter.tex');
        assert.strictEqual(coordinator.records().find(item=>item.path==='chapter.tex')?.status,'pending-upload');
        assert.strictEqual(adapter.remote.has('chapter.tex'),false);
        const previousApplyCount=adapter.applyCount;
        await coordinator.syncNow();
        assert.strictEqual(adapter.applyCount,previousApplyCount+1);
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('chapter.tex')),'new chapter\n');
        assert.strictEqual(coordinator.records().find(item=>item.path==='chapter.tex')?.key,'id:chapter.tex');
    });

    test('manual mode performs no implicit write',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'manual'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(adapter.applyCount,0); assert.strictEqual(coordinator.records()[0].status,'pending-upload');
    });

    test('manual Sync Now is the explicit confirmation',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'manual'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex'); await coordinator.syncNow();
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'local\n'); assert.strictEqual(coordinator.records()[0].status,'clean');
    });

    test('simultaneous overlapping changes freeze without upload',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); adapter.remote.set('main.tex',bytes('remote\n')); adapter.version++;
        await coordinator.handleLocal('main.tex');
        assert.strictEqual(adapter.applyCount,0); assert.strictEqual(coordinator.records()[0].status,'conflict');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'local\n');
    });

    test('confirmation loss is recovered after restart without losing either content',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.applyBehavior=async(name,content)=>{ adapter.remote.set(name,content); adapter.version++; return {type:'unknown',message:'confirmation lost'}; };
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'pending-upload'); assert.ok((await store.listJournal()).length>0);
        const restarted=new SyncCoordinator(store,adapter,'safeAuto'); await restarted.initialize();
        assert.strictEqual(restarted.records()[0].status,'clean'); assert.strictEqual((await store.listJournal()).length,0);
    });

    test('retries a document version-only race but not a content race',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        let first=true;
        adapter.applyBehavior=async(name,content)=>{
            if (first) { first=false; adapter.version++; return {type:'conflict',snapshot:await adapter.readRemote(name)}; }
            adapter.remote.set(name,content); adapter.version++; return {type:'verified',snapshot:await adapter.readRemote(name)};
        };
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(adapter.applyCount,2); assert.strictEqual(coordinator.records()[0].status,'clean');
    });

    test('freezes when content changes during upload',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.applyBehavior=async name=>{ adapter.remote.set(name,bytes('competitor\n')); adapter.version++; return {type:'conflict',snapshot:await adapter.readRemote(name)}; };
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'conflict');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'local\n');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'competitor\n');
    });

    test('deduplicates repeated self events by verified content',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex');
        await coordinator.handleLocal('main.tex'); await coordinator.handleRemote('main.tex');
        assert.strictEqual(adapter.applyCount,1);
    });

    test('keeps local content and journal when upload times out before confirmation',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.applyBehavior=async()=>({type:'unknown',message:'timeout'});
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'local\n');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'base\n');
        assert.strictEqual(coordinator.records()[0].status,'pending-upload'); assert.strictEqual((await store.listJournal()).length,1);
    });

    test('recovers prepared and local-applied journal stages by re-reading both sides',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await store.beginJournal({path:'main.tex',operation:'upload',targetHash:'unknown'});
        let restarted=new SyncCoordinator(store,adapter,'safeAuto'); await restarted.initialize();
        assert.strictEqual((await store.listJournal()).length,0);
        await store.atomicLocalWrite('main.tex',bytes('after crash\n'),'merge');
        restarted=new SyncCoordinator(store,adapter,'safeAuto'); await restarted.initialize();
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'after crash\n');
        assert.strictEqual(restarted.records()[0].status,'clean'); assert.strictEqual((await store.listJournal()).length,0);
    });

    test('freezes a path while staged binary recovery remains unknown',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await store.beginJournal({path:'main.tex',operation:'upload',targetHash:contentHash(bytes('new binary')),
            temporaryPath:'.overleaf-sync-op-main.tex',remoteBeforeObjectId:await store.putObject(bytes('base\n'))});
        adapter.recoverBehavior=async()=>({type:'unknown',message:'offline during staged recovery'});
        const restarted=new SyncCoordinator(store,adapter,'safeAuto'); await restarted.initialize();
        assert.strictEqual(restarted.records()[0].status,'error');
        assert.strictEqual(adapter.applyCount,0);
        assert.strictEqual((await store.listJournal()).length,1);
    });

    test('does not replay an unknown staged binary upload on a later file event',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'paper.pdf'),bytes('%PDF local binary'));
        await coordinator.handleLocal('paper.pdf');
        adapter.applyBehavior=async()=>({type:'unknown',message:'upload response lost',temporaryPath:'.overleaf-sync-stage-paper.pdf',temporaryEntityId:'stage-1'});
        await coordinator.syncNow();
        assert.strictEqual(adapter.applyCount,1);
        assert.ok((await store.listJournal()).some(entry=>entry.temporaryEntityId==='stage-1' && entry.phase==='unknown'));
        await coordinator.handleLocal('paper.pdf');
        assert.strictEqual(adapter.applyCount,1);
        assert.strictEqual(coordinator.records().find(record=>record.path==='paper.pdf')?.status,'error');
    });

    test('tracks a clean remote rename by stable entity id',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        const content=adapter.remote.get('main.tex')!; adapter.remote.delete('main.tex'); adapter.remoteIds.delete('main.tex');
        adapter.remote.set('renamed.tex',content); adapter.remoteIds.set('renamed.tex','doc-1');
        await coordinator.handleRemote('main.tex');
        await fs.access(path.join(root,'renamed.tex')); await assert.rejects(fs.access(path.join(root,'main.tex')));
        assert.strictEqual(coordinator.records().find(record=>record.entityId==='doc-1')?.path,'renamed.tex');
    });

    test('infers a unique unchanged local rename by content hash',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.rename(path.join(root,'main.tex'),path.join(root,'renamed.tex'));
        await coordinator.handleTreeDelete('local','main.tex');
        assert.strictEqual(adapter.remote.has('main.tex'),false); assert.strictEqual(adapter.remote.has('renamed.tex'),true);
        assert.strictEqual(adapter.remoteIds.get('renamed.tex'),'doc-1');
    });

    test('freezes an entire deleted directory when one child changed',async()=>{
        await fs.mkdir(path.join(root,'dir')); await fs.writeFile(path.join(root,'dir','a.tex'),bytes('a\n')); await fs.writeFile(path.join(root,'dir','b.tex'),bytes('b\n'));
        adapter.remote.set('dir/a.tex',bytes('a\n')); adapter.remote.set('dir/b.tex',bytes('b\n'));
        adapter.remoteIds.set('dir/a.tex','a'); adapter.remoteIds.set('dir/b.tex','b');
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'dir','a.tex'),bytes('changed\n')); adapter.remote.delete('dir/a.tex'); adapter.remote.delete('dir/b.tex');
        await coordinator.handleTreeDelete('remote','dir');
        assert.ok(coordinator.records().filter(record=>record.path.startsWith('dir/')).every(record=>record.status==='conflict'));
        await fs.access(path.join(root,'dir','b.tex'));
    });

    test('saving, Sync Now, and restarting cannot silently resolve a pending conflict',async()=>{
        let coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); adapter.remote.set('main.tex',bytes('remote\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const id=coordinator.records()[0].pendingConflictId!;
        // Reverting one side would normally turn this into a one-sided download.
        await fs.writeFile(path.join(root,'main.tex'),bytes('base\n'));
        await coordinator.handleLocal('main.tex');
        await coordinator.syncNow();
        coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        assert.strictEqual(await fs.readFile(path.join(root,'main.tex'),'utf8'),'base\n');
        assert.strictEqual(coordinator.records()[0].pendingConflictId,id);
        assert.strictEqual(coordinator.records()[0].status,'conflict');
        assert.strictEqual(adapter.applyCount,0);
        // Even matching both sides by hand requires an explicit resolution.
        await fs.writeFile(path.join(root,'main.tex'),bytes('remote\n'));
        await coordinator.handleLocal('main.tex');
        assert.strictEqual(hasUnresolvedConflict(coordinator.records()[0]),true);
        assert.strictEqual((await coordinator.resolveWithSide(id,'remote')).ok,true);
        assert.strictEqual(hasUnresolvedConflict(coordinator.records()[0]),false);
    });

    test('draft saves never upload, and explicit merge completion clears the conflict',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); adapter.remote.set('main.tex',bytes('remote\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const id=coordinator.records()[0].pendingConflictId!;
        const conflict=(await coordinator.getConflict(id))!;
        const draft=bytes('reviewed local and remote\n');
        await coordinator.saveConflictDraft(id,draft,[]);
        assert.strictEqual(adapter.applyCount,0);
        assert.strictEqual(await fs.readFile(path.join(root,'main.tex'),'utf8'),'local\n');
        assert.strictEqual(coordinator.records()[0].status,'conflict');
        const result=await coordinator.resolveConflict(id,draft,conflict.hunks.map((_,index)=>index),conflictSnapshotKey(conflict));
        assert.strictEqual(result.ok,true);
        assert.strictEqual(adapter.applyCount,1);
        assert.strictEqual(hasUnresolvedConflict(coordinator.records()[0]),false);
        assert.strictEqual(await coordinator.getConflict(id),undefined);
    });

    test('flush waits for pending editor draft persistence',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); adapter.remote.set('main.tex',bytes('remote\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const id=coordinator.records()[0].pendingConflictId!;
        const saving=coordinator.saveConflictDraft(id,bytes('last editor change\n'),[]);
        await coordinator.flush();
        const conflict=(await coordinator.getConflict(id))!;
        assert.strictEqual(new TextDecoder().decode(await coordinator.getObject(conflict.draftObjectId)),'last editor change\n');
        await saving;
    });

    test('rejects a stale merge editor even after the background scan refreshed the conflict',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); adapter.remote.set('main.tex',bytes('remote\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const id=coordinator.records()[0].pendingConflictId!;
        const opened=(await coordinator.getConflict(id))!;
        adapter.remote.set('main.tex',bytes('newer remote\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const result=await coordinator.resolveConflict(id,bytes('old editor draft\n'),[0],conflictSnapshotKey(opened));
        assert.strictEqual(result.ok,false);
        assert.strictEqual(adapter.applyCount,0);
        assert.strictEqual(await fs.readFile(path.join(root,'main.tex'),'utf8'),'local\n');
        const current=(await coordinator.getConflict(id))!;
        assert.strictEqual(new TextDecoder().decode(await coordinator.getObject(current.draftObjectId)),'old editor draft\n');
        assert.strictEqual(current.remoteHash,contentHash(bytes('newer remote\n')));
    });

    test('an unstable local file and a network error do not erase a conflict',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); adapter.remote.set('main.tex',bytes('remote\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const id=coordinator.records()[0].pendingConflictId;
        await coordinator.markUnstable('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'conflict');
        adapter.readRemote=async()=>{ throw new Error('offline'); };
        await coordinator.handleRemote('main.tex');
        assert.strictEqual(coordinator.records()[0].pendingConflictId,id);
        assert.strictEqual(hasUnresolvedConflict(coordinator.records()[0]),true);
        assert.strictEqual(adapter.applyCount,0);
    });

    test('preserves a merge draft when a newer remote revision arrives',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local\n')); adapter.remote.set('main.tex',bytes('remote\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const id=coordinator.records()[0].pendingConflictId!; const draft=bytes('careful draft\n');
        await coordinator.saveConflictDraft(id,draft,[0]); adapter.remote.set('main.tex',bytes('newer remote\n')); adapter.version++;
        const result=await coordinator.resolveConflict(id,draft,[0]); assert.strictEqual(result.ok,false);
        const refreshed=await coordinator.getConflict(id); assert.strictEqual(new TextDecoder().decode(await coordinator.getObject(refreshed?.draftObjectId)),'careful draft\n');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'local\n');
    });

    test('never uploads unresolved conflict markers',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('<<<<<<< local\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'conflict'); assert.strictEqual(adapter.applyCount,0);
    });

    test('can explicitly accept a remote deletion after a delete-modify conflict',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local changed\n')); adapter.remote.delete('main.tex'); adapter.remoteIds.delete('main.tex');
        await coordinator.handleRemote('main.tex'); const id=coordinator.records()[0].pendingConflictId!;
        assert.strictEqual((await coordinator.resolveWithSide(id,'remote')).ok,true);
        await assert.rejects(fs.access(path.join(root,'main.tex')));
    });

    test('adopting a remote conflict version never rewrites Overleaf',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('local changed\n'));
        adapter.remote.set('main.tex',bytes('remote changed\n')); adapter.version++;
        await coordinator.handleRemote('main.tex');
        const id=coordinator.records()[0].pendingConflictId!;
        const result=await coordinator.resolveWithSide(id,'remote');
        assert.strictEqual(result.ok,true);
        assert.strictEqual(adapter.applyCount,0);
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'remote changed\n');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'remote changed\n');
        assert.strictEqual(coordinator.records()[0].status,'clean');
        assert.strictEqual(await coordinator.getConflict(id),undefined);
    });

    test('does not write over an unsaved editor buffer',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize(); adapter.dirty=true;
        adapter.remote.set('main.tex',bytes('remote changed\n')); adapter.version++; await coordinator.handleRemote('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'pending-download');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'base\n');
    });

    test('keeps local data when authentication or network reads fail',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        await fs.writeFile(path.join(root,'main.tex'),bytes('offline work\n'));
        adapter.readRemote=async()=>{ throw new Error('authentication failed'); };
        await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'error');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'offline work\n');
    });

    test('a local read error is never interpreted as deletion',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        const original=adapter.readLocal.bind(adapter);
        adapter.readLocal=async name=>{ if (name==='main.tex') { throw Object.assign(new Error('permission denied'),{code:'EACCES'}); } return original(name); };
        await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'error');
        assert.strictEqual(adapter.remote.has('main.tex'),true);
        assert.strictEqual(adapter.applyCount,0);
    });

    test('does not commit a base when remote changes during download',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.remote.set('main.tex',bytes('remote one\n')); adapter.version++;
        const original=adapter.readRemote.bind(adapter); let reads=0;
        adapter.readRemote=async name=>{ reads++; if (reads===4) { adapter.remote.set(name,bytes('remote two\n')); adapter.version++; } return original(name); };
        await coordinator.handleRemote('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'pending-download');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'remote one\n');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'remote two\n');
        assert.ok((await store.listJournal()).length>0);
    });

    test('does not commit a base when local changes during upload',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.applyBehavior=async(name,content)=>{
            adapter.remote.set(name,content); adapter.version++; await fs.writeFile(path.join(root,name),bytes('newer local\n'));
            return {type:'verified',snapshot:await adapter.readRemote(name)};
        };
        await fs.writeFile(path.join(root,'main.tex'),bytes('upload target\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'pending-upload');
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'newer local\n');
        assert.strictEqual(new TextDecoder().decode(adapter.remote.get('main.tex')),'upload target\n');
        assert.ok((await store.listJournal()).some(entry=>entry.phase==='remote-applied'));
    });

    test('does not commit a base across connection epochs',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.applyBehavior=async(name,content)=>{
            adapter.remote.set(name,content); adapter.version++;
            const snapshot=await adapter.readRemote(name); adapter.epoch++;
            return {type:'verified',snapshot};
        };
        await fs.writeFile(path.join(root,'main.tex'),bytes('epoch target\n')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'pending-upload');
        assert.strictEqual(coordinator.records()[0].base?.hash,contentHash(bytes('base\n')));
        assert.ok((await store.listJournal()).some(entry=>entry.phase==='unknown'));
    });

    test('does not accept a remote deletion verified on an obsolete connection',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        adapter.deleteBehavior=async name=>{
            const operationEpoch=adapter.epoch; adapter.remote.delete(name); adapter.epoch++;
            return {type:'verified',connectionEpoch:operationEpoch};
        };
        await fs.unlink(path.join(root,'main.tex')); await coordinator.handleLocal('main.tex');
        assert.strictEqual(coordinator.records()[0].status,'error');
        assert.ok((await store.listJournal()).some(entry=>entry.operation==='delete-remote'));
        assert.ok(coordinator.records()[0].base);
    });

    test('freezes a path when its referenced baseline object is missing',async()=>{
        const coordinator=new SyncCoordinator(store,adapter,'safeAuto'); await coordinator.initialize();
        const baseline=coordinator.records()[0].base!;
        await fs.unlink(path.join(root,'.overleaf','sync','objects',baseline.objectId));
        await fs.writeFile(path.join(root,'main.tex'),bytes('local after lost baseline\n'));
        adapter.remote.delete('main.tex'); adapter.remoteIds.delete('main.tex');
        const restarted=new SyncCoordinator(store,adapter,'safeAuto'); await restarted.initialize();
        await restarted.handleLocal('main.tex');
        assert.strictEqual(restarted.records()[0].status,'error');
        assert.match(restarted.records()[0].message??'',/baseline is missing or corrupted/);
        assert.strictEqual(adapter.applyCount,0);
        assert.strictEqual(new TextDecoder().decode(await fs.readFile(path.join(root,'main.tex'))),'local after lost baseline\n');
        assert.strictEqual(adapter.remote.has('main.tex'),false);
    });
});
