/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { isolatedModule } from '../helpers/isolatedModule';
import * as network from '../../api/network';

suite('official API compatibility',()=>{
    const identity={csrfToken:'csrf',cookies:'session=test'};
    function fixture() {
        const calls:any[]=[];
        let response:any={status:200,text:async()=>JSON.stringify({status:'success',outputFiles:[]})};
        const {BaseAPI}=isolatedModule('api/base',{'./network':{...network,fetchWithPolicy:async(...args:any[])=>{calls.push(args);return response;}}});
        const api=new BaseAPI('https://overleaf.test/');
        api.getCsrfToken=async()=>identity;
        return {api,calls,respond:(value:any)=>{response=value;}};
    }
    test('cookie refresh merges all headers, replaces duplicates, deletes expired cookies and cancels the unused body',async()=>{
        const f=fixture();let cancelled=0;
        f.respond({status:200,headers:{getSetCookie:()=>['session=new; HttpOnly; Path=/','route=node2; Secure','old=; Max-Age=0','expired=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT']},body:{cancel:async()=>{cancelled++;}}});
        const result=await f.api.updateCookies({csrfToken:'csrf',cookies:'session=old; old=value; session=stale; keep=a=b; expired=y'});
        assert.strictEqual(result.cookies,'session=new; keep=a=b; route=node2');assert.strictEqual(cancelled,1);
        f.respond({status:403,headers:{getSetCookie:()=>[]},body:{cancel:async()=>{cancelled++;}}});
        await assert.rejects(()=>f.api.updateCookies({...identity}),/403/);assert.strictEqual(cancelled,2);
    });
    test('history diff query preserves spaces, reserved characters and Unicode',async()=>{
        const f=fixture(),pathname='chapters/a & b#中文+?.tex';f.respond({status:200,text:async()=>'{}'});
        await f.api.proxyToHistoryApiAndGetFileDiff(identity,'p',pathname,10,20);
        const url=new URL(f.calls[0][0]);assert.strictEqual(url.searchParams.get('pathname'),pathname);
        assert.strictEqual(url.searchParams.get('from'),'10');assert.strictEqual(url.searchParams.get('to'),'20');assert.strictEqual(url.hash,'');
    });
    test('manual and auto builds use distinct URLs, long timeout, cancellation and recovery options',async()=>{
        const f=fixture(),controller=new AbortController();
        await f.api.compile(identity,'p','main.tex',true,false,false,false,controller.signal);
        const [url,init,policy]=f.calls[0];
        assert.strictEqual(url,'https://overleaf.test/project/p/compile');
        assert.strictEqual(policy.timeoutMs,720000);
        assert.strictEqual(policy.idempotent,false);
        assert.strictEqual(init.signal,controller.signal);
        assert.strictEqual(JSON.parse(init.body).incrementalCompilesEnabled,false);
        assert.strictEqual(JSON.parse(init.body).draft,true);
        await f.api.compile(identity,'p',null,false,false,true,true);
        assert.strictEqual(new URL(f.calls[1][0]).searchParams.get('auto_compile'),'true');
        assert.strictEqual(JSON.parse(f.calls[1][1].body).incrementalCompilesEnabled,true);
    });
    test('uploads in one project are serial and a failed upload does not replay or block the next',async()=>{
        const f=fixture();let calls=0,release!:(value:any)=>void;
        f.api.request=async()=>{ calls++; if (calls===1) { return new Promise(resolve=>{release=resolve;}); } return {type:'success'}; };
        const first=f.api.uploadFile(identity,'p','folder','a.png',Buffer.from('a'));
        const next=f.api.uploadFile(identity,'p','folder','b.png',Buffer.from('b'));
        for (let i=0;i<10;i++) { await Promise.resolve(); }
        assert.strictEqual(calls,1);release({type:'error'});
        assert.strictEqual((await first).type,'error');assert.strictEqual((await next).type,'success');assert.strictEqual(calls,2);
    });
    test('document metadata sends the official broadcast flag and accepts response or broadcast mode',async()=>{
        const f=fixture();f.respond({status:200,text:async()=>'{"docId":"d","meta":{"labels":["label"],"packages":{}}}'});
        const response=await f.api.refreshDocMetadata(identity,'p','d',false);
        assert.strictEqual(f.calls[0][0],'https://overleaf.test/project/p/doc/d/metadata');
        assert.strictEqual(JSON.parse(f.calls[0][1].body).broadcast,false);
        assert.deepStrictEqual(response.meta.projectMeta.d.labels,['label']);
        f.respond({status:200,text:async()=>'OK'});
        assert.strictEqual((await f.api.refreshDocMetadata(identity,'p','d',true)).type,'success');
    });
    test('SyncTeX query preserves reserved characters and Unicode in file paths',async()=>{
        const f=fixture();
        f.respond({status:200,text:async()=>'{"pdf":[]}'});
        const file='chapters/a & b#中文.tex';
        await f.api.proxySyncCode(identity,'p',file,1,0,'build');
        const url=new URL(f.calls[0][0]);
        assert.strictEqual(url.searchParams.get('file'),file);
        assert.strictEqual(url.searchParams.get('line'),'1');
        assert.strictEqual(url.hash,'');
    });
    test('ZIP import sends a name, encodes queries and validates its result with a long transfer budget',async()=>{
        const f=fixture(),name='paper & 中文#.zip';
        f.respond({status:200,text:async()=>'{"success":true,"project_id":"project"}'});
        assert.strictEqual((await f.api.uploadProject(identity,name,Buffer.from('zip'))).message,'project');
        const [url,init,policy]=f.calls[0];
        assert.strictEqual(init.body.get('name'),name);
        assert.strictEqual(init.body.get('qqfile').name,name);
        assert.strictEqual(new URL(url).searchParams.get('qqfilename'),name);
        assert.strictEqual(new URL(url).hash,'');
        assert.strictEqual(policy.timeoutMs,600000);
        assert.strictEqual(policy.idempotent,false);
        f.respond({status:200,text:async()=>'{"success":false,"error":"Invalid ZIP"}'});
        const rejected=await f.api.uploadProject(identity,name,Buffer.from('zip'));
        assert.strictEqual(rejected.type,'error'); assert.match(rejected.message,/Invalid ZIP/);
        f.respond({status:200,text:async()=>'{"success":true}'});
        assert.strictEqual((await f.api.uploadProject(identity,name,Buffer.from('zip'))).type,'error');
        f.respond({status:200,text:async()=>'{"success":true,"entity_id":"file","entity_type":"file"}'});
        await f.api.uploadFile(identity,'p','folder','image.png',Buffer.from('image'));
        assert.strictEqual(f.calls.at(-1)[2].timeoutMs,600000);
    });
    test('login handles nested errors, redirects and missing messages without throwing',async()=>{
        const f=fixture(); let loggedIn=false;
        f.api.cookiesLogin=async()=>{loggedIn=true;return {type:'success'};};
        for (const status of [200,401]) {
            f.respond({status,json:async()=>({message:{text:'Invalid credentials'}})});
            assert.strictEqual((await f.api.passportLogin('email','password')).message,'Invalid credentials');
        }
        f.respond({status:200,json:async()=>({redir:'/login/reconfirm'})});
        assert.match((await f.api.passportLogin('email','password')).message,/Additional login step/);
        f.respond({status:200,json:async()=>({})});
        assert.match((await f.api.passportLogin('email','password')).message,/Login failed/);
        f.respond({status:200,headers:{getSetCookie:()=>['session=new']},json:async()=>({redir:'/project'})});
        assert.strictEqual((await f.api.passportLogin('email','password')).type,'success');
        assert.strictEqual(loggedIn,true);
        loggedIn=false;
        f.respond({status:302,headers:{get:()=>'/project',getSetCookie:()=>['session=new']},text:async()=>''});
        await f.api.passportLogin('email','password');
        assert.strictEqual(loggedIn,true);
    });
});
