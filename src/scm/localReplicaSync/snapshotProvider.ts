import { RemoteReadResult, RemoteSnapshot } from './model';

export interface SnapshotReader {
    readLocal(path:string):Promise<Uint8Array|undefined>;
    readRemote(path:string,force?:boolean):Promise<RemoteReadResult|RemoteSnapshot|undefined>;
}

/** One entry point for taking a same-reconcile-cycle view of both sides. */
export class SnapshotProvider {
    constructor(private readonly reader:SnapshotReader) {}
    async read(path:string,forceRemote=true):Promise<{local?:Uint8Array;remote?:RemoteSnapshot}> {
        const [local,result]=await Promise.all([this.reader.readLocal(path),this.reader.readRemote(path,forceRemote)]);
        return {local,remote:unwrapRemoteRead(result)};
    }
}

export function unwrapRemoteRead(result:RemoteReadResult|RemoteSnapshot|undefined):RemoteSnapshot|undefined {
    if (!result) { return undefined; }
    if (!('type' in result)) { return result; }
    if (result.type==='found') { return result.snapshot; }
    if (result.type==='missing') { return undefined; }
    throw new Error(`${result.type}: ${result.message}`);
}
