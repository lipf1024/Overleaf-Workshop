/** Coalesce edits, but make save/close/shutdown await the exact latest draft. */
export class DraftQueue {
    private readonly pending=new Map<string,{content:Uint8Array;timer:ReturnType<typeof setTimeout>;deadline:ReturnType<typeof setTimeout>}>();
    private readonly writes=new Map<string,Promise<void>>();
    constructor(private readonly save:(id:string,content:Uint8Array)=>Promise<void>,private readonly onError:(error:unknown)=>void,private readonly debounceMs=250,private readonly maxWaitMs=1000) {}
    schedule(id:string,content:Uint8Array):void {
        const previous=this.pending.get(id);
        if (previous) { clearTimeout(previous.timer); }
        const flush=()=>{ void this.flush(id).catch(this.onError); };
        this.pending.set(id,{content:content.slice(),timer:setTimeout(flush,this.debounceMs),deadline:previous?.deadline??setTimeout(flush,this.maxWaitMs)});
    }
    async flush(id?:string):Promise<void> {
        if (id===undefined) { await Promise.all([...new Set([...this.pending.keys(),...this.writes.keys()])].map(key=>this.flush(key))); return; }
        const pending=this.pending.get(id);
        if (pending) {
            clearTimeout(pending.timer); clearTimeout(pending.deadline); this.pending.delete(id);
            const write=(this.writes.get(id)??Promise.resolve()).catch(()=>undefined).then(()=>this.save(id!,pending.content));
            this.writes.set(id,write);
            try { await write; }
            catch (error) { if (!this.pending.has(id)) { this.schedule(id,pending.content); } throw error; }
            finally { if (this.writes.get(id)===write) { this.writes.delete(id); } }
        } else { await this.writes.get(id); }
        if (this.pending.has(id)) { await this.flush(id); }
    }
    cancelTimers():void { for (const entry of this.pending.values()) { clearTimeout(entry.timer); clearTimeout(entry.deadline); } }
}
