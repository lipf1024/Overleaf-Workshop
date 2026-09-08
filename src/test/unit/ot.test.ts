/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { OtSession, OtJournal, OtUpdate } from '../../core/ot/session';
import { textDiff, textOT } from '../../core/ot/text';
import { isolatedModule } from '../helpers/isolatedModule';

function fixture(initial='ABC') {
    const sent:OtUpdate[]=[],journals:OtJournal[]=[];
    let identity='client-a';
    const session=OtSession.fresh('doc',0,initial,{
        source:()=>identity,send:async update=>{sent.push(JSON.parse(JSON.stringify(update)));},
        persist:async journal=>{journals.push(journal);},changed:()=>{},log:()=>{},
    });
    const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
    const acknowledge=async()=>{
        const wire=sent[sent.length-1];
        await session.receive({...wire,v:session.version,op:session.snapshot().inflight!.op,meta:{source:identity}});
    };
    return {session,sent,journals,tick,acknowledge,identity:(value:string)=>{identity=value;}};
}

suite('Online text OT',()=>{
    test('official same-position insertion ordering and overlapping deletion',()=>{
        const [a,b]=textOT.transformX([{p:1,i:'你'}],[{p:1,i:'他'}]);
        assert.strictEqual(textOT.apply(textOT.apply('AB',[{p:1,i:'他'}]),a),'A你他B');
        assert.strictEqual(textOT.apply(textOT.apply('AB',[{p:1,i:'你'}]),b),'A你他B');
        assert.deepStrictEqual(textOT.transformX([{p:0,d:'AB'}],[{p:0,d:'AB'}]),[[],[]]);
    });
    test('seeded concurrent edits converge including Unicode and newlines',()=>{
        let seed=7123;
        const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
        const samples=['ABC','你好世界','A😀B\n第二行','\n',''];
        for (let n=0;n<400;n++) {
            const base=samples[n%samples.length];
            const mutate=()=>{const points=Array.from(base),at=random()%(points.length+1);points.splice(at,random()%2,['你','🙂','\n','XYZ'][random()%4]);return points.join('');};
            const a=textDiff(base,mutate()),b=textDiff(base,mutate());
            const [aa,bb]=textOT.transformX(a,b);
            assert.strictEqual(textOT.apply(textOT.apply(base,a),bb),textOT.apply(textOT.apply(base,b),aa));
        }
    });
    test('socket acceptance cannot finish save; application echo can',async()=>{
        const f=fixture(); let finished=false;
        try {
            const saved=f.session.save('ABCD').then(()=>{finished=true;});
            await f.tick(); assert.strictEqual(f.sent.length,1); assert.strictEqual(finished,false);
            assert.ok(f.journals.some(j=>j.inflight?.sources.includes('client-a')));
            await f.acknowledge(); await saved;
            assert.strictEqual(f.session.confirmed,'ABCD'); assert.strictEqual(finished,true);
        } finally { f.session.dispose(); }
    });
    test('official compact {doc,v} ACK confirms the rebased inflight operation',async()=>{
        const f=fixture();
        try {
            const save=f.session.save('ABCD'); await f.tick();
            await f.session.receive({doc:'doc',v:0,op:[{p:0,i:'X'}],meta:{source:'other'}});
            await f.session.receive({doc:'doc',v:1}); await save;
            assert.strictEqual(f.session.confirmed,'XABCD');
            await f.session.receive({doc:'doc',v:1}); assert.strictEqual(f.session.version,2);
        } finally { f.session.dispose(); }
    });
    test('remote operation transforms inflight and unsaved operations without rejecting save',async()=>{
        const f=fixture();
        try {
            await f.session.edit('ABCD');
            const save=f.session.save('ABCD'); await f.tick();
            await f.session.edit('ABCDE');
            await f.session.receive({doc:'doc',v:0,op:[{p:1,i:'X'}],meta:{source:'other'}});
            assert.strictEqual(f.session.saved,'AXBCD'); assert.strictEqual(f.session.editor,'AXBCDE');
            await f.acknowledge(); await save;
            assert.strictEqual(f.session.confirmed,'AXBCD'); assert.strictEqual(f.sent.length,1);
        } finally { f.session.dispose(); }
    });
    test('one inflight operation; next saved operation waits while draft stays local',async()=>{
        const f=fixture();
        try {
            const first=f.session.save('ABCD'); await f.tick();
            await f.session.edit('ABCDE');
            const second=f.session.save('ABCDE'); await f.tick();
            await f.session.edit('ABCDEF');
            assert.strictEqual(f.sent.length,1);
            await f.acknowledge(); await first;
            assert.strictEqual(f.sent.length,2);
            await f.acknowledge(); await second;
            assert.strictEqual(f.session.confirmed,'ABCDE'); assert.strictEqual(f.session.editor,'ABCDEF');
        } finally { f.session.dispose(); }
    });
    test('duplicate echo does not apply an insertion twice',async()=>{
        const f=fixture();
        try {
            const save=f.session.save('ABCD'); await f.tick();
            const update={...f.sent[0],meta:{source:'client-a'}};
            await f.session.receive(update); await save; await f.session.receive(update);
            assert.strictEqual(f.session.confirmed,'ABCD'); assert.strictEqual(f.session.version,1);
        } finally { f.session.dispose(); }
    });
    test('version gaps and unsupported operations retain unconfirmed journal',async()=>{
        for (const update of [{doc:'doc',v:2,op:[{p:0,i:'X'}]},{doc:'doc',v:0,op:[{p:0,c:'X'}]}]) {
            const f=fixture();
            const save=f.session.save('ABCD'); const rejected=assert.rejects(save); await f.tick();
            await assert.rejects(f.session.receive(update as any)); await rejected;
            assert.ok(f.journals.at(-1)?.inflight); assert.strictEqual(f.session.confirmed,'ABC'); f.session.dispose();
        }
    });
    test('reconnect catches up an applied operation without resending it',async()=>{
        const f=fixture();
        try {
            const save=f.session.save('ABCD'); await f.tick(); const rejected=assert.rejects(save); f.session.disconnect(); await rejected; f.identity('client-b');
            await f.session.resume([{...f.sent[0],meta:{source:'client-a'}}],1,'ABCD');
            assert.strictEqual(f.sent.length,1); assert.strictEqual(f.session.confirmed,'ABCD');
        } finally { f.session.dispose(); }
    });
    test('unapplied reconnect retains original wire version and deduplication sources',async()=>{
        const f=fixture();
        const save=f.session.save('ABCD'); const rejected=assert.rejects(save); await f.tick();
        f.session.disconnect(); f.identity('client-b');
        await f.session.resume([],0,'ABC');
        assert.deepStrictEqual(f.sent[1].dupIfSource,['client-a','client-b']);
        assert.strictEqual(f.sent[1].v,0); f.session.dispose(); await rejected;
    });
    test('missing recovery history stops without resubmitting against a new version',async()=>{
        const f=fixture();
        const save=f.session.save('ABCD'); const rejected=assert.rejects(save); await f.tick(); f.session.disconnect();
        await assert.rejects(f.session.resume([],2,'unrelated'));
        assert.strictEqual(f.sent.length,1); await rejected; f.session.dispose();
    });
    test('persistence failure prevents transmission',async()=>{
        let sends=0;
        const session=OtSession.fresh('doc',0,'ABC',{source:()=> 'a',send:async()=>{sends++;},persist:async()=>{throw new Error('disk full');},changed:()=>{},log:()=>{}});
        await assert.rejects(session.save('ABCD'),/disk full/); assert.strictEqual(sends,0); session.dispose();
    });
    test('retry uses the official 5-second interval and the 45-second deadline retains intent',async()=>{
        const timers=new Map<number,()=>void>();
        const {OtSession:Session}=isolatedModule('core/ot/session',{}, {
            setTimeout:(fn:()=>void,delay:number)=>{timers.set(delay,fn);return delay;},clearTimeout:(id:number)=>timers.delete(id),
        });
        const sent:OtUpdate[]=[]; let last:OtJournal|undefined;
        const session:OtSession=Session.fresh('doc',0,'ABC',{source:()=> 'self',send:async(u:OtUpdate)=>{sent.push(u);},persist:async(j:OtJournal)=>{last=j;},changed:()=>{},log:()=>{}});
        const saved=session.save('ABCD'); const rejected=assert.rejects(saved,/45 seconds/);
        await new Promise(resolve=>setImmediate(resolve));
        assert.ok(timers.has(5000)); assert.ok(timers.has(45000));
        timers.get(5000)!(); await new Promise(resolve=>setImmediate(resolve));
        assert.strictEqual(sent.length,2); assert.deepStrictEqual(sent[1].dupIfSource,['self']);
        timers.get(45000)!(); await rejected;
        assert.ok(last?.inflight); assert.strictEqual(timers.size,0); session.dispose();
    });
    test('a persisted in-flight operation survives process recreation and is recognized in history',async()=>{
        const f=fixture();
        const save=f.session.save('ABCD'),rejected=assert.rejects(save); await f.tick();
        const journal=f.journals.at(-1)!; f.session.dispose(); await rejected;
        let sends=0;
        const recovered=new OtSession(journal,{source:()=> 'new',send:async()=>{sends++;},persist:async()=>{},changed:()=>{},log:()=>{}});
        recovered.disconnect();
        await recovered.resume([{...journal.inflight!.wire,meta:{source:'client-a'}}],1,'ABCD');
        assert.strictEqual(sends,0); assert.strictEqual(recovered.confirmed,'ABCD'); recovered.dispose();
    });
    test('OT mismatch errors do not expose document contents',()=>{
        assert.throws(()=>textOT.apply('private',[{p:0,d:'secret'}]),error=>error instanceof Error && !/private|secret/.test(error.message));
    });
    test('queued remote delete/reinsert keeps operation intent even when its final text is unchanged',async()=>{
        const f=fixture();
        try {
            const removed=f.session.receive({doc:'doc',v:0,op:[{p:1,d:'B'}],meta:{source:'other'}});
            const inserted=f.session.receive({doc:'doc',v:1,op:[{p:1,i:'B'}],meta:{source:'other'}});
            const saved=f.session.save('');
            await removed; await inserted; await f.tick();
            assert.strictEqual(f.session.saved,'B');
            await f.acknowledge(); await saved;
        } finally { f.session.dispose(); }
    });
    test('two clients converge through independently transformed server operations and compact acknowledgements',async()=>{
        for (const [base,left,right] of [['ABC','AXBC','AYBC'],['ABC','','AZBC'],['你好🙂\n','你很好🙂\n','你好🌍\n']]) {
            const wires:Record<string,OtUpdate[]>={a:[],b:[]};
            const make=(id:string)=>OtSession.fresh('doc',0,base,{source:()=>id,send:async u=>{wires[id].push(u);},persist:async()=>{},changed:()=>{},log:()=>{}});
            const a=make('a'),b=make('b');
            try {
                const first=a.save(left),second=b.save(right); await new Promise(resolve=>setImmediate(resolve));
                const aWire=wires.a[0],bWire=wires.b[0];
                let server=textOT.apply(base,aWire.op!);
                await a.receive({doc:'doc',v:0}); await b.receive({...aWire,meta:{source:'a'}});
                // Official server model transforms the later operation on the left.
                const [serverOp]=textOT.transformX(bWire.op!,aWire.op!);
                server=textOT.apply(server,serverOp);
                await b.receive({doc:'doc',v:1}); await a.receive({doc:'doc',v:1,op:serverOp,meta:{source:'b'}});
                await first; await second;
                assert.strictEqual(a.confirmed,server); assert.strictEqual(b.confirmed,server);
            } finally { a.dispose();b.dispose(); }
        }
    });
});
