import * as vscode from 'vscode';

/** One indeterminate Explorer progress bar per active replica batch. */
export class SyncProgress implements vscode.Disposable {
    private pending=0;
    private completed=0;
    private finish?:()=>void;
    private label?:vscode.Disposable;
    private disposed=false;
    constructor(private readonly project:string) {}

    activity(path:string,active:boolean):void {
        if (this.disposed) { return; }
        if (active) {
            if (this.pending++===0) {
                this.completed=0;
                const done=new Promise<void>(resolve=>{this.finish=resolve;});
                void vscode.window.withProgress({location:{viewId:'workbench.explorer.fileView'},title:'Overleaf synchronization'},()=>done);
            }
        } else { this.pending=Math.max(0,this.pending-1); this.completed++; }
        this.label?.dispose(); this.label=undefined;
        if (!this.pending) { this.finish?.(); this.finish=undefined; return; }
        this.label=vscode.window.setStatusBarMessage(`$(sync~spin) ${this.project}: Syncing ${path} (${this.completed}/${this.completed+this.pending} items processed)`);
    }

    dispose():void { this.disposed=true; this.finish?.(); this.finish=undefined; this.label?.dispose(); }
}
