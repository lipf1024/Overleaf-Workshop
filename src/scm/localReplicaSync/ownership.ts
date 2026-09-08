import * as fs from 'fs/promises';
import { constants } from 'fs';
import { LocalPathAccess } from './pathPolicy';

const nativeLock: {tryLock(fd:number):boolean;unlock(fd:number):void}=require('fs-native-extensions');

/** The lock file is never renamed or deleted: every process locks the same inode. */
export class ReplicaOwnership {
    private handle?:fs.FileHandle;
    private held=false;
    private closed=false;
    constructor(private readonly access:LocalPathAccess) {}
    get isOwner():boolean { return this.held && !this.closed; }
    async acquire():Promise<boolean> {
        if (this.closed) { throw new Error('Replica ownership was closed'); }
        const checked=await this.access.check('.overleaf/sync/owner.lock',true,true);
        if (!this.handle) { this.handle=await fs.open(checked.path,constants.O_CREAT|constants.O_RDWR|(constants.O_NOFOLLOW??0),0o600); }
        await this.access.verify(checked);
        const opened=await this.handle.stat(),named=await fs.lstat(checked.path);
        if (named.isSymbolicLink() || opened.dev!==named.dev || opened.ino!==named.ino) { throw new Error('Replica ownership file was replaced'); }
        if (!this.held) { this.held=nativeLock.tryLock(this.handle.fd); }
        return this.held;
    }
    async assert():Promise<void> {
        if (!this.isOwner || !this.handle) { throw new Error('Another VS Code window owns synchronization for this replica'); }
        const checked=await this.access.check('.overleaf/sync/owner.lock',true),named=await fs.lstat(checked.path),opened=await this.handle.stat();
        if (named.dev!==opened.dev || named.ino!==opened.ino) {
            await this.close(); throw new Error('Replica ownership file changed; synchronization was stopped');
        }
    }
    async close():Promise<void> {
        this.closed=true;
        const handle=this.handle; this.handle=undefined;
        if (handle) { try { if (this.held) { nativeLock.unlock(handle.fd); } } finally { this.held=false; await handle.close(); } }
    }
}
