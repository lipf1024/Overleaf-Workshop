/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

suite('PDF preview loading lifecycle',()=>{
    function fixture() {
        const elements:any[]=[];
        const element=()=>{
            const classes=new Set<string>();
            const node:any={id:'',hidden:false,textContent:'',scrollLeft:0,scrollTop:0,
                append:()=>{},setAttribute:()=>{},classList:{toggle:(name:string,on:boolean)=>on?classes.add(name):classes.delete(name)},classes};
            elements.push(node); return node;
        };
        const container=element(); container.id='viewerContainer';
        const listeners=new Map<string,Function>(),events=new Map<string,Function>();
        const page={};
        const app:any={initializedPromise:Promise.resolve(),_boundEvents:{},
            eventBus:{_off:()=>{},_on:()=>{},on:(name:string,fn:Function)=>events.set(name,fn)},
            pdfViewer:{getPageView:()=>page,currentScaleValue:'auto'},pdfSidebar:{visibleView:0},
            load:(doc:any)=>{app.pdfDocument=doc;},isViewerEmbedded:false};
        let resolve!:(value:any)=>void,reject!:(error:Error)=>void;
        const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
        const timers=new Map<number,Function>();
        const posted:any[]=[],ranges:any[]=[];let parameters:any,destroyed=0;
        class RangeTransport {
            constructor(readonly length:number,readonly initialData:Uint8Array) {}
            onDataRange(begin:number,data:Uint8Array):void { ranges.push({begin,data:[...data]}); }
        }
        const context={document:{createElement:element,getElementById:(id:string)=>elements.find(n=>n.id===id),body:element()},
            window:{addEventListener:(name:string,fn:Function)=>listeners.set(name,fn)},
            acquireVsCodeApi:()=>({getState:()=>undefined,setState:()=>{},postMessage:(message:any)=>posted.push(message)}),
            PDFViewerApplication:app,pdfjsLib:{PDFDataRangeTransport:RangeTransport,getDocument:(params:any)=>{parameters=params;return {promise,destroy:async()=>{destroyed++;}};}},console:{log:()=>{}},
            setTimeout:(fn:Function)=>{timers.set(1,fn);return 1;},clearTimeout:(id:number)=>timers.delete(id)};
        vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../../views/pdf-viewer/index.js'),'utf8'),context);
        return {app,page,resolve,reject,timers,posted,ranges,parameters:()=>parameters,destroyed:()=>destroyed,
            start:async()=>{await listeners.get('load')!();await Promise.resolve();},
            send:async(data:any)=>{await listeners.get('message')!({data});await Promise.resolve();},
            render:(source:any)=>events.get('pagerendered')!({source,pageNumber:1}),
            doubleClick:(target:any)=>listeners.get('dblclick')!({target}),
            overlay:()=>elements.find(n=>n.id==='overleaf-progress'),
            label:()=>elements.find(n=>n.id==='overleaf-progress-label').textContent};
    }

    test('range bridge forwards only matching chunks and reports download failures',async()=>{
        const f=fixture();await f.start();
        await f.send({type:'update',sourceId:7,content:new Uint8Array([1,2]),range:{length:100,chunkSize:65536}});
        const params=f.parameters();assert.strictEqual(params.disableAutoFetch,true);assert.strictEqual(params.disableStream,true);
        assert.strictEqual(params.data,undefined);params.range.requestDataRange(10,12);
        const request=f.posted.at(-1);assert.strictEqual(request.type,'pdfRange');assert.strictEqual(request.sourceId,7);
        await f.send({type:'pdfRange',sourceId:6,requestId:request.requestId,begin:10,content:new Uint8Array([3,4])});
        assert.strictEqual(f.ranges.length,0);
        await f.send({type:'pdfRange',sourceId:7,requestId:request.requestId,begin:10,content:new Uint8Array([3,4])});
        assert.deepStrictEqual(f.ranges,[{begin:10,data:[3,4]}]);
        params.range.requestDataRange(20,22);const failed=f.posted.at(-1);
        await f.send({type:'pdfRangeError',sourceId:7,requestId:failed.requestId});
        assert.match(f.label(),/download failed/);assert.strictEqual(f.destroyed(),1);assert.strictEqual(f.overlay().classes.has('busy'),false);
    });

    test('keeps waiting until the new PDF renders, ignoring old page render events',async()=>{
        const f=fixture(); await f.start();
        await f.send({type:'compileState',busy:true,message:'Compiling PDF…'});
        assert.strictEqual(f.overlay().hidden,false);
        const old={}; f.app.pdfDocument=old;
        await f.send({type:'update',content:new Uint8Array([1])});
        f.render(f.page); assert.strictEqual(f.app.pdfDocument,old);
        await f.send({type:'compileState',busy:false,message:''});
        assert.strictEqual(f.overlay().hidden,false);
        const doc={}; f.resolve(doc); await new Promise(resolve=>setImmediate(resolve));
        assert.strictEqual(f.app.pdfDocument,doc);
        f.render({}); assert.strictEqual(f.overlay().hidden,false);
        f.render(f.page); assert.strictEqual(f.overlay().hidden,true);
        assert.strictEqual(f.timers.size,0);
        assert.doesNotThrow(()=>f.doubleClick({closest:()=>null}));
    });

    test('a PDF parse failure stops the spinner and leaves the old PDF loaded',async()=>{
        const f=fixture(); await f.start(); const old={}; f.app.pdfDocument=old;
        await f.send({type:'update',content:new Uint8Array([1])});
        f.reject(new Error('bad PDF')); await new Promise(resolve=>setImmediate(resolve));
        assert.strictEqual(f.app.pdfDocument,old);
        assert.strictEqual(f.overlay().classes.has('busy'),false);
        assert.match(f.label(),/failed/); assert.strictEqual(f.timers.size,0);
        await f.send({type:'compileState',busy:false,message:''});
        assert.match(f.label(),/failed/);
        assert.strictEqual(f.overlay().hidden,false);
    });
});
