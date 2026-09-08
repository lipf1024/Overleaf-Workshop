export class SocketOutcomeUnknownError extends Error {
    constructor(message:string) { super(message); this.name='SocketOutcomeUnknownError'; }
}

export function emitWithAckSafe(socket:any,event:string,args:any[],isCurrent:()=>boolean,timeoutMs=10000,signal?:AbortSignal):Promise<any[]> {
    return new Promise((resolve,reject)=>{
        let settled=false;
        const finish=(error?:any,data?:any[])=>{
            if (settled) { return; }
            settled=true; clearTimeout(timer); signal?.removeEventListener('abort',onAbort);
            if (!isCurrent()) { reject(new SocketOutcomeUnknownError(`${event} completed on a stale connection`)); }
            else if (error) { reject(error); }
            else { resolve(data??[]); }
        };
        const onAbort=()=>finish(new SocketOutcomeUnknownError(`${event} was cancelled with its connection`));
        const timer=setTimeout(()=>finish(new SocketOutcomeUnknownError(`${event} acknowledgement timed out`)),timeoutMs);
        signal?.addEventListener('abort',onAbort,{once:true});
        if (signal?.aborted) { onAbort(); return; }
        try { socket.emit(event,...args,(error:any,...data:any[])=>finish(error,data)); }
        catch (error) { finish(error); }
    });
}
