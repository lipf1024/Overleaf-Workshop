/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { OtSession, OtUpdate } from '../../core/ot/session';
import { OtEditor } from '../../core/ot/editor';

suite('OT editor presentation',()=>{
    function fixture() {
        let content='ABC',version=1,dirty=false,applications=0;
        const listeners=new Set<(event:any)=>void>(),sent:OtUpdate[]=[];
        const doc:any={uri:{toString:()=> 'file:///main.tex'},getText:()=>content,positionAt:(n:number)=>n,
            get version(){return version;},get isDirty(){return dirty;},isClosed:false};
        const change=(text:string,isDirty=true)=>{content=text;version++;dirty=isDirty;listeners.forEach(listener=>listener({document:doc,contentChanges:[{}]}));};
        const platform:any={Range:class {},WorkspaceEdit:class {text='';replace(_uri:any,_range:any,text:string){this.text=text;}},workspace:{
            onDidChangeTextDocument:(fn:any)=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};},
            applyEdit:async(edit:any)=>{applications++;change(edit.text);return true;},
        }};
        let binding:OtEditor|undefined;
        const errors:Error[]=[];
        const session=OtSession.fresh('doc',0,'ABC',{source:()=> 'self',send:async u=>{sent.push(u);},persist:async()=>{},
            changed:()=>{void binding?.refresh().catch(()=>undefined);},log:()=>{}});
        binding=new OtEditor(doc,session,e=>errors.push(e),platform);
        const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
        return {doc,session,binding,errors,sent,change,tick,applications:()=>applications,close:()=>{binding?.dispose();session.dispose();}};
    }
    test('remote updates preserve dirty content without uploading it or generating an edit loop',async()=>{
        const f=fixture();
        try {
            f.change('ABCD'); await f.tick();
            await f.session.receive({doc:'doc',v:0,op:[{p:1,i:'X'}],meta:{source:'other'}}); await f.tick();
            assert.strictEqual(f.doc.getText(),'AXBCD'); assert.strictEqual(f.doc.isDirty,true);
            assert.strictEqual(f.session.saved,'AXBC'); assert.strictEqual(f.sent.length,0); assert.strictEqual(f.applications(),1);
            assert.deepStrictEqual(f.errors,[]);
        } finally { f.close(); }
    });
    test('clean remote-only updates use file reload without creating a dirty editor',async()=>{
        const f=fixture();
        try {
            await f.session.receive({doc:'doc',v:0,op:[{p:1,i:'X'}],meta:{source:'other'}}); await f.tick();
            assert.strictEqual(f.applications(),0);
            f.change('AXBC',false); await f.tick();
            assert.strictEqual(f.doc.isDirty,false); assert.strictEqual(f.sent.length,0); assert.strictEqual(f.session.editor,'AXBC');
        } finally { f.close(); }
    });
    test('rapid typing is not duplicated and undo remains a local operation until saving',async()=>{
        const f=fixture();
        try {
            f.change('ABCD'); f.change('ABCDE'); await f.tick();
            assert.strictEqual(f.session.editor,'ABCDE');
            f.change('ABCD'); await f.tick();
            assert.strictEqual(f.session.editor,'ABCD'); assert.strictEqual(f.sent.length,0);
        } finally { f.close(); }
    });
});
