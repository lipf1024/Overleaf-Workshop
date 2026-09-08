/* eslint-disable @typescript-eslint/naming-convention */
import type { Response } from 'undici';
import { fetchWithPolicy, asNetworkError, classifyResponseStatus, NetworkRequestError, TRANSFER_TIMEOUT_MS, delay, retryDelay, downloadBytes } from './network';

export const PDF_CHUNK_SIZE=64*1024;
export interface PdfSourceDescriptor { key:string; open:(signal?:AbortSignal)=>Promise<PdfByteSource>; }

/** Authenticated PDF bytes stay in the extension host, never exposing cookies or
 * signed URLs to the webview. Cache and validators belong to one output version. */
export class PdfByteSource {
    readonly controller=new AbortController();
    private readonly blocks=new Map<number,Uint8Array>();
    private readonly pending=new Map<number,Promise<Uint8Array>>();
    private full?:Uint8Array;
    private detach?:()=>void;
    private etag?:string;
    length=0;
    initialData=new Uint8Array(0);
    get ranged():boolean { return !this.full; }
    get isDisposed():boolean { return this.controller.signal.aborted; }

    private constructor(private readonly url:string,private readonly headers:Record<string,string>) {}

    static async open(url:string,headers:Record<string,string>,signal?:AbortSignal):Promise<PdfByteSource> {
        signal?.throwIfAborted();
        const source=new PdfByteSource(url,headers);
        const abort=()=>source.dispose();
        signal?.addEventListener('abort',abort,{once:true});
        source.detach=()=>signal?.removeEventListener('abort',abort);
        try {
            const result=await source.fetch(0,PDF_CHUNK_SIZE);
            if (result.status===206 && result.etag && /^"[^\r\n]*"$/.test(result.etag)) {
                source.etag=result.etag;
                source.length=result.total;
                source.initialData=result.bytes;
                source.blocks.set(0,result.bytes);
            } else {
                // A 200 response already contains the full PDF. A weak/missing ETag
                // or encoded partial response cannot safely join independently read chunks.
                source.full=result.status===200?result.bytes:await downloadBytes(url,headers,{signal:source.controller.signal});
                source.length=source.full.length;
                source.initialData=source.full;
            }
            if (!source.length || !Buffer.from(source.initialData.subarray(0,1024)).includes(Buffer.from('%PDF-'))) {
                throw new NetworkRequestError('fatal-error','The server did not return a PDF');
            }
            return source;
        } catch (error) { source.dispose(); throw error; }
    }

    private async fetch(begin:number,end:number):Promise<{status:number;bytes:Uint8Array;total:number;etag?:string}> {
        for (let attempt=0;;attempt++) {
            let response:Response|undefined,retryAfter:string|null=null;
            try {
                response=await fetchWithPolicy(this.url,{headers:{...this.headers,'Accept-Encoding':'identity',Range:`bytes=${begin}-${end-1}`,...(this.etag?{'If-Range':this.etag}:{})}},
                    {signal:this.controller.signal,timeoutMs:TRANSFER_TIMEOUT_MS,maxRetries:0});
                retryAfter=response.headers.get('retry-after');
                if (response.status!==200 && response.status!==206) {
                    throw new NetworkRequestError(classifyResponseStatus(response.status),`PDF request failed (${response.status})`,response.status);
                }
                const etag=response.headers.get('etag')??undefined;
                if (this.etag && (response.status!==206 || etag!==this.etag)) {
                    throw new NetworkRequestError('fatal-error','PDF changed during range loading; recompile or reopen the preview');
                }
                const encoding=response.headers.get('content-encoding');
                if (encoding && encoding.toLowerCase()!=='identity') {
                    if (this.etag) { throw new NetworkRequestError('fatal-error','Server returned an encoded PDF range'); }
                    await response.body?.cancel().catch(()=>undefined);
                    return {status:206,bytes:new Uint8Array(0),total:0}; // safe full-download fallback
                }
                const bytes=new Uint8Array(await response.arrayBuffer());
                const declared=response.headers.get('content-length');
                if (declared!==null && (!/^\d+$/.test(declared) || Number(declared)!==bytes.length)) {
                    throw new NetworkRequestError('transient-error','Truncated PDF response');
                }
                let total=bytes.length;
                if (response.status===206) {
                    const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');
                    if (!match) { throw new NetworkRequestError('fatal-error','Invalid PDF Content-Range'); }
                    const start=Number(match[1]),last=Number(match[2]);total=Number(match[3]);
                    if (!Number.isSafeInteger(total) || total<=0 || start!==begin || last!==Math.min(end,total)-1 || bytes.length!==last-start+1
                        || (this.length && this.length!==total)) {
                        throw new NetworkRequestError('fatal-error','Inconsistent PDF Content-Range');
                    }
                }
                return {status:response.status,bytes,total,etag};
            } catch (error) {
                const network=asNetworkError(error,true);
                if (this.isDisposed || attempt>=2 || !['offline','transient-error'].includes(network.kind)) { throw network; }
                await response?.body?.cancel().catch(()=>undefined);
                await delay(retryDelay(attempt,retryAfter),this.controller.signal);
            } finally { await response?.body?.cancel().catch(()=>undefined); }
        }
    }

    private block(index:number):Promise<Uint8Array> {
        const cached=this.blocks.get(index); if (cached) { return Promise.resolve(cached); }
        const pending=this.pending.get(index); if (pending) { return pending; }
        const begin=index*PDF_CHUNK_SIZE;
        const task=this.fetch(begin,Math.min(this.length,begin+PDF_CHUNK_SIZE)).then(result=>{
            if (this.isDisposed) { throw new Error('PDF preview closed'); }
            this.blocks.set(index,result.bytes);return result.bytes;
        }).finally(()=>this.pending.delete(index));
        this.pending.set(index,task);return task;
    }

    async read(begin:number,end:number):Promise<Uint8Array> {
        this.controller.signal.throwIfAborted();
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin<0 || end<=begin || end>this.length) {
            throw new Error('Invalid PDF byte range');
        }
        if (this.full) { return this.full.slice(begin,end); }
        const result=new Uint8Array(end-begin);
        // Sequential blocks bound per-request concurrency; overlapping callers share blocks.
        for (let i=Math.floor(begin/PDF_CHUNK_SIZE);i<=Math.floor((end-1)/PDF_CHUNK_SIZE);i++) {
            const bytes=await this.block(i),offset=i*PDF_CHUNK_SIZE;
            const start=Math.max(begin,offset),stop=Math.min(end,offset+bytes.length);
            result.set(bytes.subarray(start-offset,stop-offset),start-begin);
        }
        return result;
    }

    dispose():void { this.detach?.();this.controller.abort();this.blocks.clear();this.pending.clear();this.full=undefined; }
}
