import { textDiff, textOT, TextOperation, validateOperation } from './text';

export interface OtUpdate {doc:string;v:number;op?:TextOperation;lastV?:number;dupIfSource?:string[];meta?:{source?:string}}
export interface OtJournal {
    schemaVersion:1; doc:string; version:number; confirmed:string;
    inflight?:{op:TextOperation;wire:OtUpdate;sources:string[];ticket:number};
    pending:TextOperation; draft:TextOperation; ticket:number; confirmedTicket:number;
}
export interface OtTransport {
    source():string|undefined;
    send(update:OtUpdate):Promise<void>;
    persist(journal:OtJournal):Promise<void>;
    changed(saved:string,editor:string,remote:boolean,savedOperation?:TextOperation):void;
    log(stage:string,elapsed:number):void;
}

/** All protocol mutations are serialized; transport acceptance is never an ACK. */
export class OtSession {
    private queue:Promise<unknown>=Promise.resolve();
    private retry?:NodeJS.Timeout;
    private fatal?:NodeJS.Timeout;
    private failure?:Error;
    private connected=true;
    private waiters:{ticket:number;resolve:()=>void;reject:(error:Error)=>void}[]=[];
    private sentAt=0;
    private editCursor?:string;
    private queued=0;
    private savedHistory:TextOperation[]=[];
    constructor(private state:OtJournal,private readonly transport:OtTransport) {
        if (state.schemaVersion!==1 || !Number.isSafeInteger(state.version) || state.version<0) { throw new Error('Invalid OT recovery journal'); }
        if (typeof state.doc!=='string' || typeof state.confirmed!=='string'
            || !Number.isSafeInteger(state.ticket) || !Number.isSafeInteger(state.confirmedTicket)
            || state.confirmedTicket<0 || state.ticket<state.confirmedTicket
            || (state.inflight && (!Array.isArray(state.inflight.sources) || !state.inflight.sources.every(s=>typeof s==='string')
                || state.inflight.wire.doc!==state.doc || !Number.isSafeInteger(state.inflight.wire.v)
                || state.inflight.wire.v<0 || state.inflight.wire.v>state.version))) { throw new Error('Corrupt OT recovery journal'); }
        validateOperation(state.pending); validateOperation(state.draft);
        if (state.inflight) { validateOperation(state.inflight.op); validateOperation(state.inflight.wire.op); }
        // Validate the entire operation chain before exposing recovered content.
        void this.editor;
    }
    static fresh(doc:string,version:number,confirmed:string,transport:OtTransport):OtSession {
        return new OtSession({schemaVersion:1,doc,version,confirmed,pending:[],draft:[],ticket:0,confirmedTicket:0},transport);
    }
    get version():number { return this.state.version; }
    get id():string { return this.state.doc; }
    get confirmed():string { return this.state.confirmed; }
    get saved():string { return textOT.apply(textOT.apply(this.confirmed,this.state.inflight?.op??[]),this.state.pending); }
    get editor():string { return textOT.apply(this.saved,this.state.draft); }
    get editing():string { return this.editCursor??this.editor; }
    get ready():boolean { return this.connected && !this.failure; }
    get pending():boolean { return !!this.state.inflight || !!this.state.pending.length; }
    snapshot():OtJournal { return JSON.parse(JSON.stringify(this.state)); }
    checkpoint():Promise<OtJournal> { return this.queue.then(()=>this.snapshot()); }
    private serial<T>(action:()=>Promise<T>):Promise<T> {
        this.queued++;
        const task=this.queue.then(async()=>{ if (this.failure) { throw this.failure; } return action(); }).finally(()=>{
            if (--this.queued===0) { this.savedHistory=[]; }
        });
        this.queue=task.catch(error=>{ this.fail(error); });
        return task;
    }
    private async persist():Promise<void> {
        const start=Date.now(); await this.transport.persist(this.snapshot()); this.transport.log('persist',Date.now()-start);
    }
    edit(content:string):Promise<void> {
        const original=this.editCursor??this.editor;
        this.editCursor=content;
        return this.serial(async()=>{
        const [change]=textOT.transformX(textDiff(original,content),textDiff(original,this.editor));
        this.state.draft=textDiff(this.saved,textOT.apply(this.editor,change));
        await this.persist();
        if (this.editCursor===content) { this.editCursor=undefined; }
        this.transport.changed(this.saved,this.editor,false);
    }); }
    /** Called at the save boundary, never for an ordinary keystroke. */
    async save(content:string,onPrepared?:()=>void):Promise<void> {
        let change=textDiff(this.saved,content);
        const historyStart=this.savedHistory.length;
        const ticket=await this.serial(async()=>{
            if (!this.connected) { throw new Error('Connection is unavailable; saved changes remain local'); }
            for (const remote of this.savedHistory.slice(historyStart)) { [change]=textOT.transformX(change,remote); }
            content=textOT.apply(this.saved,change);
            const oldEditor=this.state.draft.length?this.editor:content;
            this.state.pending=textOT.compose(this.state.pending,change);
            // A save may represent an older editor version. Do not upload later typing.
            this.state.draft=textDiff(content,oldEditor);
            this.savedHistory.push(change);
            const ticket=++this.state.ticket;
            await this.persist();
            onPrepared?.();
            this.transport.changed(this.saved,this.editor,false,change);
            await this.flush();
            return ticket;
        });
        await this.waitFor(ticket);
    }
    barrier():Promise<void> { return this.queue.then(()=>this.waitFor(this.state.ticket)); }
    private waitFor(ticket:number):Promise<void> {
        if (this.failure) { return Promise.reject(this.failure); }
        if (!this.connected) { return Promise.reject(new Error('Connection lost; unconfirmed changes retained')); }
        if (this.state.confirmedTicket>=ticket) { return Promise.resolve(); }
        return new Promise((resolve,reject)=>this.waiters.push({ticket,resolve,reject}));
    }
    private settle():void {
        this.waiters=this.waiters.filter(w=>{ if (w.ticket>this.state.confirmedTicket) { return true; } w.resolve(); return false; });
    }
    private async flush():Promise<void> {
        if (!this.connected || this.state.inflight) { return; }
        if (!this.state.pending.length) {
            this.state.confirmedTicket=this.state.ticket; await this.persist(); this.settle(); return;
        }
        const source=this.transport.source();
        if (!source) { throw new Error('Missing collaboration identity'); }
        const wire={doc:this.state.doc,v:this.version,op:this.state.pending,lastV:this.version};
        this.state.inflight={op:this.state.pending,wire,sources:[source],ticket:this.state.ticket};
        this.state.pending=[];
        await this.persist(); // Durable intent, including source ID, MUST precede send.
        this.sentAt=Date.now();
        this.fatal=setTimeout(()=>this.fail(new Error('No OT application confirmation after 45 seconds; changes retained for recovery')),45000);
        await this.send();
    }
    private async send():Promise<void> {
        const flight=this.state.inflight;
        if (!flight || !this.connected) { return; }
        const source=this.transport.source();
        if (!source) { throw new Error('Missing collaboration identity'); }
        if (!flight.sources.includes(source)) { flight.sources.push(source); }
        await this.persist();
        const wire={...flight.wire,dupIfSource:[...flight.sources]};
        // Do not await a socket ACK in the state queue: application echo can arrive first.
        void this.transport.send(wire).catch(error=>this.fail(error));
        this.transport.log('submit',Date.now()-this.sentAt);
        if (this.retry) { clearTimeout(this.retry); }
        this.retry=setTimeout(()=>{ void this.serial(()=>this.send()).catch(()=>undefined); },5000);
    }
    receive(update:OtUpdate):Promise<void> { return this.serial(async()=>{
        if (update.doc!==this.state.doc) { throw new Error('OT document identity mismatch'); }
        if (!Number.isSafeInteger(update.v) || update.v<0) { throw new Error('Invalid OT version'); }
        if (update.v<this.version) { return; } // Repeated, already applied broadcast.
        if (update.v!==this.version) { throw new Error('OT version gap; recovery required'); }
        const flight=this.state.inflight;
        // Official real-time sends {doc,v} to the current sender. Reconnect history
        // instead echoes the full operation with its original meta.source.
        const compact=update.op===undefined;
        if (compact && (!flight || !flight.sources.includes(this.transport.source()??''))) { throw new Error('Unexpected OT acknowledgement'); }
        const own=compact || (!!update.meta?.source && !!flight?.sources.includes(update.meta.source));
        const op=compact ? flight!.op : update.op;
        validateOperation(op);
        let savedOperation:TextOperation|undefined;
        const confirmed=textOT.apply(this.confirmed,op);
        if (own) {
            if (textOT.apply(this.confirmed,flight!.op)!==confirmed) { throw new Error('OT acknowledgement does not match the submitted operation'); }
            this.state.confirmedTicket=flight!.ticket;
            this.state.inflight=undefined;
            this.clearTimers();
            this.transport.log('confirmed',Date.now()-this.sentAt);
        } else {
            let remote=op;
            if (flight) { [flight.op,remote]=textOT.transformX(flight.op,remote); }
            [this.state.pending,remote]=textOT.transformX(this.state.pending,remote);
            savedOperation=remote;
            this.savedHistory.push(remote);
            [this.state.draft]=textOT.transformX(this.state.draft,remote);
        }
        this.state.confirmed=confirmed; this.state.version++;
        await this.persist();
        this.transport.changed(this.saved,this.editor,!own,savedOperation);
        this.settle();
        await this.flush();
    }); }
    disconnect():void {
        this.connected=false; this.clearTimers();
        for (const waiter of this.waiters.splice(0)) { waiter.reject(new Error('Connection lost; unconfirmed changes retained')); }
    }
    /** Caller supplies contiguous history from the persisted version before resuming. */
    async resume(updates:OtUpdate[],version:number,content:string):Promise<void> {
        for (const update of updates) { await this.receive(update); }
        await this.serial(async()=>{
            if (this.version!==version || this.confirmed!==content) { throw new Error('OT recovery history does not match the server snapshot'); }
            this.connected=true;
            if (this.state.inflight) {
                this.sentAt=Date.now();
                this.fatal=setTimeout(()=>this.fail(new Error('OT recovery was not confirmed; changes retained')),45000);
                await this.send();
            } else { await this.flush(); }
        });
    }
    private clearTimers():void { if (this.retry) { clearTimeout(this.retry); } if (this.fatal) { clearTimeout(this.fatal); } this.retry=undefined; this.fatal=undefined; }
    fail(error:Error):void { this.failure=error; this.clearTimers(); for (const w of this.waiters.splice(0)) { w.reject(error); } }
    dispose():void { this.disconnect(); this.fail(new Error('OT session closed; unconfirmed changes retained')); }
}
