/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { gzipSync, brotliCompressSync, deflateSync } from 'zlib';
import { Dispatcher, getGlobalDispatcher, MockAgent, MockPool, Request, setGlobalDispatcher } from 'undici';
import { createFileUploadFormData, downloadBytes, fetchWithPolicy, NetworkRequestError } from '../../api/network';

suite('network safety',()=>{
    let agent:MockAgent;
    let pool:MockPool;
    let original:Dispatcher;

    setup(()=>{
        original=getGlobalDispatcher();
        agent=new MockAgent(); agent.disableNetConnect();
        setGlobalDispatcher(agent);
        pool=agent.get('http://overleaf.test');
    });

    teardown(async()=>{ await agent.close(); setGlobalDispatcher(original); });

    test('classifies missing and login redirects without producing bytes',async()=>{
        pool.intercept({path:'/missing',method:'GET'}).reply(404);
        pool.intercept({path:'/login',method:'GET'}).reply(302,'',{headers:{location:'/login'}});
        await assert.rejects(()=>downloadBytes('http://overleaf.test/missing',{}, {maxRetries:0}),error=>error instanceof NetworkRequestError && error.kind==='not-found');
        await assert.rejects(()=>downloadBytes('http://overleaf.test/login',{}, {maxRetries:0}),error=>error instanceof NetworkRequestError && error.kind==='auth-required');
    });

    test('download cancellation aborts promptly without a retry and custom timeouts remain effective',async()=>{
        const controller=new AbortController();
        pool.intercept({path:'/cancel',method:'GET'}).reply(200,'pdf').delay(100);
        const pending=downloadBytes('http://overleaf.test/cancel',{}, {signal:controller.signal});
        setTimeout(()=>controller.abort(),5);
        await assert.rejects(()=>pending);
        pool.intercept({path:'/timeout',method:'GET'}).reply(200,'pdf').delay(100);
        await assert.rejects(()=>downloadBytes('http://overleaf.test/timeout',{}, {timeoutMs:5,maxRetries:0}));
        pool.intercept({path:'/slow',method:'GET'}).reply(200,'pdf').delay(20);
        assert.strictEqual(Buffer.from(await downloadBytes('http://overleaf.test/slow')).toString(),'pdf');
        agent.assertNoPendingInterceptors();
    });

    test('downloads contiguous ranges exactly once',async()=>{
        pool.intercept({path:'/segments',method:'GET'}).reply(206,'abc',{headers:{'content-range':'bytes 0-2/6',etag:'one','content-length':'3'}});
        pool.intercept({path:'/segments',method:'GET',headers:{range:'bytes=3-','if-range':'one'}}).reply(206,'def',{headers:{'content-range':'bytes 3-5/6',etag:'one','content-length':'3'}});
        assert.strictEqual(Buffer.from(await downloadBytes('http://overleaf.test/segments',{}, {maxRetries:0})).toString(),'abcdef');
        assert.strictEqual(agent.pendingInterceptors().length,0);
    });

    test('rejects inconsistent ranges and timeouts',async()=>{
        pool.intercept({path:'/bad-range',method:'GET'}).reply(206,'cd',{headers:{'content-range':'bytes 2-3/4','content-length':'2'}});
        await assert.rejects(()=>downloadBytes('http://overleaf.test/bad-range',{}, {maxRetries:0}),error=>error instanceof NetworkRequestError && error.kind==='fatal-error');
        pool.intercept({path:'/slow',method:'GET'}).reply(200,'x').delay(100);
        await assert.rejects(()=>downloadBytes('http://overleaf.test/slow',{}, {maxRetries:0,timeoutMs:20}),error=>error instanceof NetworkRequestError && error.kind==='offline');
    });

    test('rejects an ETag that appears or disappears between range responses',async()=>{
        pool.intercept({path:'/etag-appears',method:'GET'}).reply(206,'ab',{headers:{'content-range':'bytes 0-1/4'}});
        pool.intercept({path:'/etag-appears',method:'GET',headers:{range:'bytes=2-'}}).reply(206,'cd',{headers:{'content-range':'bytes 2-3/4',etag:'new'}});
        await assert.rejects(()=>downloadBytes('http://overleaf.test/etag-appears',{}, {maxRetries:0}),error=>error instanceof NetworkRequestError && error.kind==='transient-error');

        pool.intercept({path:'/etag-disappears',method:'GET'}).reply(206,'ab',{headers:{'content-range':'bytes 0-1/4',etag:'old'}});
        pool.intercept({path:'/etag-disappears',method:'GET',headers:{range:'bytes=2-','if-range':'old'}}).reply(206,'cd',{headers:{'content-range':'bytes 2-3/4'}});
        await assert.rejects(()=>downloadBytes('http://overleaf.test/etag-disappears',{}, {maxRetries:0}),error=>error instanceof NetworkRequestError && error.kind==='transient-error');
    });

    test('rejects a truncated complete response',async()=>{
        pool.intercept({path:'/truncated',method:'GET'}).reply(200,'abc',{headers:{'content-length':'9'}});
        await assert.rejects(()=>downloadBytes('http://overleaf.test/truncated',{}, {maxRetries:0}),error=>error instanceof NetworkRequestError && error.kind==='transient-error');
    });

    test('B11: valid compressed responses use encoded and decoded lengths correctly',async()=>{
        const original=Buffer.from('中文 é 😀 decoded content\n'.repeat(20));
        for (const [encoding,compress] of [['gzip',gzipSync],['br',brotliCompressSync],['deflate',deflateSync]] as const) {
            const encoded=compress(original);
            pool.intercept({path:'/compressed-'+encoding,method:'GET',headers:{'accept-encoding':'identity'}}).reply(200,encoded,{headers:{'content-encoding':encoding,'content-length':String(encoded.length)}});
            assert.deepStrictEqual(Buffer.from(await downloadBytes('http://overleaf.test/compressed-'+encoding,{}, {maxRetries:0})),original);
        }
    });
    test('B11: corrupt compression still fails instead of producing partial bytes',async()=>{
        const encoded=gzipSync(Buffer.from('important content')).subarray(0,12);
        pool.intercept({path:'/broken-gzip',method:'GET'}).reply(200,encoded,{headers:{'content-encoding':'gzip','content-length':String(encoded.length)}});
        await assert.rejects(()=>downloadBytes('http://overleaf.test/broken-gzip',{}, {maxRetries:0}));
    });
    test('B11: compressed ranges are retried as one complete download',async()=>{
        const content=Buffer.from('complete'),encoded=gzipSync(content);
        pool.intercept({path:'/compressed-range',method:'GET'}).reply(206,encoded,{headers:{'content-encoding':'gzip','content-range':`bytes 0-${encoded.length-1}/${encoded.length}`}});
        pool.intercept({path:'/compressed-range',method:'GET'}).reply(200,encoded,{headers:{'content-encoding':'gzip','content-length':String(encoded.length)}});
        assert.deepStrictEqual(Buffer.from(await downloadBytes('http://overleaf.test/compressed-range',{}, {maxRetries:0})),content);
        assert.strictEqual(agent.pendingInterceptors().length,0);
    });

    test('multipart uses a generated boundary and preserves original bytes',async()=>{
        const bytes=new Uint8Array([0,1,2,255]);
        const request=new Request('http://overleaf.test/upload',{method:'POST',body:createFileUploadFormData('folder','figure.bin','application/octet-stream',bytes)});
        const encoded=Buffer.from(await request.arrayBuffer());
        assert.match(request.headers.get('content-type')??'',/^multipart\/form-data; boundary=/);
        assert.ok(encoded.includes(Buffer.from('filename="figure.bin"')));
        assert.ok(encoded.includes(Buffer.from(bytes)));
        assert.notStrictEqual(encoded.toString(),'[object FormData]');
    });

    test('does not replay a mutation after a 500 response',async()=>{
        pool.intercept({path:'/error',method:'POST',body:'x'}).reply(500,'failed');
        const response=await fetchWithPolicy('http://overleaf.test/error',{method:'POST',body:'x'},{idempotent:false});
        await response.text();
        assert.strictEqual(agent.pendingInterceptors().length,0);
    });
});
