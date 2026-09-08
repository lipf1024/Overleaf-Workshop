import { File } from 'node:buffer';
import { fetch, FormData, Headers, request, RequestInit, Response } from 'undici';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';

export type NetworkErrorKind = 'offline' | 'auth-required' | 'not-found' | 'transient-error' | 'fatal-error' | 'unknown-outcome';

export class NetworkRequestError extends Error {
    constructor(
        readonly kind:NetworkErrorKind,
        message:string,
        readonly statusCode?:number,
    ) {
        super(message);
        this.name='NetworkRequestError';
    }
}

export interface FetchPolicy {
    signal?:AbortSignal;
    idempotent?:boolean;
    timeoutMs?:number;
    maxRetries?:number;
}

const DEFAULT_TIMEOUT_MS=15000;
export const TRANSFER_TIMEOUT_MS=10*60*1000;

export function createFileUploadFormData(parentFolderId:string,filename:string,mimeType:string,content:Uint8Array):FormData {
    const form=new FormData();
    form.append('targetFolderId',parentFolderId);
    form.append('name',filename);
    form.append('type',mimeType);
    form.append('qqfile',new File([content],filename,{type:mimeType}));
    return form;
}

export async function fetchWithPolicy(url:string,init:RequestInit={},policy:FetchPolicy={}):Promise<Response> {
    const idempotent=policy.idempotent ?? (init.method===undefined || init.method==='GET' || init.method==='HEAD');
    const maxRetries=idempotent ? policy.maxRetries ?? 2 : 0;
    for (let attempt=0;;attempt++) {
        const timeoutSignal=AbortSignal.timeout(policy.timeoutMs??DEFAULT_TIMEOUT_MS);
        const callerSignal=init.signal??policy.signal;
        callerSignal?.throwIfAborted();
        const signal=callerSignal ? (AbortSignal as any).any([callerSignal,timeoutSignal]) : timeoutSignal;
        try {
            const response=await fetch(url,{...init,signal});
            if (idempotent && isRetryableStatus(response.status) && attempt<maxRetries) {
                const retryAfter=response.headers.get('retry-after');
                await response.body?.cancel().catch(()=>undefined);
                await delay(retryDelay(attempt,retryAfter),callerSignal);
                continue;
            }
            return response;
        } catch (error:any) {
            if (!callerSignal?.aborted && idempotent && attempt<maxRetries && isNetworkFailure(error)) {
                await delay(retryDelay(attempt),callerSignal);
                continue;
            }
            throw asNetworkError(error,idempotent,timeoutSignal.aborted);
        }
    }
}

export async function downloadBytes(url:string,headers:Record<string,string>={},policy:FetchPolicy={}):Promise<Uint8Array> {
    const maxRetries=policy.maxRetries??2;
    for (let attempt=0;;attempt++) {
        policy.signal?.throwIfAborted();
        try { return await downloadBytesOnce(url,headers,policy.timeoutMs??TRANSFER_TIMEOUT_MS,false,policy.signal); }
        catch (error) {
            const network=asNetworkError(error,true);
            if (policy.signal?.aborted || attempt>=maxRetries || (network.kind!=='offline' && network.kind!=='transient-error')) { throw network; }
            await delay(retryDelay(attempt),policy.signal);
        }
    }
}

const decompressGzip=promisify(gunzip);
const decompressBrotli=promisify(brotliDecompress);
const decompressDeflate=promisify(inflate);

async function decodeDownload(bytes:Uint8Array,encoding:string|null):Promise<Uint8Array> {
    const encodings=(encoding??'identity').toLowerCase().split(',').map(value=>value.trim()).reverse();
    for (const codec of encodings) {
        try {
            switch (codec) {
                case '': case 'identity': break;
                case 'gzip': case 'x-gzip': bytes=await decompressGzip(bytes); break;
                case 'br': bytes=await decompressBrotli(bytes); break;
                case 'deflate': bytes=await decompressDeflate(bytes); break;
                default: throw new NetworkRequestError('fatal-error',`Unsupported download encoding: ${codec}`);
            }
        } catch (error) {
            if (error instanceof NetworkRequestError) { throw error; }
            throw new NetworkRequestError('transient-error','Compressed download is truncated or corrupt');
        }
    }
    return bytes;
}

async function downloadBytesOnce(url:string,headers:Record<string,string>,timeoutMs?:number,restartedForEncoding=false,callerSignal?:AbortSignal):Promise<Uint8Array> {
    callerSignal?.throwIfAborted();
    const timeoutSignal=AbortSignal.timeout(timeoutMs??TRANSFER_TIMEOUT_MS);
    const signal=callerSignal?(AbortSignal as any).any([callerSignal,timeoutSignal]):timeoutSignal;
    const chunks:Uint8Array[]=[];
    let offset=0,total:number|undefined,etag:string|undefined;
    for (;;) {
        const downloadHeaders=Object.fromEntries(Object.entries(headers).map(([name,value])=>[name.toLowerCase(),value]));
        downloadHeaders['accept-encoding']='identity';
        if (offset) {
            downloadHeaders.range=`bytes=${offset}-`;
            if (etag!==undefined) { downloadHeaders['if-range']=etag; }
        }
        signal.throwIfAborted();
        try {
            // request() exposes the wire bytes. fetch() decompresses permissively and can
            // accept incomplete gzip streams, losing both length and checksum evidence.
            const response=await request(url,{method:'GET',headers:downloadHeaders,signal});
            const status=response.statusCode,responseHeaders=new Headers();
            for (const [name,value] of Object.entries(response.headers)) {
                if (value!==undefined) { responseHeaders.set(name,Array.isArray(value)?value.join(','):value); }
            }
            if (status===404 || status===401 || status===403 || isRedirect(status)) {
                response.body.destroy();
                throw new NetworkRequestError(classifyResponseStatus(status),status===404?'Remote file was not found':`Authentication required (${status})`,status);
            }
            if (status!==200 && status!==206) {
                const message=await response.body.text().catch(()=>`HTTP ${status}`);
                throw new NetworkRequestError(classifyResponseStatus(status),`${status}: ${message}`,status);
            }
            const encoding=responseHeaders.get('content-encoding');
            const encoded=!!encoding && encoding.toLowerCase()!=='identity';
            if (status===206 && encoded) {
                response.body.destroy();
                if (restartedForEncoding) { throw new NetworkRequestError('fatal-error','Compressed ranged downloads are not supported by this server'); }
                const fullHeaders=Object.fromEntries(Object.entries(headers).filter(([name])=>!['range','if-range'].includes(name.toLowerCase())));
                return downloadBytesOnce(url,fullHeaders,timeoutMs,true,callerSignal);
            }
            const wireBytes=new Uint8Array(await response.body.arrayBuffer());
            validateLength(responseHeaders,wireBytes.byteLength);
            if (status===200) {
                if (offset!==0) { throw new NetworkRequestError('fatal-error','Server ignored a continuation range request'); }
                return decodeDownload(wireBytes,encoding);
            }
            const range=parseContentRange(responseHeaders.get('content-range'));
            if (!range || range.start!==offset || range.end-range.start+1!==wireBytes.byteLength) {
                throw new NetworkRequestError('fatal-error','Invalid or inconsistent Content-Range response');
            }
            const responseEtag=responseHeaders.get('etag')??undefined;
            if (total!==undefined && (range.total!==total || responseEtag!==etag)) {
                throw new NetworkRequestError('transient-error','Remote file changed during ranged download');
            }
            total=range.total; etag=responseEtag; chunks.push(wireBytes); offset=range.end+1;
            if (offset===total) { return concat(chunks,total); }
            if (offset>total || wireBytes.byteLength===0) { throw new NetworkRequestError('fatal-error','Incomplete ranged download'); }
        } catch (error) { throw asNetworkError(error,true,signal.aborted); }
    }
}

export function classifyResponseStatus(status:number):NetworkErrorKind {
    if (status===404) { return 'not-found'; }
    if (status===401 || status===403 || isRedirect(status)) { return 'auth-required'; }
    if (status===429 || status>=500) { return 'transient-error'; }
    return 'fatal-error';
}

export function asNetworkError(error:unknown,idempotent:boolean,timedOut=false):NetworkRequestError {
    if (error instanceof NetworkRequestError) { return error; }
    const value=error as any;
    if (value?.code==='UND_ERR_RES_CONTENT_LENGTH_MISMATCH') { return new NetworkRequestError('transient-error','Downloaded response was truncated'); }
    const network=timedOut || isNetworkFailure(value);
    return new NetworkRequestError(network?(idempotent?'offline':'unknown-outcome'):'fatal-error',timedOut?'Request timed out':value?.message??String(value));
}

function validateLength(headers:Headers,actual:number):void {
    const declared=headers.get('content-length');
    if (declared!==null && Number(declared)!==actual) { throw new NetworkRequestError('transient-error','Downloaded response was truncated'); }
}
function parseContentRange(value:string|null):{start:number;end:number;total:number}|undefined {
    const match=value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!match) { return undefined; }
    const [start,end,total]=match.slice(1).map(Number);
    return [start,end,total].every(Number.isSafeInteger)&&start>=0&&end>=start&&total>end?{start,end,total}:undefined;
}
function concat(chunks:Uint8Array[],length:number):Uint8Array {
    const result=new Uint8Array(length); let offset=0;
    for (const chunk of chunks) { result.set(chunk,offset); offset+=chunk.byteLength; }
    return result;
}
function isRedirect(status:number):boolean { return status>=300 && status<400; }
function isRetryableStatus(status:number):boolean { return status===429 || status>=500; }
function isNetworkFailure(error:any):boolean {
    const message=`${error?.code??''} ${error?.message??''} ${error?.cause?.code??''}`;
    return error?.name==='AbortError' || /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_(?:ABORTED|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|socket hang up|fetch failed/i.test(message);
}
export function retryDelay(attempt:number,retryAfter?:string|null):number {
    if (retryAfter) {
        const seconds=Number(retryAfter); if (Number.isFinite(seconds)) { return Math.max(0,seconds*1000); }
        const date=Date.parse(retryAfter); if (Number.isFinite(date)) { return Math.max(0,date-Date.now()); }
    }
    const base=Math.min(1000*2**attempt,4000);
    return base+Math.floor(Math.random()*Math.max(1,Math.floor(base/4)));
}
export function delay(ms:number,signal?:AbortSignal):Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
        const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(signal?.reason??new Error('Cancelled'));};
        const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},Math.min(ms,2147483647));
        signal?.addEventListener('abort',cancel,{once:true});
    });
}
