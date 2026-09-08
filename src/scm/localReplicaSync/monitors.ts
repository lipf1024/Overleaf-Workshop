import * as vscode from 'vscode';
import * as path from 'path';
import { contentHash } from './hash';
import { coalesceTreePaths, isInternalReplicaPath } from './pathSafety';
import { PathPolicy } from './pathPolicy';

export class LocalChangeMonitor implements vscode.Disposable {
    private readonly watcher:vscode.FileSystemWatcher;
    private readonly timers=new Map<string,NodeJS.Timeout>();
    private readonly tasks=new Set<Promise<void>>();
    private treeTimer?:NodeJS.Timeout;
    private readonly pendingDeletes=new Set<string>();
    private readonly activeDeletes=new Set<string>();
    private readonly disposables:vscode.Disposable[]=[];
    private disposed=false;
    constructor(private readonly root:vscode.Uri,private readonly callback:(path:string,stable:boolean)=>Promise<void>,private readonly rescan:()=>Promise<void>,private readonly treeDelete:(path:string)=>Promise<void>,private readonly policy:PathPolicy,private readonly onError:(error:unknown)=>void=console.error) {
        this.watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root,'**/*'));
        const schedule=(uri:vscode.Uri)=>this.schedule(uri);
        this.disposables.push(this.watcher,this.watcher.onDidCreate(schedule),this.watcher.onDidChange(schedule),this.watcher.onDidDelete(uri=>this.scheduleTreeDelete(uri)),
            vscode.workspace.onDidSaveTextDocument(doc=>{ if (this.contains(doc.uri)) { this.schedule(doc.uri); } }));
    }
    private track(task:Promise<void>):void {
        const settled=task.catch(this.onError).finally(()=>this.tasks.delete(settled)); this.tasks.add(settled);
    }
    async whenIdle():Promise<void> { await Promise.all([...this.tasks]); }
    private contains(uri:vscode.Uri):boolean { const prefix=this.root.fsPath.endsWith(path.sep)?this.root.fsPath:this.root.fsPath+path.sep; return uri.scheme==='file' && uri.fsPath.startsWith(prefix); }
    private schedule(uri:vscode.Uri):void {
        if (this.disposed || !this.contains(uri)) { return; }
        const relative=uri.fsPath.slice(this.root.fsPath.length).replace(/\\/g,'/').replace(/^\//,'');
        if (!relative || isInternalReplicaPath(relative)) { return; }
        const existing=this.timers.get(relative); if (existing) { clearTimeout(existing); }
        this.timers.set(relative,setTimeout(()=>{ this.timers.delete(relative); this.track(this.waitStable(relative)); },500));
    }
    private scheduleTreeDelete(uri:vscode.Uri):void {
        if (this.disposed || !this.contains(uri)) { return; }
        const relative=uri.fsPath.slice(this.root.fsPath.length).replace(/\\/g,'/').replace(/^\//,'');
        if (!relative || isInternalReplicaPath(relative)) { return; }
        for (const [candidate,timer] of this.timers) {
            if (candidate===relative || candidate.startsWith(`${relative}/`)) { clearTimeout(timer); this.timers.delete(candidate); }
        }
        this.pendingDeletes.add(relative);
        if (this.treeTimer) { clearTimeout(this.treeTimer); }
        this.treeTimer=setTimeout(()=>this.track(this.flushDeletes()),500);
    }
    private async flushDeletes():Promise<void> {
        if (this.disposed) { return; }
        const paths=coalesceTreePaths([...this.pendingDeletes]); this.pendingDeletes.clear(); paths.forEach(value=>this.activeDeletes.add(value));
        try { for (const relative of paths) { if (this.disposed) { return; } await this.treeDelete(relative); } }
        finally { paths.forEach(value=>this.activeDeletes.delete(value)); }
    }
    private async waitStable(relative:string):Promise<void> {
        const deadline=Date.now()+5000; let previous:string|undefined;
        while (!this.disposed && Date.now()<deadline) {
            if (this.isDeleting(relative)) { return; }
            const decision=await this.policy.check(relative);
            if (this.disposed) { return; }
            if (decision.type!=='allowed') { await this.callback(relative,true); return; }
            const stat=await this.policy.access.stat(relative);
            if (this.disposed) { return; }
            if (stat?.isDirectory()) { await this.rescan(); return; }
            const bytes=await this.policy.access.read(relative);
            if (this.disposed || this.isDeleting(relative)) { return; }
            const signature=contentHash(bytes)??'deleted';
            if (signature===previous) { await this.callback(relative,true); return; }
            previous=signature; await new Promise(resolve=>setTimeout(resolve,100));
        }
        if (!this.disposed && !this.isDeleting(relative)) { await this.callback(relative,false); }
    }
    private isDeleting(relative:string):boolean {
        return [...this.pendingDeletes,...this.activeDeletes].some(parent=>relative===parent || relative.startsWith(`${parent}/`));
    }
    dispose():void { this.disposed=true; this.pendingDeletes.clear(); this.activeDeletes.clear(); this.timers.forEach(timer=>clearTimeout(timer)); if (this.treeTimer) { clearTimeout(this.treeTimer); } this.disposables.forEach(item=>item.dispose()); }
}

export class RemoteChangeMonitor implements vscode.Disposable {
    private readonly watcher:vscode.FileSystemWatcher;
    private readonly disposables:vscode.Disposable[]=[];
    private readonly tasks=new Set<Promise<void>>();
    private treeTimer?:NodeJS.Timeout;
    private readonly pendingDeletes=new Set<string>();
    private disposed=false;
    constructor(root:vscode.Uri,private readonly toPath:(uri:vscode.Uri)=>string,callback:(path:string)=>Promise<void>,treeDelete:(path:string)=>Promise<void>,private readonly onError:(error:unknown)=>void=console.error) {
        this.watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root,'**/*'));
        const changed=(uri:vscode.Uri)=>{ if (this.disposed) { return; } const relative=this.toPath(uri); if (relative) { this.track(callback(relative)); } };
        this.disposables.push(this.watcher,this.watcher.onDidCreate(changed),this.watcher.onDidChange(changed),this.watcher.onDidDelete(uri=>{
            if (this.disposed) { return; }
            const relative=this.toPath(uri); if (!relative) { return; }
            this.pendingDeletes.add(relative); if (this.treeTimer) { clearTimeout(this.treeTimer); }
            this.treeTimer=setTimeout(()=>this.track(this.flushDeletes(treeDelete)),500);
        }));
    }
    private track(task:Promise<void>):void {
        const settled=task.catch(this.onError).finally(()=>this.tasks.delete(settled)); this.tasks.add(settled);
    }
    async whenIdle():Promise<void> { await Promise.all([...this.tasks]); }
    private async flushDeletes(callback:(path:string)=>Promise<void>):Promise<void> {
        if (this.disposed) { return; }
        const paths=coalesceTreePaths([...this.pendingDeletes]); this.pendingDeletes.clear();
        for (const relative of paths) { if (this.disposed) { return; } await callback(relative); }
    }
    dispose():void { this.disposed=true; this.pendingDeletes.clear(); if (this.treeTimer) { clearTimeout(this.treeTimer); } this.disposables.forEach(item=>item.dispose()); }
}
