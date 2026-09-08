/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OtSession, OtUpdate } from '../../core/ot/session';
import { ReplicaOtBridge } from '../../scm/localReplicaSync/otBridge';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';
import { contentHash } from '../../scm/localReplicaSync/hash';
import { RemoteSnapshot } from '../../scm/localReplicaSync/model';

suite('Local disk OT integration',()=>{
    async function fixture() {
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-ot-bridge-'));
        const file=path.join(root,'main.tex'); await fs.writeFile(file,'ABC');
        const store=new SyncStateStore(root,{projectId:'p',serverIdentityHash:'s'}); await store.initialize();
        const sent:OtUpdate[]=[]; let changed:((id:string,op?:any)=>void)|undefined;
        const session=OtSession.fresh('doc',0,'ABC',{source:()=> 'self',send:async u=>{sent.push(u);},persist:async j=>store.writeOtJournal('a'.repeat(64),j),changed:(_s,_e,_r,op)=>changed?.('doc',op),log:()=>{}});
        const snapshot=():RemoteSnapshot=>{const content=Buffer.from(session.confirmed),hash=contentHash(content)!;return {entityId:'doc',kind:'text',path:'main.tex',content,hash,revision:{kind:'document',documentVersion:session.version,contentHash:hash},connectionEpoch:1};};
        const uri={toString:()=>root};
        const platform:any={workspace:{textDocuments:[],onDidOpenTextDocument:()=>({dispose:()=>{}})},Uri:{joinPath:(_:any,part:string)=>({toString:()=>path.join(root,part)})}};
        const bridge=new ReplicaOtBridge(uri as any,{connectionEpoch:1,onOtChange:(fn:any)=>{changed=fn;return {dispose:()=>{}};},textSession:async()=>session,pathToUri:()=>uri,confirmedTextSnapshot:async()=>snapshot(),bindOtEditor:()=>{}} as any,store,platform);
        await bridge.establish('main.tex',snapshot());
        const waitSend=async(count:number)=>{for(let n=0;n<200&&sent.length<count;n++){await new Promise(resolve=>setTimeout(resolve,5));}assert.strictEqual(sent.length,count);};
        const ack=()=>session.receive({doc:'doc',v:session.version,op:session.snapshot().inflight!.op,meta:{source:'self'}});
        return {root,file,store,session,bridge,sent,waitSend,ack,close:async()=>{bridge.dispose();session.dispose();await store.close();await fs.rm(root,{recursive:true,force:true});}};
    }
    test('saved local delta and a remote insertion converge without snapshot reads',async()=>{
        const f=await fixture();
        try {
            await fs.writeFile(f.file,'ABCD');
            const syncing=f.bridge.sync('main.tex'); await f.waitSend(1);
            await f.session.receive({doc:'doc',v:0,op:[{p:1,i:'X'}],meta:{source:'other'}});
            await f.ack(); const result=await syncing;
            assert.strictEqual(result?.snapshot.content.toString(),'AXBCD');
            assert.strictEqual(await fs.readFile(f.file,'utf8'),'AXBCD');
            await f.bridge.sync('main.tex'); assert.strictEqual(f.sent.length,1);
        } finally { await f.close(); }
    });
    test('a second disk save while waiting for the first ACK is not duplicated or overwritten',async()=>{
        const f=await fixture();
        try {
            await fs.writeFile(f.file,'ABCD');
            const syncing=f.bridge.sync('main.tex'); const rejected=assert.rejects(syncing,/saved again/); await f.waitSend(1);
            await fs.writeFile(f.file,'ABCDE'); await f.ack(); await rejected;
            assert.strictEqual(await fs.readFile(f.file,'utf8'),'ABCDE');
            const next=f.bridge.sync('main.tex'); await f.waitSend(2); await f.ack(); await next;
            assert.strictEqual(f.session.confirmed,'ABCDE');
        } finally { await f.close(); }
    });
    test('an unsaved editor layer never reaches the local disk or server',async()=>{
        const f=await fixture();
        try {
            await f.session.edit('ABCD');
            await f.session.receive({doc:'doc',v:0,op:[{p:1,i:'X'}],meta:{source:'other'}});
            await f.bridge.sync('main.tex');
            assert.strictEqual(f.session.editor,'AXBCD'); assert.strictEqual(await fs.readFile(f.file,'utf8'),'AXBC'); assert.strictEqual(f.sent.length,0);
        } finally { await f.close(); }
    });
    test('disk reconciliation uses actual remote operations rather than a net snapshot diff',async()=>{
        const f=await fixture();
        try {
            await fs.writeFile(f.file,'');
            await f.session.receive({doc:'doc',v:0,op:[{p:1,d:'B'}],meta:{source:'other'}});
            await f.session.receive({doc:'doc',v:1,op:[{p:1,i:'B'}],meta:{source:'other'}});
            const syncing=f.bridge.sync('main.tex'); await f.waitSend(1);
            await f.ack(); await syncing;
            assert.strictEqual(f.session.confirmed,'B'); assert.strictEqual(await fs.readFile(f.file,'utf8'),'B');
        } finally { await f.close(); }
    });
});
