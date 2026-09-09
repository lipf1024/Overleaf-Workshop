import * as vscode from 'vscode';
import { FileSyncRecord } from './model';
import { ignoredDecoration, syncDecoration } from './syncDecoration';
import { ConflictNotificationTracker, hasUnresolvedConflict } from './conflictState';

export class ConflictPresentation implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly changed=new vscode.EventEmitter<vscode.Uri[]|undefined>();
    readonly onDidChangeFileDecorations=this.changed.event;
    private readonly registration=vscode.window.registerFileDecorationProvider(this);
    private readonly status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,100);
    private readonly notifications=new ConflictNotificationTracker();
    private decorations=new Map<string,vscode.FileDecoration>();
    private records:FileSyncRecord[]=[];
    private notificationTimer?:ReturnType<typeof setTimeout>;
    private disposed=false;

    constructor(private readonly root:vscode.Uri,private readonly openConflict:(id?:string)=>Promise<void>,private readonly isIgnored?:(uri:vscode.Uri)=>Promise<boolean>) {
        this.status.name='Overleaf conflicts';
        this.status.command='overleaf-workshop.localReplica.reviewPending';
        this.status.backgroundColor=new vscode.ThemeColor('statusBarItem.errorBackground');
        this.status.color=new vscode.ThemeColor('statusBarItem.errorForeground');
    }

    update(records:FileSyncRecord[],ready:boolean):void {
        this.records=records.filter(record=>!record.suspension);
        const conflicts=records.filter(record=>!record.suspension && hasUnresolvedConflict(record));
        const previous=this.decorations;
        this.decorations=new Map();
        for (const record of records) {
            const decoration=syncDecoration(record);
            if (decoration) {
                this.decorations.set(vscode.Uri.joinPath(this.root,record.path).toString(),{
                    badge:decoration.badge,color:new vscode.ThemeColor(decoration.color),tooltip:decoration.tooltip,propagate:record.suspension!=='ignored',
                });
            }
        }
        const affected=new Set([...previous.keys(),...this.decorations.keys()]);
        this.changed.fire([...affected].map(uri=>vscode.Uri.parse(uri)));
        if (conflicts.length) {
            this.status.text='$(warning) Overleaf: '+conflicts.length+(conflicts.length===1?' conflict':' conflicts');
            this.status.tooltip='Synchronization is paused for conflicted files. Click to review them in Source Control.';
            this.status.show();
        } else { this.status.hide(); }

        if (!ready) { this.notifications.takeNew(this.records,false); return; }
        if (!this.notificationTimer) {
            this.notificationTimer=setTimeout(()=>{
                this.notificationTimer=undefined;
                void this.notify().catch(error=>console.error('Overleaf conflict notification failed',error));
            },200);
        }
    }

    refreshIgnored():void { this.changed.fire(undefined); }

    provideFileDecoration(uri:vscode.Uri):vscode.ProviderResult<vscode.FileDecoration> {
        const known=this.decorations.get(uri.toString());
        if (known || !this.isIgnored) { return known; }
        return this.isIgnored(uri).then(ignored=>{
            if (!ignored || this.disposed) { return; }
            const decoration=ignoredDecoration();
            return {color:new vscode.ThemeColor(decoration.color),tooltip:decoration.tooltip,propagate:false};
        });
    }

    private async notify():Promise<void> {
        const fresh=this.notifications.takeNew(this.records,true);
        if (!fresh.length || this.disposed) { return; }
        const message=fresh.length===1
            ? 'Overleaf conflict: '+fresh[0].path+'. Synchronization for this file is paused until you resolve it.'
            : fresh.length+' Overleaf files have conflicts. Synchronization for these files is paused until you resolve them.';
        const resolvable=fresh.find(record=>record.pendingConflictId);
        const actions=resolvable?['Open Merge Editor','Show Conflicts']:['Show Conflicts'];
        const choice=await vscode.window.showWarningMessage(message,...actions);
        if (this.disposed) { return; }
        if (choice==='Open Merge Editor') { await this.openConflict(resolvable?.pendingConflictId); }
        if (choice==='Show Conflicts') { await vscode.commands.executeCommand('workbench.view.scm'); }
    }

    dispose():void {
        this.disposed=true;
        if (this.notificationTimer) { clearTimeout(this.notificationTimer); }
        this.registration.dispose();
        this.changed.dispose();
        this.status.dispose();
    }
}
