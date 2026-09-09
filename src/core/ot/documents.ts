import { createHash } from 'crypto';
import { SyncStateStore } from '../../scm/localReplicaSync/stateStore';
import { OtSession, OtTransport, OtUpdate } from './session';
import { TextOperation, textDiff, textOT } from './text';
import { mergeText } from '../../scm/localReplicaSync/merge';

export interface JoinedDocument {docLines:string[];version:number;updates:OtUpdate[]}
export interface DocumentTransport {
    join(id:string,version?:number):Promise<JoinedDocument>;
    source():string|undefined;
    send(update:OtUpdate):Promise<void>;
    changed(id:string,session:OtSession,remote:boolean,savedOperation?:TextOperation):void;
    error(id:string,error:Error):void;
    log(id:string,stage:string,elapsed:number):void;
}

/** Owns both the subscription and the version; consumers must never join behind it. */
export class OtDocuments {
    private entries=new Map<string,{session?:OtSession;loading?:Promise<OtSession>;buffer:OtUpdate[]}>();
    private closed=false;
    constructor(private readonly store:SyncStateStore,private readonly transport:DocumentTransport,private readonly prepared:PromiseLike<unknown>=Promise.resolve()) {}
    peek(id:string):OtSession|undefined { return this.entries.get(id)?.session; }
    get(id:string):Promise<OtSession> {
        let entry=this.entries.get(id);
        if (!entry) { entry={buffer:[]}; this.entries.set(id,entry); }
        if (entry.loading) { return entry.loading; }
        if (entry.session?.ready) { return Promise.resolve(entry.session); }
        const current=entry;
        current.loading=(async()=>{
            await this.prepared;
            const key=createHash('sha256').update(id).digest('hex');
            let journal=current.session?await current.session.checkpoint():await this.store.readOtJournal(key);
            if (journal && journal.doc!==id) { throw new Error('OT journal belongs to another document'); }
            let joined:JoinedDocument;
            try { joined=await this.transport.join(id,journal?.version); }
            catch (error) {
                // A clean journal contains no local intent to replay. Expired history
                // can therefore be replaced with a fresh snapshot; pending intent cannot.
                if (!journal || journal.inflight) { throw error; }
                joined=await this.transport.join(id);
                if (!journal.pending.length && !journal.draft.length) { journal=undefined; }
                else {
                    const confirmed=joined.docLines.join('\n');
                    const saved=textOT.apply(journal.confirmed,journal.pending);
                    const merged=mergeText(Buffer.from(journal.confirmed),Buffer.from(saved),Buffer.from(confirmed));
                    const candidate=merged.merged&&Buffer.from(merged.merged).toString('utf8');
                    if (merged.kind==='conflict' || candidate===undefined) { throw new Error('Offline saved changes overlap with Overleaf; manual conflict review required. The OT journal was retained.'); }
                    const editor=textOT.apply(saved,journal.draft);
                    const draft=mergeText(Buffer.from(saved),Buffer.from(editor),Buffer.from(candidate));
                    if (draft.kind==='conflict' || !draft.merged) { throw new Error('Offline unsaved changes overlap with Overleaf; the recovery journal was retained for review.'); }
                    await this.store.archiveOtJournal(key,journal);
                    journal={...journal,version:joined.version,confirmed,pending:textDiff(confirmed,candidate),draft:textDiff(candidate,Buffer.from(draft.merged).toString('utf8'))};
                    joined={...joined,updates:[]};
                }
            }
            if (this.closed) { throw new Error('OT documents closed during join'); }
            const callbacks:OtTransport={
                source:()=>this.transport.source(),send:update=>this.transport.send(update),
                persist:journal=>this.store.writeOtJournal(key,journal),
                changed:(_saved,_editor,remote,op)=>this.transport.changed(id,current.session!,remote,op),
                log:(stage,elapsed)=>this.transport.log(id,stage,elapsed),
            };
            if (journal) {
                current.session?.dispose();
                current.session=new OtSession(journal,callbacks);
                current.session.disconnect();
                await current.session.resume(joined.updates,joined.version,joined.docLines.join('\n'));
            } else {
                current.session=OtSession.fresh(id,joined.version,joined.docLines.join('\n'),callbacks);
                await this.store.writeOtJournal(key,current.session.snapshot());
            }
            for (const update of current.buffer.splice(0)) { await current.session.receive(update); }
            this.transport.changed(id,current.session,false);
            return current.session;
        })().catch(error=>{ current.session?.fail(error); this.transport.error(id,error); throw error; }).finally(()=>{ current.loading=undefined; });
        return current.loading;
    }
    receive(update:OtUpdate):boolean {
        const entry=this.entries.get(update.doc);
        if (!entry) { return false; }
        if (entry.loading || !entry.session) { entry.buffer.push(update); }
        else { void entry.session.receive(update).catch(error=>this.transport.error(update.doc,error)); }
        return true;
    }
    disconnect():void { for (const entry of this.entries.values()) { entry.session?.disconnect(); } }
    async reconnect():Promise<void> { await Promise.allSettled([...this.entries.keys()].map(id=>this.get(id))); }
    barrier(ids?:readonly string[]):Promise<void> {
        const entries=ids?[...new Set(ids)].map(id=>this.entries.get(id)):[...this.entries.values()];
        return Promise.all(entries.map(entry=>entry?.session?.barrier())).then(()=>undefined);
    }
    dispose():void {
        this.closed=true;
        for (const entry of this.entries.values()) { entry.session?.dispose(); }
        // Let pending atomic writes finish before relinquishing the process lock.
        void Promise.allSettled([...this.entries.values()].map(entry=>entry.session?.barrier())).then(()=>this.store.close());
    }
}
