/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import * as path from 'path';
import { Dispatcher, getGlobalDispatcher, MockAgent, MockPool, setGlobalDispatcher } from 'undici';
import { PdfByteSource, PDF_CHUNK_SIZE } from '../../api/pdfByteSource';

function pdfFixture():Buffer {
    const objects=[
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Length 36 >>\nstream\nBT /F1 12 Tf 10 700 Td (Hello) Tj ET\nendstream',
        `<< /Length 2097152 >>\nstream\n${' '.repeat(2097152)}\nendstream`,
    ];
    let result='%PDF-1.7\n';const offsets=[0];
    objects.forEach((body,index)=>{offsets.push(Buffer.byteLength(result));result+=`${index+1} 0 obj\n${body}\nendobj\n`;});
    const xref=Buffer.byteLength(result);
    result+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) { result+=`${String(offset).padStart(10,'0')} 00000 n \n`; }
    result+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(result);
}

suite('PDF range transport',()=>{
    let original:Dispatcher,agent:MockAgent,pool:MockPool;
    setup(()=>{original=getGlobalDispatcher();agent=new MockAgent();agent.disableNetConnect();setGlobalDispatcher(agent);pool=agent.get('https://pdf.test');});
    teardown(async()=>{await agent.close();setGlobalDispatcher(original);});
    const bytes=pdfFixture();
    function chunk(begin:number,end:number,etag='"build-1"',status=206) {
        pool.intercept({path:'/output.pdf',method:'GET',headers:{range:`bytes=${begin}-${end-1}`}})
            .reply(status,bytes.subarray(begin,end),{headers:{'content-range':`bytes ${begin}-${end-1}/${bytes.length}`,etag,'content-length':String(end-begin)}});
    }
    test('opens with only one chunk, merges overlapping reads, caches blocks and checks If-Range',async()=>{
        chunk(0,PDF_CHUNK_SIZE);
        const source=await PdfByteSource.open('https://pdf.test/output.pdf',{});
        try {
            assert.strictEqual(source.ranged,true);assert.strictEqual(source.initialData.length,PDF_CHUNK_SIZE);
            pool.intercept({path:'/output.pdf',headers:{range:`bytes=${PDF_CHUNK_SIZE}-${2*PDF_CHUNK_SIZE-1}`,'if-range':'"build-1"'}})
                .reply(206,bytes.subarray(PDF_CHUNK_SIZE,2*PDF_CHUNK_SIZE),{headers:{'content-range':`bytes ${PDF_CHUNK_SIZE}-${2*PDF_CHUNK_SIZE-1}/${bytes.length}`,etag:'"build-1"'}});
            const [a,b]=await Promise.all([source.read(0,2*PDF_CHUNK_SIZE),source.read(PDF_CHUNK_SIZE,2*PDF_CHUNK_SIZE)]);
            assert.deepStrictEqual(Buffer.from(a),bytes.subarray(0,2*PDF_CHUNK_SIZE));assert.strictEqual(b.length,PDF_CHUNK_SIZE);
            await source.read(PDF_CHUNK_SIZE+1,PDF_CHUNK_SIZE+20);agent.assertNoPendingInterceptors();
        } finally { source.dispose(); }
    });
    test('real PDF.js reads the first page without downloading the entire PDF',async()=>{
        let downloaded=0,requests=0;
        pool.intercept({path:'/output.pdf',method:'GET'}).reply(options=>{
            const raw:any=options.headers;
            const entries:[string,string][]=Array.isArray(raw)?raw.reduce((pairs:[string,string][],value:string,index:number)=>{if(index%2===0){pairs.push([value,raw[index+1]]);}return pairs;},[]):typeof raw?.entries==='function'?[...raw.entries()]:Object.entries(raw??{});
            const headers=new Map(entries.map(([key,value])=>[key.toLowerCase(),value]));
            const range=/bytes=(\d+)-(\d+)/.exec(headers.get('range')??'')!;
            assert.ok(range,'every request must be a range');
            const begin=Number(range[1]),end=Math.min(Number(range[2])+1,bytes.length),part=bytes.subarray(begin,end);
            downloaded+=part.length;requests++;
            return {statusCode:206,data:part,responseOptions:{headers:{'content-range':`bytes ${begin}-${end-1}/${bytes.length}`,etag:'"build-1"'}}};
        }).persist();
        const source=await PdfByteSource.open('https://pdf.test/output.pdf',{});
        const pdfjs=require(path.resolve(__dirname,'../../../views/pdf-viewer/vendor/build/pdf.js'));
        const transport=new pdfjs.PDFDataRangeTransport(source.length,source.initialData.slice(),true);
        let failure:unknown;
        transport.requestDataRange=(begin:number,end:number)=>{void source.read(begin,end).then(data=>transport.onDataRange(begin,data)).catch(error=>{failure=error;});};
        transport.abort=()=>source.dispose();
        const task=pdfjs.getDocument({range:transport,length:source.length,rangeChunkSize:PDF_CHUNK_SIZE,disableStream:true,disableAutoFetch:true,useSystemFonts:true,disableFontFace:true});
        try {
            const doc=await task.promise;assert.strictEqual(doc.numPages,1);
            const page=await doc.getPage(1);const text=await page.getTextContent();
            assert.ok(text.items.some((item:any)=>item.str==='Hello'));
            assert.strictEqual(failure,undefined);assert.ok(downloaded<bytes.length/2,`${downloaded}/${bytes.length}`);
            assert.ok(requests>=2);console.log(`PDF first-page fixture: ${downloaded}/${bytes.length} bytes, ${requests} range requests`);
        } finally { await task.destroy();source.dispose(); }
    });
    test('a failed block retries only that block, preserving the initial block',async()=>{
        chunk(0,PDF_CHUNK_SIZE);const source=await PdfByteSource.open('https://pdf.test/output.pdf',{});
        pool.intercept({path:'/output.pdf',headers:{range:`bytes=${PDF_CHUNK_SIZE}-${2*PDF_CHUNK_SIZE-1}`}}).reply(503,'busy',{headers:{'retry-after':'0'}});
        chunk(PDF_CHUNK_SIZE,2*PDF_CHUNK_SIZE);
        try {assert.strictEqual((await source.read(0,2*PDF_CHUNK_SIZE)).length,2*PDF_CHUNK_SIZE);agent.assertNoPendingInterceptors();}
        finally {source.dispose();}
    });
    test('closing a preview aborts an in-progress range request without retry',async()=>{
        chunk(0,PDF_CHUNK_SIZE);const controller=new AbortController();
        const source=await PdfByteSource.open('https://pdf.test/output.pdf',{},controller.signal);
        pool.intercept({path:'/output.pdf'}).reply(206,bytes.subarray(PDF_CHUNK_SIZE,2*PDF_CHUNK_SIZE),{headers:{'content-range':`bytes ${PDF_CHUNK_SIZE}-${2*PDF_CHUNK_SIZE-1}/${bytes.length}`,etag:'"build-1"'}}).delay(200);
        const pending=source.read(PDF_CHUNK_SIZE,2*PDF_CHUNK_SIZE);setTimeout(()=>controller.abort(),5);
        await assert.rejects(()=>pending);assert.strictEqual(source.isDisposed,true);agent.assertNoPendingInterceptors();
    });
    test('a server ignoring Range falls back once to a cached full response',async()=>{
        pool.intercept({path:'/output.pdf'}).reply(200,bytes,{headers:{'content-length':String(bytes.length)}});
        const source=await PdfByteSource.open('https://pdf.test/output.pdf',{});
        try {assert.strictEqual(source.ranged,false);assert.deepStrictEqual(Buffer.from(await source.read(0,16)),bytes.subarray(0,16));agent.assertNoPendingInterceptors();}
        finally {source.dispose();}
    });
    test('a changed validator is rejected instead of mixing PDF builds',async()=>{
        chunk(0,PDF_CHUNK_SIZE);const source=await PdfByteSource.open('https://pdf.test/output.pdf',{});
        chunk(PDF_CHUNK_SIZE,2*PDF_CHUNK_SIZE,'"build-2"');
        await assert.rejects(()=>source.read(PDF_CHUNK_SIZE,2*PDF_CHUNK_SIZE),/changed/);source.dispose();
    });
    test('a missing validator falls back to a full verified download and disposal cancels reads',async()=>{
        pool.intercept({path:'/output.pdf'}).reply(206,bytes.subarray(0,PDF_CHUNK_SIZE),{headers:{'content-range':`bytes 0-${PDF_CHUNK_SIZE-1}/${bytes.length}`}});
        pool.intercept({path:'/output.pdf'}).reply(200,bytes,{headers:{'content-length':String(bytes.length)}});
        const source=await PdfByteSource.open('https://pdf.test/output.pdf',{});assert.strictEqual(source.ranged,false);source.dispose();
        await assert.rejects(()=>source.read(0,10));agent.assertNoPendingInterceptors();
    });
});
