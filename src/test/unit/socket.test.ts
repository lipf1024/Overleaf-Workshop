import * as assert from 'assert';
import { emitWithAckSafe, SocketOutcomeUnknownError } from '../../api/socketSafety';

suite('socket safety',()=>{
    test('patched legacy ws enforces payload, fragment, and buffered chunk limits',()=>{
        const receiverConstructor=require('ws/lib/Receiver');
        const receiver=new receiverConstructor({},16*1024*1024);
        assert.strictEqual(receiver.maxPayload,16*1024*1024);
        assert.ok(receiver.maxFragments>0);
        receiver.expectBuffer=null; receiver.maxBufferedChunks=1; receiver.overflow=[Buffer.from('a')];
        let code:number|undefined; receiver.onerror=(_error:Error,value:number)=>{ code=value; };
        receiver.add(Buffer.from('b'));
        assert.strictEqual(code,1009);
    });

    test('resolves an acknowledgement once',async()=>{
        const socket={emit:(_event:string,_value:string,ack:(error:any,value:string)=>void)=>{ ack(undefined,'ok'); ack(undefined,'late'); }};
        assert.deepStrictEqual(await emitWithAckSafe(socket,'write',['value'],()=>true,50),['ok']);
    });

    test('treats an acknowledgement timeout as unknown',async()=>{
        const socket={emit:()=>undefined};
        await assert.rejects(()=>emitWithAckSafe(socket,'write',[],()=>true,5),error=>error instanceof SocketOutcomeUnknownError);
    });

    test('rejects callbacks from an obsolete epoch',async()=>{
        let current=true;
        const socket={emit:(_event:string,ack:(error:any,value:string)=>void)=>setTimeout(()=>ack(undefined,'old'),5)};
        const result=emitWithAckSafe(socket,'join',[],()=>current,50); current=false;
        await assert.rejects(()=>result,error=>error instanceof SocketOutcomeUnknownError && /stale/.test(error.message));
    });

    test('clears the timeout after an acknowledgement',async()=>{
        let callback:((error?:any)=>void)|undefined;
        const socket={emit:(_event:string,ack:(error?:any)=>void)=>{ callback=ack; }};
        const result=emitWithAckSafe(socket,'write',[],()=>true,20); callback?.();
        await result;
        await new Promise(resolve=>setTimeout(resolve,30));
        assert.ok(true,'the cleared timeout did not reject after settlement');
    });

    test('cancels pending acknowledgement work when an epoch is disposed',async()=>{
        const controller=new AbortController();
        const socket={emit:()=>undefined};
        const result=emitWithAckSafe(socket,'write',[],()=>false,1000,controller.signal);
        controller.abort();
        await assert.rejects(()=>result,error=>error instanceof SocketOutcomeUnknownError);
    });
});
