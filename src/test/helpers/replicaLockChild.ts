import * as fs from 'fs/promises';
import * as path from 'path';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';
import { contentHash } from '../../scm/localReplicaSync/hash';
const store=new SyncStateStore(process.argv[2],{projectId:'p',serverIdentityHash:'s'});
void (async()=>{
    await store.initialize();
    if (!store.isOwner) { throw new Error('Child could not acquire replica ownership'); }
    process.on('message',()=>undefined);
    const stage=process.argv[3];
    if (stage) {
        await fs.writeFile(path.join(process.argv[2],'main.tex'),'base');
        const put=store.putJournal.bind(store);
        store.putJournal=async entry=>{
            await put(entry);
            if (entry.localStage===stage) { process.send?.(stage); await new Promise<void>(()=>{}); }
        };
        await store.atomicLocalWrite('main.tex',Buffer.from('installed'),'download',undefined,contentHash(Buffer.from('base')),true);
    } else {
        await store.beginJournal({path:'from-child.tex',operation:'upload'});
        process.send?.('locked');
    }
})().catch(error=>{ console.error(error); process.exitCode=1; process.disconnect?.(); });
