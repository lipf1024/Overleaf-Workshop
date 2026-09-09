import { randomUUID } from 'crypto';
import { contentHash, equalContent } from './hash';
import { reconcile } from './reconciler';
import { ApplyResult, ConflictRecord, FileKind, FileSyncRecord, RemoteReadResult, RemoteRevision, RemoteSnapshot, SyncMode, SyncStateV1 } from './model';
import { LocalRecoveryReview, SyncStateStore } from './stateStore';
import { PathDecision } from './pathPolicy';
import { SnapshotProvider, unwrapRemoteRead } from './snapshotProvider';
import { OperationEventSuppressor } from './eventSuppressor';
import { conflictSnapshotKey, hasUnresolvedConflict } from './conflictState';
import { pathComparisonKey, validateReplicaPath, PathIssue } from './pathSafety';

export interface SyncAdapter {
    establishText?(path:string,snapshot:RemoteSnapshot):Promise<void>;
    syncText?(path:string):Promise<{snapshot:RemoteSnapshot;local:Uint8Array}|undefined>;
    checkPath?(path:string):Promise<PathDecision>;
    listPaths():Promise<string[]>;
    listLocalPaths?():Promise<string[]>;
    remotePathType?(path:string):Promise<'file'|'directory'|'missing'>;
    listIssues?():PathIssue[];
    readLocal(path:string):Promise<Uint8Array|undefined>;
    readRemote(path:string,force?:boolean):Promise<RemoteReadResult|RemoteSnapshot|undefined>;
    applyRemote(path:string,expected:RemoteRevision|undefined,content:Uint8Array,kind:FileKind,operationId?:string):Promise<ApplyResult>;
    deleteRemote(path:string,expected:RemoteRevision|undefined):Promise<ApplyResult>;
    locateRemotePath?(entityId:string):Promise<string|undefined>;
    findLocalPathsByHash?(hash:string,exclude:string):Promise<string[]>;
    renameRemote?(oldPath:string,newPath:string,expected:RemoteRevision):Promise<ApplyResult>;
    recoverRemote?(entry:import('./model').JournalEntry,remoteBefore?:Uint8Array):Promise<ApplyResult>;
    isLocalDirty(path:string):boolean;
    connectionEpoch?():number;
    isConnectionReady?():boolean;
    syncActivity?(path:string,active:boolean):void;
}

export class SyncCoordinator {
    private state!:SyncStateV1;
    private stopped=false;
    private maintenance:Promise<void>=Promise.resolve();
    private blockedLocalRecovery=new Map<string,string>();
    private readonly queues = new Map<string,Promise<void>>();
    private readonly emitter = new Set<(records:FileSyncRecord[])=>void>();
    private readonly snapshots:SnapshotProvider;
    private readonly suppressor=new OperationEventSuppressor();
    private readonly draftQueues=new Map<string,Promise<void>>();
    private treeQueue:Promise<unknown>=Promise.resolve();
    private readonly blockedRecovery=new Map<string,import('./model').JournalEntry>();
    // Session-only confirmations: persisted clean state is not proof after a restart.
    private readonly compileConfirmations=new Map<string,{hash:string;epoch:number}>();

    constructor(private readonly store:SyncStateStore,private readonly adapter:SyncAdapter,private mode:SyncMode) {
        this.snapshots=new SnapshotProvider(adapter);
        this.store.setMutationPolicy(adapter.checkPath?.bind(adapter));
    }

    onDidChange(listener:(records:FileSyncRecord[])=>void):()=>void { this.emitter.add(listener); return ()=>this.emitter.delete(listener); }
    get isOwner():boolean { return this.store.isOwner && !this.stopped; }
    async refreshObservedState():Promise<void> { this.state=await this.store.readStateSnapshot(); this.emitter.forEach(listener=>listener(this.records())); }
    async tryTakeOwnership():Promise<boolean> { return this.store.tryTakeOwnership(); }
    writeMergeFile(relative:string,content:Uint8Array):Promise<void> { return this.store.writeMergeFile(relative,content); }
    readMergeFile(relative:string):Promise<Uint8Array|undefined> { return this.store.access.read(relative,true); }
    pinObjects(ids:(string|undefined)[]):()=>void { return this.store.pinObjects(ids); }
    async collectGarbage(sessionPaths:string[]=[]):Promise<void> {
        if (!this.isOwner || this.queues.size || this.draftQueues.size) { return; }
        const task=this.maintenance.then(()=>this.store.collectGarbage(this.state,sessionPaths));
        this.maintenance=task.catch(()=>undefined); await task;
    }
    async shutdown():Promise<void> { this.stopped=true; await this.flush(); await this.maintenance; await this.store.close(); }
    records():FileSyncRecord[] { return Object.values(this.state?.files ?? {}); }

    async initialize():Promise<{safeInitialization:boolean}> {
        const loaded = await this.store.loadState();
        this.state=loaded.state;
        if (!this.isOwner) { return {safeInitialization:loaded.safeInitialization}; }
        this.blockedLocalRecovery=await this.store.recoverLocalOperations(path=>this.allowPath(path));
        const interrupted=await this.store.listJournal();
        // Incomplete operations are never assumed successful. Recovery re-reads both sides.
        for (const entry of interrupted) {
            if (!await this.allowPath(entry.path) || (entry.sourcePath && !await this.allowPath(entry.sourcePath))) { continue; }
            const record=this.find(entry.path);
            if (record) { record.status='error'; record.message=`Recovering interrupted ${entry.operation}`; }
            if (entry.operation==='upload' && entry.temporaryPath && this.adapter.recoverRemote) {
                const original=await this.store.getObject(entry.remoteBeforeObjectId);
                const result=await this.adapter.recoverRemote(entry,original);
                if (result.type==='failed' && result.snapshot && equalContent(result.snapshot.content,original)) {
                    await this.store.removeJournal(entry.id);
                } else if (result.type!=='verified') {
                    this.blockedRecovery.set(pathComparisonKey(entry.path),entry);
                    if (record) { record.status='error'; record.message=result.message??'Interrupted binary upload needs recovery'; }
                }
            }
        }
        const configuredMode=this.mode;
        if (loaded.safeInitialization) { this.mode='manual'; }
        await this.scan('bootstrap');
        for (const entry of interrupted) {
            if (!await this.allowPath(entry.path) || (entry.sourcePath && !await this.allowPath(entry.sourcePath))) { continue; }
            await this.enqueue(entry.path,()=>this.reconcilePath(entry.path,'bootstrap'));
            const record=this.find(entry.path);
            if ((!record || record.status==='clean') && !this.blockedLocalRecovery.has(entry.path)) { await this.store.removeJournal(entry.id); }
        }
        this.mode=configuredMode;
        return {safeInitialization:loaded.safeInitialization};
    }

    setMode(mode:SyncMode):void { this.mode=mode; }
    async scan(cause:'bootstrap'|'manual'='manual',modeOverride?:SyncMode):Promise<void> {
        const paths=new Set([...this.records().map(record=>record.path),...(await this.adapter.listPaths())]);
        for (const path of paths) { await this.enqueue(path,()=>this.reconcilePath(path,cause,modeOverride)); }
        for (const issue of this.adapter.listIssues?.()??[]) { await this.freezePath(issue.path,issue.message); }
    }
    prepareLocalForCompile(path:string):Promise<void> { return this.enqueue(path,async()=>{
        const key=pathComparisonKey(path);
        const local=await this.adapter.readLocal(path);
        const record=this.find(path),confirmed=this.compileConfirmations.get(key);
        if (this.adapter.isConnectionReady?.()===true && confirmed
            && confirmed.epoch===this.adapter.connectionEpoch?.()
            && record?.status==='clean' && !record.suspension && !record.pendingConflictId
            && !this.blockedRecovery.has(key) && !this.blockedLocalRecovery.has(normalizePath(path))
            && !this.adapter.isLocalDirty(path)
            && confirmed.hash===record.base?.hash && confirmed.hash===contentHash(local)) { return; }
        await this.reconcilePath(path,'local');
    }); }

    handleLocal(path:string):Promise<void> { return this.enqueue(path,async()=>{
        try {
            const content=await this.adapter.readLocal(path);
            if (this.suppressor.consume('local',normalizePath(path),contentHash(content))) { return; }
            await this.reconcilePath(path,'local');
        } catch (error:any) { await this.setError(path,error?.message??String(error)); }
    }); }
    async handleRemote(path:string):Promise<void> {
        const decision=await this.adapter.checkPath?.(path);
        if (decision && decision.type!=='allowed') { await this.enqueue(path,async()=>{}); return; }
        const directory=await this.adapter.remotePathType?.(path)==='directory';
        await this.enqueue(path,async()=>{
            try {
                if (await this.syncOnlineText(path)) { return; }
                const snapshot=unwrapRemoteRead(await this.adapter.readRemote(path,true));
                if (this.suppressor.consume('remote',normalizePath(path),snapshot?.hash)) { return; }
                await this.reconcilePath(path,'remote');
            } catch (error:any) { await this.setError(path,error?.message??String(error)); }
        });
        if (directory && !this.find(path)?.suspension) {
            // A directory move/create can arrive without individual child events.
            // Enumerate names, but only reconcile descendants of this directory.
            for (const child of await this.adapter.listPaths()) {
                if (normalizePath(child).startsWith(normalizePath(path)+'/')) { await this.handleRemote(child); }
            }
        }
    }
    async markUnstable(path:string):Promise<void> {
        await this.enqueue(path,async()=>{
            const normalized=normalizePath(path);
            if (this.find(normalized)?.pendingConflictId) { return; }
            const record=this.find(normalized)??{key:`local:${normalized}`,path:normalized,kind:'binary' as const,observed:{},status:'pending-upload' as const};
            this.state.files[record.key]=record; record.status='pending-upload'; record.message='Local content did not become stable within 5 seconds'; await this.persist();
        });
    }
    async handleTreeDelete(side:'local'|'remote',rawPath:string):Promise<void> {
        if (this.stopped) { return; }
        if (!this.isOwner) { throw new Error('Synchronization is owned by another window'); }
        const path=normalizePath(rawPath),prefix=path+'/';
        if (!await this.allowPath(path)) { return; }
        const children:FileSyncRecord[]=[];
        for (const record of this.records().filter(record=>record.path.startsWith(prefix))) { if (await this.allowPath(record.path)) { children.push(record); } }
        if (!children.length) { return side==='local'?this.handleLocal(path):this.handleRemote(path); }
        let concurrent=false;
        for (const record of children) {
            try {
                const base=await this.store.getObject(record.base?.objectId);
                const other=side==='remote' ? await this.adapter.readLocal(record.path) : unwrapRemoteRead(await this.adapter.readRemote(record.path,true))?.content;
                if (!base || !equalContent(base,other)) { concurrent=true; break; }
            } catch { concurrent=true; break; }
        }
        if (concurrent) {
            for (const record of children) {
                await this.enqueue(record.path,async()=>{
                try {
                    const [base,local,remoteResult]=await Promise.all([this.store.getObject(record.base?.objectId),this.adapter.readLocal(record.path),this.adapter.readRemote(record.path,true)]);
                    const remote=unwrapRemoteRead(remoteResult);
                    await this.freezeConflict(record,base,local,remote,`Tree conflict: ${side} directory ${path} was deleted while its contents changed`,[]);
                } catch (error:any) {
                    record.status='error'; record.message=error?.message??String(error);
                }
                await this.persist();
                });
            }
        } else { await this.scan('bootstrap'); }
    }
    async freezePath(path:string,message:string):Promise<void> {
        await this.enqueue(path,()=>this.setFrozen(path,message));
    }
    private manualSync?:Promise<void>;
    syncPath(path:string):Promise<void> {
        const issue=validateReplicaPath(path);
        if (issue) { return Promise.reject(new Error(issue)); }
        if (!this.isOwner) { return Promise.reject(new Error('Synchronization is owned by another window')); }
        return this.enqueue(path,()=>this.reconcilePath(path,'manual','safeAuto',false));
    }
    syncNow():Promise<void> {
        if (this.manualSync) { return this.manualSync; }
        const task=this.runManualSync().finally(()=>{
            if (this.manualSync===task) { this.manualSync=undefined; }
        });
        this.manualSync=task;
        return task;
    }

    private async runManualSync():Promise<void> {
        if (!this.isOwner) { throw new Error('Synchronization is owned by another window'); }
        await this.flush();
        const recovery=this.maintenance.then(async()=>{
            this.blockedLocalRecovery=await this.store.recoverLocalOperations(path=>this.allowPath(path));
            return this.retryBlockedRecovery();
        });
        this.maintenance=recovery.then(()=>undefined,()=>undefined);
        const recovered=await recovery;
        await this.scan('manual','safeAuto');
        for (const entry of recovered) { if (this.find(entry.path)?.status==='clean') { await this.store.removeJournal(entry.id); } }
    }

    async localRecoveryReviews():Promise<LocalRecoveryReview[]> {
        if (!this.isOwner) { throw new Error('Review recovery in the window that owns synchronization'); }
        await this.flush();
        return (await this.store.listLocalRecoveryReviews()).filter(review=>review.entry.recoveryRequired || this.blockedLocalRecovery.has(review.entry.path));
    }
    async acknowledgeLocalRecovery(review:LocalRecoveryReview):Promise<void> {
        await this.enqueue(review.entry.path,async()=>{
            await this.store.acknowledgeLocalRecovery(review);
            this.blockedLocalRecovery.delete(review.entry.path);
            await this.reconcilePath(review.entry.path,'manual');
        });
    }

    private async retryBlockedRecovery():Promise<import('./model').JournalEntry[]> {
        const recovered:import('./model').JournalEntry[]=[];
        if (!this.adapter.recoverRemote) { return recovered; }
        for (const [key,entry] of [...this.blockedRecovery]) {
            const original=await this.store.getObject(entry.remoteBeforeObjectId);
            if (!await this.allowPath(entry.path)) { continue; }
            const result=await this.adapter.recoverRemote(entry,original);
            if (result.type==='verified' || (result.type==='failed' && result.snapshot && equalContent(result.snapshot.content,original))) {
                this.blockedRecovery.delete(key);
                if (result.type==='failed') { await this.store.removeJournal(entry.id); }
                else { recovered.push(entry); }
            }
        }
        return recovered;
    }

    async isObservedLocalStatePublished():Promise<boolean> {
        await this.refreshObservedState();
        const paths=new Set(this.adapter.listLocalPaths?await this.adapter.listLocalPaths():await this.adapter.listPaths());
        for (const record of this.records()) { paths.add(record.path); }
        for (const path of paths) {
            const decision=await this.adapter.checkPath?.(path);
            if (decision?.type==='ignored') { continue; }
            if (decision?.type==='blocked') { return false; }
            const record=this.find(path);
            if (record && (record.status!=='clean' || record.pendingConflictId)) { return false; }
            if (contentHash(await this.adapter.readLocal(path))!==record?.base?.hash || this.adapter.isLocalDirty(path)) { return false; }
        }
        return true;
    }

    async isObservedLocalPathPublished(path:string):Promise<boolean> {
        await this.refreshObservedState();
        const normalized=normalizePath(path),decision=await this.adapter.checkPath?.(normalized);
        if (decision?.type==='ignored') { return true; }
        if (decision?.type==='blocked') { return false; }
        const record=this.find(normalized);
        if (!record || record.status!=='clean' || record.pendingConflictId) { return false; }
        return contentHash(await this.adapter.readLocal(normalized))===record.base?.hash && !this.adapter.isLocalDirty(normalized);
    }

    async refreshLocalChanges():Promise<void> {
        if (!this.isOwner) { await this.refreshObservedState(); return; }
        const paths=new Set(this.adapter.listLocalPaths ? await this.adapter.listLocalPaths() : await this.adapter.listPaths());
        for (const record of this.records()) { paths.add(record.path); }
        for (const path of paths) {
            if (!await this.allowPath(path)) { continue; }
            const record=this.find(path);
            if ((await this.store.access.stat(path))?.isDirectory()) { await this.handleLocal(path); continue; }
            const local=await this.adapter.readLocal(path);
            if ((local&&contentHash(local))!==record?.observed.localHash) {
                await this.handleLocal(path);
            }
        }
    }

    async flush():Promise<void> {
        // New work may be appended while an earlier queue is settling.
        do {
            await Promise.allSettled([...this.queues.values(),...this.draftQueues.values(),this.treeQueue]);
        } while (this.queues.size>0 || this.draftQueues.size>0);
    }
    /** A finite barrier: later collaboration events cannot extend a compile wait. */
    async flushCurrent():Promise<void> {
        await Promise.all([...this.queues.values(),...this.draftQueues.values(),this.treeQueue]);
    }

    async resolveWithSide(id:string,side:'local'|'remote'):Promise<{ok:boolean;message?:string}> {
        const conflict=await this.store.readConflict(id);
        if (!conflict) { return {ok:false,message:'Conflict no longer exists'}; }
        if (!this.isOwner || !await this.allowPath(conflict.path)) { return {ok:false,message:'This path is excluded or synchronization belongs to another window'}; }
        const content=await this.store.getObject(side==='local'?conflict.localObjectId:conflict.remoteObjectId);
        if (content) {
            return side==='remote'
                ? this.acceptRemoteConflictVersion(conflict,content)
                : this.resolveConflict(id,content,conflict.hunks.map((_,index)=>index),conflictSnapshotKey(conflict));
        }
        const deleted=side==='local'?conflict.localHash===undefined:conflict.remoteHash===undefined;
        return deleted ? this.resolveDeletion(id,side) : {ok:false,message:`The saved ${side} version is unavailable`};
    }

    private async acceptRemoteConflictVersion(conflict:ConflictRecord,content:Uint8Array):Promise<{ok:boolean;message?:string}> {
        let outcome:{ok:boolean;message?:string}={ok:false,message:'The Overleaf version could not be adopted safely'};
        await this.enqueue(conflict.path,async()=>{
            const record=this.find(conflict.path);
            if (!record) { outcome={ok:false,message:'Sync record is unavailable'}; return; }
            let local:Uint8Array|undefined,remote:RemoteSnapshot|undefined;
            try { ({local,remote}=await this.snapshots.read(conflict.path,true)); }
            catch (error:any) { outcome={ok:false,message:`Remote version could not be verified: ${error?.message??String(error)}`}; return; }
            if ((local&&contentHash(local))!==conflict.localHash || remote?.hash!==conflict.remoteHash
                || !sameRevision(remote?.revision,conflict.remoteRevision) || !remote || !equalContent(remote.content,content)) {
                outcome={ok:false,message:'A side changed again; adopting the Overleaf version was paused'}; return;
            }
            if (this.adapter.isLocalDirty(conflict.path)) { outcome={ok:false,message:'Save or revert the editor buffer before adopting the Overleaf version'}; return; }
            const operationId=this.suppressor.register('local',conflict.path,remote.hash);
            const entry=await this.store.atomicLocalWrite(conflict.path,remote.content,'download',operationId,conflict.localHash,true);
            const localAfter=await this.adapter.readLocal(conflict.path);
            if (!equalContent(localAfter,remote.content)) {
                record.status='error'; record.message='Local write verification failed while adopting the Overleaf version'; await this.persist();
                outcome={ok:false,message:record.message}; return;
            }
            let remoteAfter:RemoteSnapshot|undefined;
            try { remoteAfter=unwrapRemoteRead(await this.adapter.readRemote(conflict.path,true)); }
            catch (error:any) {
                record.status='pending-download'; record.message=`The local copy is backed up, but Overleaf could not be reverified: ${error?.message??String(error)}`;
                await this.persist(); outcome={ok:false,message:record.message}; return;
            }
            if (!remoteAfter || !sameRevision(remoteAfter.revision,remote.revision)
                || remoteAfter.connectionEpoch!==remote.connectionEpoch || !equalContent(remoteAfter.content,remote.content)) {
                await this.freezeConflict(record,await this.store.getObject(record.base?.objectId),localAfter,remoteAfter,
                    'Overleaf changed while its conflict version was being adopted',[]);
                await this.persist(); outcome={ok:false,message:record.message}; return;
            }
            if (!await this.commitBase(record,remote.content,remoteAfter)) {
                record.status='pending-download'; await this.persist(); outcome={ok:false,message:record.message}; return;
            }
            await this.store.removeJournal(entry.id); await this.store.removeConflict(conflict.id); await this.persist(); outcome={ok:true};
        });
        return outcome;
    }

    private async resolveDeletion(id:string,side:'local'|'remote'):Promise<{ok:boolean;message?:string}> {
        const conflict=await this.store.readConflict(id); if (!conflict) { return {ok:false,message:'Conflict no longer exists'}; }
        let outcome:{ok:boolean;message?:string}={ok:false};
        await this.enqueue(conflict.path,async()=>{
            const [local,remoteResult]=await Promise.all([this.adapter.readLocal(conflict.path),this.adapter.readRemote(conflict.path,true)]);
            const remote=unwrapRemoteRead(remoteResult);
            if ((local&&contentHash(local))!==conflict.localHash || remote?.hash!==conflict.remoteHash || !sameRevision(remote?.revision,conflict.remoteRevision)) {
                outcome={ok:false,message:'A side changed again; deletion resolution was paused'}; return;
            }
            const record=this.find(conflict.path); if (!record) { outcome={ok:false,message:'Sync record is unavailable'}; return; }
            if (side==='local') { await this.deleteRemote(record,remote?.revision); }
            else if (local) { await this.deleteLocal(record,remote?.revision,conflict.localHash,this.adapter.connectionEpoch?.()); }
            else { delete this.state.files[record.key]; }
            if (!this.state.files[record.key]) { await this.store.removeConflict(id); outcome={ok:true}; }
            else { outcome={ok:false,message:record.message??'Deletion could not be verified'}; }
            await this.persist();
        });
        return outcome;
    }

    getConflict(id:string):Promise<ConflictRecord|undefined> { return this.store.readConflict(id); }
    getObject(id?:string):Promise<Uint8Array|undefined> { return this.store.getObject(id); }
    async diagnostics():Promise<unknown> { return {schemaVersion:1,mode:this.mode,records:this.records(),journal:await this.store.listJournal(),conflicts:await this.store.listConflicts()}; }

    async saveConflictDraft(id:string,content:Uint8Array,resolvedHunks:number[],hunkChoices:Record<string,'local'|'remote'|'both'>={}):Promise<void> {
        const gate=this.maintenance;
        const operation=(this.draftQueues.get(id)??Promise.resolve()).catch(()=>undefined).then(async()=>{
            await gate;
            const draftObjectId=await this.store.putObject(content);
            await this.store.updateConflictDraft(id,draftObjectId,resolvedHunks,hunkChoices);
        });
        this.draftQueues.set(id,operation);
        try { await operation; } finally { if (this.draftQueues.get(id)===operation) { this.draftQueues.delete(id); } }
    }

    async resolveConflict(id:string,content:Uint8Array,resolvedHunks:number[]=[],expectedSnapshotKey?:string):Promise<{ok:boolean;message?:string}> {
        const conflict=await this.store.readConflict(id);
        if (!conflict) { return {ok:false,message:'Conflict no longer exists'}; }
        if (!this.isOwner || !await this.allowPath(conflict.path)) { return {ok:false,message:'This path is excluded or synchronization belongs to another window'}; }
        const resolved=new Set(resolvedHunks);
        const reviewedSnapshot=expectedSnapshotKey??conflictSnapshotKey(conflict);
        if (conflict.kind==='text' && containsConflictMarkers(content)) { return {ok:false,message:'Conflict markers cannot be written or uploaded'}; }
        let outcome:{ok:boolean;message?:string}={ok:false,message:'Conflict resolution did not complete'};
        await this.enqueue(conflict.path,async()=>{
            const current=await this.store.readConflict(id);
            if (!current) { outcome={ok:false,message:'Conflict no longer exists'}; return; }
            if (conflictSnapshotKey(current)!==reviewedSnapshot) {
                await this.saveConflictDraft(id,content,[]);
                outcome={ok:false,message:'Local or Overleaf changed while the merge editor was open. Your draft is saved; reopen the merge editor to review the updated versions.'};
                return;
            }
            if (current.hunks.some((_,index)=>!resolved.has(index))) {
                outcome={ok:false,message:'Resolve every conflict hunk before completing the merge'};
                return;
            }
            const [local,remoteResult]=await Promise.all([this.adapter.readLocal(conflict.path),this.adapter.readRemote(conflict.path,true)]);
            const remote=unwrapRemoteRead(remoteResult);
            if ((local&&contentHash(local))!==conflict.localHash || remote?.hash!==conflict.remoteHash || !sameRevision(remote?.revision,conflict.remoteRevision)) {
                conflict.draftObjectId=await this.store.putObject(content);
                conflict.reason='A side changed while the conflict editor was open. The draft was preserved; review again.';
                conflict.localObjectId=local&&await this.store.putObject(local); conflict.remoteObjectId=remote&&await this.store.putObject(remote.content);
                conflict.localHash=local&&contentHash(local); conflict.remoteHash=remote?.hash; conflict.remoteRevision=remote?.revision;
                const base=await this.store.getObject(conflict.baseObjectId);
                const refreshed=reconcile({base,local,remote:remote?.content,kind:conflict.kind,mode:'manual',cause:'manual'});
                conflict.hunks=refreshed.hunks??[]; conflict.resolvedHunks=[]; conflict.hunkChoices={};
                await this.store.saveConflict(conflict);
                const record=this.find(conflict.path); if (record) { record.status='conflict'; record.message=conflict.reason; }
                await this.persist();
                outcome={ok:false,message:conflict.reason}; return;
            }
            if (this.adapter.isLocalDirty(conflict.path)) { outcome={ok:false,message:'Save or revert the editor buffer before completing the merge'}; return; }
            const record=this.find(conflict.path)!;
            const operationId=this.suppressor.register('local',conflict.path,contentHash(content));
            const entry=await this.store.atomicLocalWrite(conflict.path,content,conflict.kind==='binary'?'upload':'merge',operationId,conflict.localHash,true);
            entry.remoteBeforeObjectId=remote&&await this.store.putObject(remote.content); entry.expectedRevision=remote?.revision;
            entry.connectionEpoch=remote?.connectionEpoch??this.adapter.connectionEpoch?.(); await this.store.putJournal(entry);
            this.suppressor.register('remote',conflict.path,contentHash(content),operationId);
            const result=await this.adapter.applyRemote(conflict.path,remote?.revision,content,record.kind,operationId);
            entry.temporaryEntityId=result.temporaryEntityId; entry.temporaryPath=result.temporaryPath??entry.temporaryPath;
            if (result.type==='verified' && result.snapshot && result.snapshot.hash===contentHash(content) && result.snapshot.connectionEpoch===entry.connectionEpoch) {
                entry.phase='remote-applied'; await this.store.putJournal(entry);
                if (await this.commitBase(record,content,result.snapshot)) {
                    await this.store.removeJournal(entry.id); await this.store.removeConflict(id); await this.persist();
                    outcome={ok:true}; return;
                }
                record.status='pending-upload';
                record.message='Merge reached Overleaf, but the connection changed before baseline verification';
                await this.persist(); outcome={ok:false,message:record.message}; return;
            }
            if (result.type==='unknown') {
                entry.phase='unknown'; await this.store.putJournal(entry);
                if (conflict.kind==='binary' && entry.temporaryPath) { this.blockedRecovery.set(pathComparisonKey(conflict.path),entry); }
            }
            record.status='pending-upload'; record.message='Merged local result is preserved; remote upload failed verification';
            await this.persist(); outcome={ok:false,message:record.message};
        });
        return outcome;
    }

    private enqueue(path:string,operation:()=>Promise<void>):Promise<void> {
        this.adapter.syncActivity?.(path,true);
        const key=pathComparisonKey(path);
        const gate=this.maintenance;
        const next=(this.queues.get(key)??Promise.resolve()).catch(()=>undefined).then(async()=>{
            await gate;
            if (this.stopped) { return; }
            if (!this.isOwner) { throw new Error('Another window owns this replica'); }
            if (await this.allowPath(path) && !await this.skipDirectory(path)) { await operation(); }
        }).finally(()=>{
            this.adapter.syncActivity?.(path,false);
            if (this.queues.get(key)===next) { this.queues.delete(key); }
        });
        this.queues.set(key,next);
        return next;
    }

    private async withTreeLock<T>(operation:()=>Promise<T>):Promise<T> {
        const result=this.treeQueue.catch(()=>undefined).then(operation);
        this.treeQueue=result.catch(()=>undefined); return result;
    }

    /** Directories are structure, never binary upload candidates. */
    private async skipDirectory(path:string):Promise<boolean> {
        const local=await this.store.access.stat(path);
        const remoteType=await this.adapter.remotePathType?.(path);
        if (!local?.isDirectory() && remoteType!=='directory') { return false; }
        const record=this.find(path);
        if ((local?.isDirectory() && remoteType==='file') || (local?.isFile() && remoteType==='directory')) {
            await this.setFrozen(path,'A file and a directory occupy the same path. Rename one side before synchronizing.');
            return true;
        }
        if (!record) { return true; }
        // Remove only the content-free error record made by older folder events.
        // Real file baselines, conflicts and interrupted writes must survive.
        const journal=await this.store.listJournal();
        const placeholder=remoteType!==undefined && record.status==='error' && !record.base && !record.entityId && !record.pendingConflictId
            && !record.observed.localHash && !record.observed.remoteHash
            && !this.blockedRecovery.has(pathComparisonKey(path)) && !this.blockedLocalRecovery.has(normalizePath(path))
            && !journal.some(entry=>entry.path===path || entry.sourcePath===path) && !await this.store.hasUncertainRecovery()
            && record.message===`Replica file changed during open: ${path}`;
        if (placeholder) {
            delete this.state.files[record.key];
            this.compileConfirmations.delete(pathComparisonKey(path));
            await this.persist();
        } else {
            await this.setFrozen(path,'This path is now a directory. Previous file state was retained; review the file/directory replacement before syncing.');
        }
        return true;
    }

    private find(path:string):FileSyncRecord|undefined {
        const normalized=normalizePath(path);
        return Object.values(this.state.files).find(item=>pathComparisonKey(item.path)===pathComparisonKey(normalized));
    }

    private async allowPath(path:string):Promise<boolean> {
        const decision=await this.adapter.checkPath?.(path)??{type:'allowed' as const};
        if (decision.type==='allowed') {
            const record=this.find(path); if (record) { record.suspension=undefined; }
            return true;
        }
        const existing=this.find(path);
        if (decision.type==='ignored' && !existing) { return false; }
        const record=existing??{key:`local:${path}`,path,kind:'binary' as const,observed:{},status:'error' as const};
        record.suspension=decision.type; record.message=decision.message;
        if (!record.pendingConflictId) { record.status='error'; }
        this.state.files[record.key]=record; await this.persist(); return false;
    }

    private async reconcilePath(rawPath:string,cause:'bootstrap'|'local'|'remote'|'manual',modeOverride?:SyncMode,allowRename=true):Promise<void> {
        const path=normalizePath(rawPath);
        this.compileConfirmations.delete(pathComparisonKey(path));
        if (!await this.allowPath(path)) { return; }
        const recovery=this.blockedLocalRecovery.get(path);
        if (recovery) { await this.setFrozen(path,recovery); return; }
        if (this.blockedRecovery.has(pathComparisonKey(path))) { await this.setError(path,'Interrupted binary replacement is unresolved; retry recovery before synchronizing this path'); return; }
        if (path==='.overleaf' || path.startsWith('.overleaf/')) { return; }
        if (cause!=='bootstrap' && await this.syncOnlineText(path)) { return; }
        const pathIssue=validateReplicaPath(path);
        if (pathIssue) { await this.setFrozen(path,pathIssue); return; }
        try { this.store.resolveSafe(path); } catch (error:any) { await this.setFrozen(path,error?.message??String(error)); return; }
        let local:Uint8Array|undefined, remote:RemoteSnapshot|undefined;
        try {
            ({local,remote}=await this.snapshots.read(path,true));
        } catch (error:any) {
            await this.setError(path,error?.message??String(error)); return;
        }
        let record=this.find(path);
        if (!record && !local && !remote) { return; }
        // Saving, rescanning, reconnecting, and Sync Now never resolve an existing
        // conflict. Only an explicit resolution can write either side again.
        if (record?.pendingConflictId) {
            await this.refreshUnresolvedConflict(record,local,remote);
            return;
        }
        if (record?.entityId && !remote && this.adapter.locateRemotePath) {
            const movedTo=await this.adapter.locateRemotePath(record.entityId);
            if (movedTo && pathComparisonKey(movedTo)!==pathComparisonKey(path)) {
                await this.handleRemoteMove(record,movedTo,cause); return;
            }
        }
        if (!record && remote) {
            const byEntity=Object.values(this.state.files).find(item=>item.entityId===remote!.entityId);
            if (byEntity && pathComparisonKey(byEntity.path)!==pathComparisonKey(path)) {
                if (hasUnresolvedConflict(byEntity)) {
                    await this.setError(byEntity.path,'Overleaf moved this file while its conflict was unresolved. Resolve the conflict before synchronizing the move.');
                    return;
                }
                await this.handleRemoteMove(byEntity,path,cause); return;
            }
        }
        const kind:FileKind=remote?.kind ?? record?.kind ?? detectKind(path,local);
        if (!record) {
            record={key:remote?.entityId??`local:${path}`,entityId:remote?.entityId,path,kind,observed:{},status:'clean'};
            this.state.files[record.key]=record;
        }
        const base=await this.store.getObject(record.base?.objectId);
        if (record.base && (!base || contentHash(base)!==record.base.hash)) {
            record.status='error';
            record.message='The stored synchronization baseline is missing or corrupted; this path was frozen without writing either side';
            await this.persist();
            return;
        }
        const decision=reconcile({base,local,remote:remote?.content,kind,mode:modeOverride??this.mode,cause});
        record.observed={localHash:local&&contentHash(local),remoteHash:remote?.hash};
        record.entityId=remote?.entityId??record.entityId;
        record.kind=kind;
        try {
            switch (decision.action) {
                case 'none':
                    if (!local && !remote) { if (record.pendingConflictId) { await this.store.removeConflict(record.pendingConflictId); } delete this.state.files[record.key]; }
                    else { record.status='clean'; if (remote && record.base?.hash===remote.hash) { await this.adapter.establishText?.(path,remote); } }
                    break;
                case 'establish-base':
                    if (!remote || !await this.commitBase(record,local??remote.content,remote)) {
                        record.status='error'; record.message='A verified remote snapshot is required to establish the baseline';
                    }
                    break;
                case 'pending-upload': record.status='pending-upload'; record.message=decision.reason; break;
                case 'pending-download': record.status='pending-download'; record.message=decision.reason; break;
                case 'upload': if (local) { await this.upload(record,local,remote?.revision); } break;
                case 'download': if (remote) { await this.download(record,remote,local&&contentHash(local)); } break;
                case 'merge': if (decision.merged && remote) { await this.merge(record,decision.merged,remote); } break;
                case 'delete-local': await this.deleteLocal(record,remote?.revision,record.base?.hash,this.adapter.connectionEpoch?.()); break;
                case 'delete-remote':
                    if (!allowRename || !await this.tryLocalRename(record,remote!)) { await this.deleteRemote(record,remote?.revision); }
                    break;
                case 'conflict': await this.freezeConflict(record,base,local,remote,decision.reason??'Concurrent changes',decision.hunks??[],decision.merged); break;
            }
        } catch (error:any) { record.status='error'; record.message=error?.message??String(error); }
        await this.persist();
    }

    private async upload(record:FileSyncRecord,content:Uint8Array,expected?:RemoteRevision):Promise<void> {
        record.status='syncing';
        const currentLocal=await this.adapter.readLocal(record.path);
        if (!equalContent(currentLocal,content)) {
                await this.freezeConflict(record,await this.store.getObject(record.base?.objectId),currentLocal,unwrapRemoteRead(await this.adapter.readRemote(record.path,true)),'Local file changed before upload',[]); return;
        }
        if (record.kind==='text' && containsConflictMarkers(content)) {
            await this.freezeConflict(record,await this.store.getObject(record.base?.objectId),content,unwrapRemoteRead(await this.adapter.readRemote(record.path,true)),'Conflict markers cannot be uploaded',[]); return;
        }
        for (let attempt=0;attempt<3;attempt++) {
            const before=unwrapRemoteRead(await this.adapter.readRemote(record.path,true));
            if (!expected && before) {
                await this.freezeConflict(record,undefined,content,before,'A remote file appeared before the first upload',[]); return;
            }
            if (expected && (!before || !sameRevision(before.revision,expected))) {
                if (before && record.base?.hash===before.hash) { expected=before.revision; continue; }
                await this.freezeConflict(record,await this.store.getObject(record.base?.objectId),content,before,
                    before?'Overleaf changed before upload':'Overleaf was deleted while the local file changed',[]); return;
            }
            const operationId=this.suppressor.register('remote',record.path,contentHash(content));
            const journal=await this.store.beginJournal({operationId,path:record.path,operation:'upload',targetHash:contentHash(content),
                remoteBeforeObjectId:before&&await this.store.putObject(before.content),expectedRevision:before?.revision,
                connectionEpoch:before?.connectionEpoch??this.adapter.connectionEpoch?.(),originalEntityId:before?.entityId,
                temporaryPath:record.kind==='binary'?binaryTemporaryPath(record.path,operationId):undefined});
            const result=await this.adapter.applyRemote(record.path,before?.revision,content,record.kind,operationId);
            journal.temporaryEntityId=result.temporaryEntityId; journal.temporaryPath=result.temporaryPath??journal.temporaryPath;
            if (result.type==='verified' && result.snapshot && equalContent(result.snapshot.content,content) && result.snapshot.connectionEpoch===journal.connectionEpoch) {
                journal.phase='remote-applied'; await this.store.putJournal(journal);
                const localAfter=await this.adapter.readLocal(record.path);
                if (!equalContent(localAfter,content)) { record.status='pending-upload'; record.message='Local file changed during upload; the newer local content was preserved'; return; }
                if (await this.commitBase(record,content,result.snapshot)) { await this.store.removeJournal(journal.id); return; }
                journal.phase='unknown'; await this.store.putJournal(journal);
                record.status='pending-upload'; record.message='Upload was verified on an obsolete connection; baseline was not changed'; return;
            }
            if (result.type==='conflict' && result.snapshot && record.base?.hash===result.snapshot.hash) {
                // Version advanced but content still equals the base: retrying cannot discard content.
                await this.store.removeJournal(journal.id);
                expected=result.snapshot.revision; continue;
            }
            if (result.type==='conflict') {
                await this.store.removeJournal(journal.id);
                const base=await this.store.getObject(record.base?.objectId);
                await this.freezeConflict(record,base,content,result.snapshot,'Remote changed during upload',[]);
                return;
            }
            journal.phase=result.type==='unknown'?'unknown':journal.phase; await this.store.putJournal(journal);
            if (result.type==='unknown' && record.kind==='binary' && journal.temporaryPath) {
                this.blockedRecovery.set(pathComparisonKey(record.path),journal);
            }
            record.status='pending-upload'; record.message=result.message??'Upload could not be verified'; return;
        }
        record.status='pending-upload'; record.message='Remote revision changed repeatedly; upload was paused';
    }

    private async download(record:FileSyncRecord,_remote:RemoteSnapshot,expectedLocalHash?:string):Promise<void> {
        if (this.adapter.isLocalDirty(record.path)) { record.status='pending-download'; record.message='Editor has unsaved changes'; return; }
        const [latestResult,currentLocal,base]=await Promise.all([this.adapter.readRemote(record.path,true),this.adapter.readLocal(record.path),this.store.getObject(record.base?.objectId)]);
        const latest=unwrapRemoteRead(latestResult);
        if (!latest) { await this.freezeConflict(record,base,currentLocal,undefined,'Overleaf deleted the file before download',[]); return; }
        if (contentHash(currentLocal)!==expectedLocalHash) { await this.freezeConflict(record,base,currentLocal,latest,'Local file changed before download',[]); return; }
        const operationId=this.suppressor.register('local',record.path,latest.hash);
        const entry=await this.store.atomicLocalWrite(record.path,latest.content,'download',operationId,expectedLocalHash,true);
        const verify=await this.adapter.readLocal(record.path);
        if (!equalContent(verify,latest.content)) { throw new Error('Local write verification failed'); }
        const remoteAfter=unwrapRemoteRead(await this.adapter.readRemote(record.path,true));
        if (!remoteAfter || !sameRevision(remoteAfter.revision,latest.revision) || remoteAfter.connectionEpoch!==latest.connectionEpoch) {
            record.status='pending-download'; record.message='Overleaf changed during download; local and remote versions were preserved'; return;
        }
        if (await this.commitBase(record,latest.content,remoteAfter)) { await this.store.removeJournal(entry.id); }
        else { record.status='pending-download'; record.message='Connection changed during download verification; baseline was not changed'; }
    }

    private async merge(record:FileSyncRecord,content:Uint8Array,remote:RemoteSnapshot):Promise<void> {
        if (this.adapter.isLocalDirty(record.path)) { record.status='error'; record.suspension='dirty-buffer'; record.message='Editor has unsaved changes'; return; }
        const currentLocal=await this.adapter.readLocal(record.path);
        if (contentHash(currentLocal)!==record.observed.localHash) {
            await this.freezeConflict(record,await this.store.getObject(record.base?.objectId),currentLocal,unwrapRemoteRead(await this.adapter.readRemote(record.path,true)),'Local file changed before applying the merge',[]); return;
        }
        const operationId=this.suppressor.register('local',record.path,contentHash(content));
        const entry=await this.store.atomicLocalWrite(record.path,content,'merge',operationId,record.observed.localHash,true);
        entry.remoteBeforeObjectId=await this.store.putObject(remote.content); entry.expectedRevision=remote.revision; entry.connectionEpoch=remote.connectionEpoch??this.adapter.connectionEpoch?.(); await this.store.putJournal(entry);
        this.suppressor.register('remote',record.path,contentHash(content),operationId);
        const result=await this.adapter.applyRemote(record.path,remote.revision,content,record.kind,operationId);
        if (result.type==='verified' && result.snapshot && equalContent(result.snapshot.content,content) && result.snapshot.connectionEpoch===entry.connectionEpoch) {
            entry.phase='remote-applied'; await this.store.putJournal(entry);
            if (await this.commitBase(record,content,result.snapshot)) { await this.store.removeJournal(entry.id); }
            else { entry.phase='unknown'; await this.store.putJournal(entry); record.status='pending-upload'; record.message='Merge verification crossed a connection boundary'; }
        } else { record.status='pending-upload'; record.message='Merged local file is safe; remote upload remains pending'; }
    }

    private async deleteLocal(record:FileSyncRecord,revision?:RemoteRevision,expectedLocalHash=record.base?.hash,expectedEpoch=this.adapter.connectionEpoch?.()):Promise<void> {
        if (this.adapter.isLocalDirty(record.path)) { record.status='error'; record.suspension='dirty-buffer'; record.message='Cannot delete a file with unsaved edits'; return; }
        const operationId=this.suppressor.register('local',record.path,undefined);
        const entry=await this.withTreeLock(()=>this.store.atomicLocalDelete(record.path,operationId,expectedLocalHash));
        let remote:RemoteSnapshot|undefined;
        try { remote=unwrapRemoteRead(await this.adapter.readRemote(record.path,true)); }
        catch (error:any) { record.status='error'; record.message=`Local deletion is backed up; remote absence could not be verified: ${error?.message??String(error)}`; return; }
        if (remote || (expectedEpoch!==undefined && this.adapter.connectionEpoch?.()!==expectedEpoch)) {
            await this.freezeConflict(record,await this.store.getObject(record.base?.objectId),undefined,remote,'Overleaf changed while applying a local deletion',[]); return;
        }
        delete this.state.files[record.key]; await this.store.removeJournal(entry.id);
    }

    private async deleteRemote(record:FileSyncRecord,revision?:RemoteRevision):Promise<void> {
        const before=unwrapRemoteRead(await this.adapter.readRemote(record.path,true));
        const operationId=this.suppressor.register('remote',record.path,undefined);
        const journal=await this.store.beginJournal({operationId,path:record.path,operation:'delete-remote',expectedRevision:revision,
            remoteBeforeObjectId:before&&await this.store.putObject(before.content),originalEntityId:before?.entityId,
            connectionEpoch:before?.connectionEpoch??this.adapter.connectionEpoch?.()});
        const result=await this.withTreeLock(()=>this.adapter.deleteRemote(record.path,revision));
        const currentEpoch=this.adapter.connectionEpoch?.();
        const epochVerified=currentEpoch===undefined ? result.connectionEpoch===undefined : result.connectionEpoch===currentEpoch;
        if (result.type==='verified' && epochVerified) {
            journal.phase='remote-applied'; await this.store.putJournal(journal); delete this.state.files[record.key]; await this.store.removeJournal(journal.id);
        }
        else if (result.type==='conflict' && result.snapshot) {
            await this.store.removeJournal(journal.id);
            await this.freezeConflict(record,await this.store.getObject(record.base?.objectId),await this.adapter.readLocal(record.path),result.snapshot,'Overleaf changed before deletion',[]);
        } else { record.status='error'; record.message=result.message??'Remote deletion verification crossed a connection boundary'; }
    }

    private async handleRemoteMove(record:FileSyncRecord,newPath:string,cause:'bootstrap'|'local'|'remote'|'manual'):Promise<void> {
        if (!await this.allowPath(newPath) || !await this.allowPath(record.path)) { return; }
        const [oldLocal,newLocal,remote,base]=await Promise.all([
            this.adapter.readLocal(record.path),this.adapter.readLocal(newPath),this.adapter.readRemote(newPath,true).then(unwrapRemoteRead),this.store.getObject(record.base?.objectId),
        ]);
        if (!remote) { await this.setFrozen(record.path,`Remote move target is unavailable: ${newPath}`); return; }
        if (!oldLocal && newLocal && equalContent(newLocal,base)) {
            record.path=normalizePath(newPath); record.entityId=remote.entityId; await this.reconcilePath(record.path,cause); return;
        }
        if (oldLocal && !newLocal && equalContent(oldLocal,base) && !this.adapter.isLocalDirty(record.path)) {
            const operationId=this.suppressor.register('local',record.path,undefined); this.suppressor.register('local',newPath,contentHash(oldLocal),operationId);
            const journal=await this.withTreeLock(()=>this.store.atomicLocalMove(record.path,newPath,operationId,record.base?.hash));
            record.path=normalizePath(newPath); record.entityId=remote.entityId;
            await this.reconcilePath(record.path,cause);
            if (record.status==='clean') { await this.store.removeJournal(journal.id); }
            return;
        }
        await this.freezeConflict(record,base,oldLocal,remote,`Remote moved ${record.path} to ${newPath}, but the local source changed or the target exists`,[]);
    }

    private async tryLocalRename(record:FileSyncRecord,remote:RemoteSnapshot):Promise<boolean> {
        if (!record.base || remote.hash!==record.base.hash || !this.adapter.findLocalPathsByHash || !this.adapter.renameRemote) { return false; }
        const candidates=await this.adapter.findLocalPathsByHash(record.base.hash,record.path);
        if (candidates.length!==1) { return false; }
        const newPath=candidates[0];
        if (!await this.allowPath(newPath)) { return false; }
        const remoteTarget=unwrapRemoteRead(await this.adapter.readRemote(newPath,true));
        if (remoteTarget) {
            await this.freezeConflict(record,await this.store.getObject(record.base.objectId),undefined,remoteTarget,`Local rename target already exists on Overleaf: ${newPath}`,[]);
            return true;
        }
        const operationId=this.suppressor.register('remote',record.path,undefined); this.suppressor.register('remote',newPath,remote.hash,operationId);
        const journal=await this.store.beginJournal({operationId,path:newPath,sourcePath:record.path,operation:'move-remote',targetHash:record.base.hash,
            remoteBeforeObjectId:await this.store.putObject(remote.content),expectedRevision:remote.revision,
            originalEntityId:remote.entityId,connectionEpoch:remote.connectionEpoch??this.adapter.connectionEpoch?.()});
        const result=await this.withTreeLock(()=>this.adapter.renameRemote!(record.path,newPath,remote.revision));
        if (result.type==='verified' && result.snapshot) {
            journal.phase='remote-applied'; await this.store.putJournal(journal);
            record.path=normalizePath(newPath); record.entityId=result.snapshot.entityId;
            const local=await this.adapter.readLocal(newPath);
            if (local && equalContent(local,result.snapshot.content)) {
                if (await this.commitBase(record,local,result.snapshot)) { await this.store.removeJournal(journal.id); }
                else { journal.phase='unknown'; await this.store.putJournal(journal); record.status='error'; record.message='Rename verification crossed a connection boundary'; }
            } else { record.status='error'; record.message='Remote rename succeeded but local verification failed; the local file was preserved for review'; }
        } else if (result.type==='conflict') {
            await this.store.removeJournal(journal.id);
            await this.freezeConflict(record,await this.store.getObject(record.base.objectId),undefined,result.snapshot,'Remote changed during rename',[]);
        } else { record.status='error'; record.message=result.message??'Remote rename could not be verified'; }
        return true;
    }

    private async refreshUnresolvedConflict(record:FileSyncRecord,local:Uint8Array|undefined,remote:RemoteSnapshot|undefined):Promise<void> {
        const conflict=await this.store.readConflict(record.pendingConflictId!);
        if (!conflict) {
            await this.setError(record.path,'The unresolved conflict record is unavailable. Synchronization remains paused.');
            return;
        }
        const localHash=contentHash(local);
        record.observed={localHash,remoteHash:remote?.hash};
        if (localHash!==conflict.localHash || remote?.hash!==conflict.remoteHash || !sameRevision(remote?.revision,conflict.remoteRevision)) {
            const base=await this.store.getObject(conflict.baseObjectId);
            if (conflict.baseObjectId && !base) {
                await this.setError(record.path,'The conflict base is unavailable. Synchronization remains paused.');
                return;
            }
            const decision=reconcile({base,local,remote:remote?.content,kind:record.kind,mode:'manual',cause:'manual'});
            await this.freezeConflict(record,base,local,remote,
                decision.reason??'Versions changed while this conflict was unresolved. Review them before completing the merge.',
                decision.hunks??[],decision.merged);
        } else {
            record.status='conflict';
            record.message=conflict.reason;
        }
        await this.persist();
    }

    private async freezeConflict(record:FileSyncRecord,base:Uint8Array|undefined,local:Uint8Array|undefined,remote:RemoteSnapshot|undefined,reason:string,hunks:any[],draft?:Uint8Array):Promise<void> {
        const existing=record.pendingConflictId?await this.store.readConflict(record.pendingConflictId):undefined;
        const conflict:ConflictRecord={id:record.pendingConflictId??randomUUID(),path:record.path,kind:record.kind,reason,
            baseObjectId:base&&await this.store.putObject(base),localObjectId:local&&await this.store.putObject(local),
            remoteObjectId:remote&&await this.store.putObject(remote.content),draftObjectId:draft?await this.store.putObject(draft):existing?.draftObjectId,
            localHash:local&&contentHash(local),remoteHash:remote?.hash,remoteRevision:remote?.revision,hunks,resolvedHunks:[],hunkChoices:{},createdAt:existing?.createdAt??Date.now()};
        await this.store.saveConflict(conflict,true); record.pendingConflictId=conflict.id; record.status='conflict'; record.message=reason;
    }

    private async commitBase(record:FileSyncRecord,content:Uint8Array,remote?:RemoteSnapshot):Promise<boolean> {
        if (!remote || !equalContent(remote.content,content) || remote.hash!==contentHash(content)) {
            record.status='error'; record.message='Cannot establish a base without matching verified remote content'; return false;
        }
        const currentEpoch=this.adapter.connectionEpoch?.();
        if (currentEpoch!==undefined && (remote.connectionEpoch===undefined || remote.connectionEpoch!==currentEpoch)) {
            record.status='error'; record.message='Connection changed before baseline commit'; return false;
        }
        const local=await this.adapter.readLocal(record.path);
        if (!equalContent(local,content)) {
            record.status='error'; record.message='Local content changed before baseline commit'; return false;
        }
        const existing=this.state.files[remote.entityId];
        if (existing && existing!==record) {
            record.status='error'; record.message=`Remote entity ${remote.entityId} is already associated with another sync record`; return false;
        }
        const hash=contentHash(content)!;
        if (record.key!==remote.entityId) {
            delete this.state.files[record.key]; record.key=remote.entityId; this.state.files[record.key]=record;
        }
        record.entityId=remote.entityId;
        record.base={objectId:await this.store.putObject(content),hash,remoteRevision:remote.revision};
        record.observed={localHash:hash,remoteHash:hash}; record.status='clean'; record.message=undefined; record.pendingConflictId=undefined;
        if (remote.connectionEpoch!==undefined) {
            this.compileConfirmations.set(pathComparisonKey(record.path),{hash,epoch:remote.connectionEpoch});
        }
        await this.adapter.establishText?.(record.path,remote);
        return true;
    }

    private async syncOnlineText(path:string):Promise<boolean> {
        const record=this.find(path);
        if (!this.adapter.syncText || this.mode!=='safeAuto' || !record?.base || record.kind!=='text'
            || record.pendingConflictId || record.suspension==='blocked' || record.suspension==='ignored'
            || this.blockedRecovery.has(pathComparisonKey(path)) || this.blockedLocalRecovery.has(normalizePath(path))) { return false; }
        if (!await this.allowPath(path)) { return true; }
        try {
            const result=await this.adapter.syncText(path);
            if (!result) { return false; }
            await this.commitBase(record,result.local,result.snapshot);
            record.suspension=undefined;
            await this.persist();
        } catch (error:any) { await this.setError(path,error.message); }
        return true;
    }

    private async setError(path:string,message:string):Promise<void> {
        const record=this.find(path)??{key:`local:${path}`,path,kind:'binary' as const,observed:{},status:'error' as const};
        this.state.files[record.key]=record; record.status='error'; record.message=message; await this.persist();
    }
    private async setFrozen(path:string,message:string):Promise<void> {
        const normalized=normalizePath(path);
        const record=this.find(normalized)??{key:`local:${normalized}`,path:normalized,kind:'binary' as const,observed:{},status:'error' as const};
        this.state.files[record.key]=record; record.status='error'; record.suspension='blocked'; record.message=message; await this.persist();
    }
    private async persist():Promise<void> { await this.store.saveState(this.state); const records=this.records(); this.emitter.forEach(listener=>listener(records)); }
}

function normalizePath(value:string):string { return value.replace(/\\/g,'/').replace(/^\/+|\/+$/g,''); }
function sameRevision(a?:RemoteRevision,b?:RemoteRevision):boolean {
    if (!a || !b || a.kind!==b.kind || a.contentHash!==b.contentHash) { return a===undefined && b===undefined; }
    return a.kind==='document' && b.kind==='document' ? a.documentVersion===b.documentVersion : a.kind==='file' && b.kind==='file' && a.entityId===b.entityId;
}
const TEXT_EXTENSIONS=new Set([
    'tex','bib','bst','cls','sty','ltx','dtx','ins','def','cfg','clo','bbx','cbx','lbx',
    'txt','md','markdown','rst','csv','tsv','json','jsonl','yaml','yml','xml','html','htm',
    'css','js','mjs','cjs','ts','py','r','lua','sh','bash','zsh','fish','pl','pm','rb','java',
    'c','h','cc','cpp','cxx','hpp','hh','m','mm','go','rs','toml','ini','conf','properties',
    'gnuplot','gp','tikz','pgf','asy','mf','mp',
]);

function detectKind(path:string,content?:Uint8Array):FileKind {
    if (!content) { return 'binary'; }
    const name=path.slice(path.lastIndexOf('/')+1);
    const extension=name.includes('.')?name.slice(name.lastIndexOf('.')+1).normalize('NFC').toLocaleLowerCase('en-US'):'';
    if (!TEXT_EXTENSIONS.has(extension)) { return 'binary'; }
    try { new TextDecoder('utf-8',{fatal:true}).decode(content); return 'text'; } catch { return 'binary'; }
}
function containsConflictMarkers(content:Uint8Array):boolean {
    try { return /^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(new TextDecoder('utf-8',{fatal:true}).decode(content)); }
    catch { return false; }
}
function binaryTemporaryPath(path:string,operationId:string):string {
    const slash=path.lastIndexOf('/'),directory=slash<0?'':path.slice(0,slash+1),name=path.slice(slash+1);
    return `${directory}.overleaf-sync-${operationId}-${name}`;
}
