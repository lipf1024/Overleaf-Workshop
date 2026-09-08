import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OperationEventSuppressor } from '../../scm/localReplicaSync/eventSuppressor';
import { coalesceTreePaths, findPathCollisions, isInternalReplicaPath, pathComparisonKey, validateReplicaPath } from '../../scm/localReplicaSync/pathSafety';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';

suite('Local replica safety infrastructure',()=>{
    const stores:SyncStateStore[]=[];
    const createStore=(root:string)=>{ const store=new SyncStateStore(root,{projectId:'p',serverIdentityHash:'s'}); stores.push(store); return store; };
    test('suppresses only the exact expected hash',()=>{
        const suppressor=new OperationEventSuppressor();
        const id=suppressor.register('local','main.tex','expected');
        assert.strictEqual(suppressor.consume('local','main.tex','other'),undefined);
        assert.strictEqual(suppressor.consume('local','main.tex','expected'),id);
        assert.strictEqual(suppressor.consume('local','main.tex','expected'),undefined);
    });

    test('rejects traversal and reserved metadata paths',()=>{
        assert.ok(validateReplicaPath('../secret'));
        assert.ok(validateReplicaPath('.overleaf/state.json'));
        assert.strictEqual(isInternalReplicaPath('.OVERLEAF/sync/state.json'),true);
        assert.strictEqual(isInternalReplicaPath('chapters/.OVERLEAF-SYNC-operation-main.tex'),true);
        assert.strictEqual(isInternalReplicaPath('chapters/main.tex'),false);
        assert.strictEqual(validateReplicaPath('chapters/intro.tex'),undefined);
    });

    test('detects case and Unicode normalization collisions',()=>{
        assert.strictEqual(findPathCollisions(['A.tex','a.tex'],true).length,2);
        assert.strictEqual(findPathCollisions(['é.tex','e\u0301.tex'],false).length,2);
        assert.strictEqual(pathComparisonKey('e\u0301.tex',false),pathComparisonKey('é.tex',false));
    });

    test('coalesces nested delete events into their shallowest tree operation',()=>{
        assert.deepStrictEqual(coalesceTreePaths(['dir/a.tex','dir/sub/b.tex','dir','other.tex','dir/a.tex']),['dir','other.tex']);
    });

    test('atomically persists state, objects and journal',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-sync-'));
        try {
            const store=createStore(root);
            const loaded=await store.loadState(); assert.strictEqual(loaded.safeInitialization,true);
            const objectId=await store.putObject(new TextEncoder().encode('content'));
            assert.strictEqual(new TextDecoder().decode(await store.getObject(objectId)),'content');
            const journal=await store.beginJournal({path:'main.tex',operation:'upload',targetHash:'h'});
            assert.strictEqual((await store.listJournal())[0].phase,'prepared');
            journal.phase='remote-applied'; await store.putJournal(journal);
            assert.strictEqual((await store.listJournal())[0].phase,'remote-applied');
            await store.saveState(loaded.state);
            assert.strictEqual((await store.loadState()).safeInitialization,false);
        } finally { await Promise.all(stores.splice(0).map(store=>store.close())); await fs.rm(root,{recursive:true,force:true}); }
    });

    test('quarantines corrupt state and requires safe initialization',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-sync-corrupt-'));
        try {
            const store=createStore(root); await store.initialize();
            await fs.writeFile(path.join(root,'.overleaf','sync','state.json'),'{broken');
            assert.strictEqual((await store.loadState()).safeInitialization,true);
            const files=await fs.readdir(path.join(root,'.overleaf','sync'));
            assert.ok(files.some(file=>file.startsWith('state.json.corrupt-')));
        } finally { await Promise.all(stores.splice(0).map(store=>store.close())); await fs.rm(root,{recursive:true,force:true}); }
    });

    test('backup cleanup preserves journal references and removes expired data',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-sync-prune-'));
        try {
            const store=createStore(root); await store.initialize();
            const expired=await store.backup('old.tex',new Uint8Array([1]));
            const active=await store.backup('active.tex',new Uint8Array([2]));
            const backupDir=path.join(root,'.overleaf','sync','backups');
            await fs.writeFile(path.join(backupDir,`${expired}.json`),JSON.stringify({createdAt:Date.now()-31*24*60*60*1000}));
            await fs.writeFile(path.join(backupDir,`${active}.json`),JSON.stringify({createdAt:Date.now()-31*24*60*60*1000}));
            await store.beginJournal({path:'active.tex',operation:'download',backupObjectId:active});
            await store.pruneBackups();
            await assert.rejects(fs.access(path.join(backupDir,expired)));
            await fs.access(path.join(backupDir,active));
        } finally { await Promise.all(stores.splice(0).map(store=>store.close())); await fs.rm(root,{recursive:true,force:true}); }
    });
    test('quarantines a corrupt journal and forces a safe scan',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-journal-corrupt-'));
        try {
            const store=createStore(root); const initial=await store.loadState(); await store.saveState(initial.state);
            await fs.writeFile(path.join(root,'.overleaf','sync','journal.json'),'{broken');
            await store.close();
            const restarted=createStore(root);
            assert.strictEqual((await restarted.loadState()).safeInitialization,true);
        } finally { await Promise.all(stores.splice(0).map(store=>store.close())); await fs.rm(root,{recursive:true,force:true}); }
    });
    test('enforces the 500 MiB backup cap without touching active entries',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-backup-cap-'));
        try {
            const store=createStore(root); await store.initialize();
            const dir=path.join(root,'.overleaf','sync','backups'),now=Date.now();
            for (const [id,createdAt] of [['new',now],['old',now-1000]] as const) {
                await fs.writeFile(path.join(dir,id),new Uint8Array()); await fs.truncate(path.join(dir,id),300*1024*1024);
                await fs.writeFile(path.join(dir,`${id}.json`),JSON.stringify({createdAt}));
            }
            await store.pruneBackups(); await fs.access(path.join(dir,'new')); await assert.rejects(fs.access(path.join(dir,'old')));
        } finally { await Promise.all(stores.splice(0).map(store=>store.close())); await fs.rm(root,{recursive:true,force:true}); }
    });
});
