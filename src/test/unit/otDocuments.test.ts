/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { OtDocuments } from '../../core/ot/documents';
import { OtJournal, OtUpdate } from '../../core/ot/session';

suite('OT subscription and recovery',()=>{
    function fixture(initial?:OtJournal) {
        let journal=initial,joins=0,archived=0,closed=false;
        const versions:(number|undefined)[]=[],sent:OtUpdate[]=[];
        let join=async(_id:string,_version?:number)=>({docLines:['ABC'],version:0,updates:[] as OtUpdate[]});
        const manager=new OtDocuments({readOtJournal:async()=>journal,writeOtJournal:async(_id:string,j:OtJournal)=>{journal=JSON.parse(JSON.stringify(j));},archiveOtJournal:async()=>{archived++;},close:async()=>{closed=true;}} as any,{
            join:async(id,v)=>{joins++;versions.push(v);return join(id,v);},source:()=> 'self',send:async u=>{sent.push(u);},changed:()=>{},error:()=>{},log:()=>{},
        });
        return {manager,sent,versions,journal:()=>journal,joins:()=>joins,archived:()=>archived,closed:()=>closed,setJoin:(value:typeof join)=>{join=value;}};
    }
    test('one initial join is reused by subsequent reads and saves; a compact ACK finishes saving',async()=>{
        const f=fixture();
        try {
            const [a,b]=await Promise.all([f.manager.get('doc'),f.manager.get('doc')]); assert.strictEqual(a,b);
            const save=a.save('ABCD'); await new Promise(resolve=>setImmediate(resolve));
            f.manager.receive({doc:'doc',v:0}); await save;
            assert.strictEqual(await f.manager.get('doc'),a); assert.strictEqual(f.joins(),1);
        } finally { f.manager.dispose(); }
    });
    test('scoped compile barrier waits for its ACK while unrelated documents remain unconfirmed',async()=>{
        // Separate journals, as in production; no shared baseline between documents.
        const journals=new Map<string,OtJournal>();
        const manager=new OtDocuments({readOtJournal:async(id:string)=>journals.get(id),writeOtJournal:async(id:string,j:OtJournal)=>{journals.set(id,j);},close:async()=>{}} as any,{
            join:async()=>({docLines:['ABC'],version:0,updates:[]}),source:()=> 'self',send:async()=>{},changed:()=>{},error:()=>{},log:()=>{},
        });
        const a=await manager.get('a'),b=await manager.get('b');
        const first=a.save('ABCD'),other=b.save('ABCX');
        void other.catch(()=>undefined);
        try {
            let finished=false;
            const barrier=manager.barrier(['a']).then(()=>{finished=true;});
            await new Promise(resolve=>setImmediate(resolve)); assert.strictEqual(finished,false);
            manager.receive({doc:'a',v:0}); await first; await barrier;
            assert.strictEqual(finished,true); assert.strictEqual(b.pending,true);
        } finally { manager.dispose(); }
    });
    test('later saves on the same document cannot extend an already captured compile barrier',async()=>{
        const f=fixture();
        const a=await f.manager.get('doc');
        try {
            const first=a.save('ABCD');
            const barrier=f.manager.barrier(['doc']);
            const later=a.save('ABCDE'); void later.catch(()=>undefined);
            await new Promise(resolve=>setImmediate(resolve));
            f.manager.receive({doc:'doc',v:0}); await first; await barrier;
            assert.strictEqual(a.pending,true);
            f.manager.receive({doc:'doc',v:1}); await later;
        } finally { f.manager.dispose(); }
    });
    test('reconnection requests the persisted version and consumes contiguous history',async()=>{
        const f=fixture();
        try {
            await f.manager.get('doc'); f.manager.disconnect();
            f.setJoin(async()=>({docLines:['AXBC'],version:1,updates:[{doc:'doc',v:0,op:[{p:1,i:'X'}],meta:{source:'other'}}]}));
            await f.manager.reconnect();
            assert.deepStrictEqual(f.versions,[undefined,0]); assert.strictEqual(f.manager.peek('doc')?.confirmed,'AXBC');
        } finally { f.manager.dispose(); }
    });
    test('known unsent offline changes use archived three-way recovery when history expired',async()=>{
        const f=fixture({schemaVersion:1,doc:'doc',version:0,confirmed:'first\nlast\n',pending:[{p:0,i:'local\n'}],draft:[],ticket:1,confirmedTicket:0});
        f.setJoin(async(_id,v)=>{if(v!==undefined){throw new Error('history expired');}return {docLines:['first','last','remote',''],version:5,updates:[]};});
        try {
            const session=await f.manager.get('doc');
            assert.strictEqual(session.saved,'local\nfirst\nlast\nremote\n'); assert.strictEqual(f.archived(),1);
            assert.strictEqual(f.sent[0].v,5); f.manager.receive({doc:'doc',v:5}); await session.barrier();
        } finally { f.manager.dispose(); }
    });
    test('unknown prior submission is never rebased onto a fresh snapshot and resent',async()=>{
        const wire={doc:'doc',v:0,op:[{p:3,i:'D'}]};
        const f=fixture({schemaVersion:1,doc:'doc',version:0,confirmed:'ABC',pending:[],draft:[],ticket:1,confirmedTicket:0,inflight:{op:wire.op,wire,sources:['old'],ticket:1}});
        f.setJoin(async()=>{throw new Error('history expired');});
        try { await assert.rejects(f.manager.get('doc')); assert.strictEqual(f.joins(),1); assert.strictEqual(f.sent.length,0); assert.ok(f.journal()?.inflight); }
        finally { f.manager.dispose(); }
    });
    test('overlapping offline changes stay paused with the original journal intact',async()=>{
        const initial:OtJournal={schemaVersion:1,doc:'doc',version:0,confirmed:'base\n',pending:[{p:0,d:'base'},{p:0,i:'local'}],draft:[],ticket:1,confirmedTicket:0};
        const f=fixture(initial);
        f.setJoin(async(_id,v)=>{if(v!==undefined){throw new Error('history expired');}return {docLines:['remote',''],version:5,updates:[]};});
        try { await assert.rejects(f.manager.get('doc'),/overlap/); assert.strictEqual(f.sent.length,0); assert.deepStrictEqual(f.journal(),initial); }
        finally { f.manager.dispose(); }
    });
});
