/** Trailing debounce by document/project. Running work is never replayed or cancelled. */
export class DebouncedTasks {
    private readonly timers=new Map<string,ReturnType<typeof setTimeout>>();
    schedule(key:string,delay:number,task:()=>void):void {
        this.cancel(key);
        this.timers.set(key,setTimeout(()=>{ this.timers.delete(key); task(); },delay));
    }
    cancel(key:string):void {
        const timer=this.timers.get(key);
        if (timer!==undefined) { clearTimeout(timer); this.timers.delete(key); }
    }
    dispose():void { for (const key of this.timers.keys()) { this.cancel(key); } }
}
