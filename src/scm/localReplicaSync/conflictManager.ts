import { DraftQueue } from './draftQueue';
import * as vscode from 'vscode';
import * as path from 'path';
import { SyncCoordinator } from './coordinator';
import { ConflictRecord } from './model';
import { conflictSnapshotKey } from './conflictState';

export const CONFLICT_SNAPSHOT_SCHEME='overleaf-workshop-conflict';
const APPLY_COMMAND='overleaf-workshop.localReplica.completeMerge';
const MARK_RESOLVED_COMMAND='overleaf-workshop.localReplica.markResolved';
const RESULT_BUTTON_COMMAND='overleaf-workshop.localReplica.markResolvedInEditor';

type ConflictActionTarget=string|vscode.Uri|vscode.SourceControlResourceState;

interface NativeMergeInput {
    readonly base:vscode.Uri;
    readonly input1:vscode.Uri;
    readonly input2:vscode.Uri;
    readonly result:vscode.Uri;
}

// Stable VS Code types expose merge tab inputs as unknown. Feature-detect the
// URI payload instead of enabling the proposed TabInputTextMerge API.
export function isNativeMergeInput(input:unknown):input is NativeMergeInput {
    if (!input || typeof input!=='object') { return false; }
    const candidate=input as Partial<NativeMergeInput>;
    return [candidate.base,candidate.input1,candidate.input2,candidate.result].every(uri=>uri instanceof vscode.Uri);
}

interface MergeSession {
    conflict:ConflictRecord;
    snapshotKey:string;
    base:vscode.Uri;
    local:vscode.Uri;
    remote:vscode.Uri;
    output:vscode.Uri;
    completing:boolean;
    resolved:boolean;
    stale:boolean;
}

/** Immutable inputs stay read-only; the native editor writes a separate draft. */
class ConflictSnapshotFileSystem implements vscode.FileSystemProvider {
    private readonly changed=new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile=this.changed.event;
    watch():vscode.Disposable { return new vscode.Disposable(()=>{}); }
    private file(uri:vscode.Uri):vscode.Uri {
        if (!/\/\.overleaf\/sync\/merge\/[\w-]+\/[a-f0-9]{64}\/(base|local|remote)\/[^/]+$/.test(uri.path)) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return uri.with({scheme:'file',query:'',fragment:''});
    }
    async stat(uri:vscode.Uri):Promise<vscode.FileStat> {
        return {...await vscode.workspace.fs.stat(this.file(uri)),permissions:vscode.FilePermission.Readonly};
    }
    readFile(uri:vscode.Uri):Thenable<Uint8Array> { return vscode.workspace.fs.readFile(this.file(uri)); }
    readDirectory():[string,vscode.FileType][] { return []; }
    createDirectory():never { throw vscode.FileSystemError.NoPermissions('Conflict snapshots are read-only.'); }
    writeFile():never { throw vscode.FileSystemError.NoPermissions('Conflict snapshots are read-only.'); }
    delete():never { throw vscode.FileSystemError.NoPermissions('Conflict snapshots are read-only.'); }
    rename():never { throw vscode.FileSystemError.NoPermissions('Conflict snapshots are read-only.'); }
    dispose():void { this.changed.dispose(); }
}

export class ConflictManager implements vscode.Disposable {
    private static readonly managers=new Set<ConflictManager>();
    private static resourceUsers=0;
    private static resources?:vscode.Disposable;
    private static completeButton?:vscode.StatusBarItem;
    private readonly sessions=new Map<string,MergeSession>();
    private readonly opening=new Map<string,Promise<void>>();
    private readonly disposables:vscode.Disposable[];
    private readonly stopListening:()=>void;
    private disposed=false;
    readonly ready:Promise<void>;
    private readonly drafts:DraftQueue;
    private closing?:Promise<void>;

    /** Register early so restored native merge tabs can read their snapshots. */
    static acquireResources():vscode.Disposable {
        if (!this.resourceUsers++) {
            const provider=new ConflictSnapshotFileSystem();
            const completeButton=vscode.window.createStatusBarItem('overleaf-workshop.completeMerge',vscode.StatusBarAlignment.Left,110);
            completeButton.name=vscode.l10n.t('Mark Conflict as Resolved');
            completeButton.text='$(pass) '+vscode.l10n.t('Mark as Resolved');
            completeButton.tooltip=vscode.l10n.t('Apply the merged result, clear the conflict, and resume synchronization after verification.');
            completeButton.accessibilityInformation={label:vscode.l10n.t('Mark Conflict as Resolved'),role:'button'};
            this.completeButton=completeButton;
            this.resources=vscode.Disposable.from(
                provider,
                completeButton,
                vscode.workspace.registerFileSystemProvider(CONFLICT_SNAPSHOT_SCHEME,provider,{isReadonly:true}),
                vscode.commands.registerCommand(MARK_RESOLVED_COMMAND,(target?:ConflictActionTarget)=>this.markTargetResolved(target)),
                vscode.commands.registerCommand(RESULT_BUTTON_COMMAND,(target?:ConflictActionTarget)=>this.markTargetResolved(target)),
                // Keep the old command ID working for shortcuts and restored tabs.
                vscode.commands.registerCommand(APPLY_COMMAND,(target?:ConflictActionTarget)=>this.markTargetResolved(target)),
            );
        }
        let released=false;
        return new vscode.Disposable(()=>{
            if (released) { return; }
            released=true;
            if (--this.resourceUsers===0) { this.resources?.dispose(); this.resources=undefined; this.completeButton=undefined; }
        });
    }

    constructor(private readonly coordinator:SyncCoordinator,private readonly root:vscode.Uri) {
        this.drafts=new DraftQueue((id,content)=>this.coordinator.saveConflictDraft(id,content,[]),error=>this.reportError(error));
        ConflictManager.managers.add(this);
        this.disposables=[
            ConflictManager.acquireResources(),
            vscode.workspace.onDidChangeTextDocument(event=>{
                const session=this.sessionFor(event.document.uri);
                if (!this.disposed && session && !session.resolved && event.contentChanges.length) {
                    this.drafts.schedule(session.conflict.id,Buffer.from(event.document.getText()));
                }
            }),
            ...(vscode.workspace.onDidSaveTextDocument?[vscode.workspace.onDidSaveTextDocument(document=>{
                const session=this.sessionFor(document.uri);
                if (session && !session.resolved) { this.drafts.schedule(session.conflict.id,Buffer.from(document.getText())); void this.drafts.flush(session.conflict.id).catch(error=>this.reportError(error)); }
            })]:[]),
            vscode.window.tabGroups.onDidChangeTabs(event=>{
                ConflictManager.updateContext();
                for (const tab of event.closed) {
                    if (!isNativeMergeInput(tab.input)) { continue; }
                    const session=this.sessionFor(tab.input.result);
                    if (session && !session.completing && !session.resolved) {
                        void this.drafts.flush(session.conflict.id).then(()=>this.offerApply(session)).catch(error=>this.reportError(error));
                    }
                }
            }),
            vscode.window.tabGroups.onDidChangeTabGroups(()=>ConflictManager.updateContext()),
            vscode.window.onDidChangeActiveTextEditor(()=>ConflictManager.updateContext()),
        ];
        this.stopListening=coordinator.onDidChange(()=>{
            void this.refreshSessions().catch(error=>this.reportError(error));
        });
        this.ready=this.restoreSessions();
        void this.ready.catch(error=>this.reportError(error));
    }

    private async restoreSessions():Promise<void> {
        const directory=vscode.Uri.joinPath(this.root,'.overleaf','sync','merge').path+'/';
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input=tab.input;
                if (!isNativeMergeInput(input) || input.result.scheme!=='file' || !input.result.path.startsWith(directory)) { continue; }
                const [id,version,role,name,...rest]=input.result.path.slice(directory.length).split('/');
                if (!/^[\w-]+$/.test(id) || !/^[a-f0-9]{64}$/.test(version) || role!=='result' || !name || rest.length) { continue; }
                const conflict=await this.coordinator.getConflict(id);
                const key=id+':'+version;
                if (this.disposed) { return; }
                if (!conflict || this.sessions.has(key)) { continue; }
                this.sessions.set(key,{conflict,snapshotKey:version,base:input.base,local:input.input1,remote:input.input2,
                    output:input.result,completing:false,resolved:false,stale:false});
            }
        }
        await this.refreshSessions();
    }

    private static targetForUri(uri:vscode.Uri):{manager:ConflictManager;session:MergeSession}|undefined {
        for (const manager of this.managers) {
            const session=manager.sessionFor(uri)??[...manager.sessions.values()].find(item=>
                [item.base,item.local,item.remote].some(input=>input.toString()===uri.toString()));
            if (session && !session.resolved) { return {manager,session}; }
        }
        return undefined;
    }

    private static pendingTarget(uri:vscode.Uri):{manager:ConflictManager;id:string}|undefined {
        const sessionTarget=this.targetForUri(uri);
        if (sessionTarget) { return {manager:sessionTarget.manager,id:sessionTarget.session.conflict.id}; }
        for (const manager of this.managers) {
            const record=manager.coordinator.records().find(record=>record.pendingConflictId
                && vscode.Uri.joinPath(manager.root,record.path).toString()===uri.toString());
            if (record?.pendingConflictId) { return {manager,id:record.pendingConflictId}; }
        }
        return undefined;
    }

    private static async markTargetResolved(argument?:ConflictActionTarget):Promise<void> {
        const uri=argument instanceof vscode.Uri?argument:argument && typeof argument==='object'?argument.resourceUri:undefined;
        let target=uri?this.pendingTarget(uri):undefined;
        if (typeof argument==='string') {
            for (const manager of this.managers) {
                if (manager.coordinator.records().some(record=>record.pendingConflictId===argument)) { target={manager,id:argument}; break; }
            }
        }
        if (!argument) {
            const active=this.activeTarget();
            if (active) { target={manager:active.manager,id:active.session.conflict.id}; }
            else {
                const input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
                const activeUri=input instanceof vscode.TabInputText?input.uri:vscode.window.activeTextEditor?.document.uri;
                if (activeUri) { target=this.pendingTarget(activeUri); }
            }
            if (!target) {
                const choices=[...this.managers].flatMap(manager=>manager.coordinator.records()
                    .filter(record=>record.pendingConflictId)
                    .map(record=>({label:record.path,description:manager.root.fsPath,manager,id:record.pendingConflictId!})));
                target=choices.length===1?choices[0]:await vscode.window.showQuickPick(choices,{title:vscode.l10n.t('Mark Conflict as Resolved')});
            }
        }
        if (target) { await target.manager.markResolved(target.id); }
        else if (argument) { void vscode.window.showInformationMessage(vscode.l10n.t('No unresolved Overleaf conflict was found for this file.')); }
    }

    private static activeTarget():{manager:ConflictManager;session:MergeSession}|undefined {
        const input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        // The merge tab remains the owner even when an input pane has focus.
        // A normal text tab can also contain a persisted merge draft.
        if (isNativeMergeInput(input)) { return this.targetForUri(input.result); }
        if (input instanceof vscode.TabInputText) { return this.targetForUri(input.uri); }
        const uri=vscode.window.activeTextEditor?.document.uri;
        return uri?this.targetForUri(uri):undefined;
    }

    private static async updateContext():Promise<void> {
        const active=this.activeTarget();
        const input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        const workingUri=input instanceof vscode.TabInputText?input.uri:vscode.window.activeTextEditor?.document.uri;
        const target=active?{manager:active.manager,id:active.session.conflict.id}:workingUri?this.pendingTarget(workingUri):undefined;
        if (target && this.completeButton) {
            this.completeButton.command={command:MARK_RESOLVED_COMMAND,title:vscode.l10n.t('Mark as Resolved'),arguments:[target.id]};
            this.completeButton.show();
        } else { this.completeButton?.hide(); }
        await vscode.commands.executeCommand('setContext','overleaf-workshop.localReplica.mergeActive',Boolean(target));
        const resources=[...this.managers].flatMap(manager=>manager.coordinator.records()
            .filter(record=>record.pendingConflictId).map(record=>vscode.Uri.joinPath(manager.root,record.path).toString()));
        await vscode.commands.executeCommand('setContext','overleaf-workshop.localReplica.conflictResources',resources);
    }

    private sessionFor(uri:vscode.Uri):MergeSession|undefined {
        return [...this.sessions.values()].find(session=>session.output.path===uri.path
            && (uri.scheme==='file' || uri.scheme==='merge-result'));
    }

    async open(id:string):Promise<void> {
        const pending=this.opening.get(id);
        if (pending) { return pending; }
        const operation=this.openNative(id).catch(error=>this.reportError(error));
        this.opening.set(id,operation);
        try { await operation; } finally { this.opening.delete(id); }
    }

    /** Explicit resolution also works after the merge tab has been saved and closed. */
    async markResolved(id:string):Promise<void> {
        if (this.disposed) { return; }
        try {
            const conflict=await this.coordinator.getConflict(id);
            if (!conflict) { void vscode.window.showInformationMessage(vscode.l10n.t('No unresolved Overleaf conflict was found for this file.')); return; }
            if (conflict.kind==='binary') { await this.openBinary(conflict); return; }
            const snapshotKey=conflictSnapshotKey(conflict);
            const active=ConflictManager.activeTarget();
            let session=active?.manager===this && active.session.conflict.id===id?active.session:this.sessions.get(id+':'+snapshotKey);
            if (!session) {
                // Saved results live under the hash of the reviewed input versions.
                // A newer remote version has a different path and requires review.
                if (!/^[\w-]+$/.test(id)) { throw new Error('Invalid conflict identifier.'); }
                const directory=vscode.Uri.joinPath(this.root,'.overleaf','sync','merge',id,snapshotKey);
                const name=path.basename(conflict.path);
                const output=vscode.Uri.joinPath(directory,'result',name);
                try {
                    if (await this.coordinator.readMergeFile(path.relative(this.root.fsPath,output.fsPath).split(path.sep).join('/'))===undefined) {
                        const missing:any=new Error('Merge result is missing'); missing.code='ENOENT'; throw missing;
                    }
                }
                catch (error:any) {
                    if (error?.code!=='ENOENT') { throw error; }
                    await this.open(id);
                    void vscode.window.showInformationMessage(vscode.l10n.t('Review the merged result, then choose Mark as Resolved.'));
                    return;
                }
                const input=(role:string)=>vscode.Uri.joinPath(directory,role,name).with({scheme:CONFLICT_SNAPSHOT_SCHEME});
                session={conflict,snapshotKey,base:input('base'),local:input('local'),remote:input('remote'),output,completing:false,resolved:false,stale:false};
                this.sessions.set(id+':'+snapshotKey,session);
            }
            if (session.completing || session.resolved) { return; }
            const open=vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>
                isNativeMergeInput(tab.input) && tab.input.result.toString()===session!.output.toString()));
            if (open) { await this.complete(session); return; }
            session.completing=true;
            try {
                const document=vscode.workspace.textDocuments.find(doc=>doc.uri.toString()===session!.output.toString());
                if (document?.isDirty && !await document.save()) { throw new Error('The merge result could not be saved.'); }
                await this.applySavedResult(session);
            } finally { session.completing=false; }
        } catch (error) { this.reportError(error); }
    }

    private async openNative(id:string):Promise<void> {
        const conflict=await this.coordinator.getConflict(id);
        if (!conflict) { void vscode.window.showWarningMessage('The sync conflict no longer exists.'); return; }
        if (conflict.kind==='binary') { await this.openBinary(conflict); return; }
        if (!/^[\w-]+$/.test(id)) { throw new Error('Invalid conflict identifier.'); }
        const snapshotKey=conflictSnapshotKey(conflict);
        const version=snapshotKey;
        const key=id+':'+version;
        let session=this.sessions.get(key);
        if (!session) {
            const read=async(objectId?:string):Promise<Uint8Array>=>{
                if (!objectId) { return new Uint8Array(); }
                const content=await this.coordinator.getObject(objectId);
                if (!content) { throw new Error('A conflict snapshot is unavailable. Synchronization remains paused.'); }
                new TextDecoder('utf-8',{fatal:true}).decode(content);
                return content;
            };
            const [base,local,remote,draft]=await Promise.all([
                read(conflict.baseObjectId),read(conflict.localObjectId),read(conflict.remoteObjectId),
                conflict.draftObjectId?read(conflict.draftObjectId):undefined,
            ]);
            const directory=path.join(this.root.fsPath,'.overleaf','sync','merge',id,version);
            const name=path.basename(conflict.path);
            const write=async(role:string,content:Uint8Array):Promise<vscode.Uri>=>{
                const filename=path.join(directory,role,name);
                const document=vscode.workspace.textDocuments.find(doc=>doc.uri.fsPath===filename && doc.isDirty);
                if (role!=='result' || !document) {
                    await this.coordinator.writeMergeFile(path.relative(this.root.fsPath,filename).split(path.sep).join('/'),content);
                }
                const uri=vscode.Uri.file(filename);
                return role==='result'?uri:uri.with({scheme:CONFLICT_SNAPSHOT_SCHEME});
            };
            // Markers ask VS Code to initialize its own merge model, including
            // automatic non-overlapping changes and unresolved-conflict counters.
            const seed=Buffer.from('<<<<<<< Local\n'+Buffer.from(local).toString('utf8')+'\n=======\n'+Buffer.from(remote).toString('utf8')+'\n>>>>>>> Overleaf\n');
            const [baseUri,localUri,remoteUri,output]=await Promise.all([
                write('base',base),write('local',local),write('remote',remote),write('result',draft??seed),
            ]);
            session={conflict,snapshotKey,base:baseUri,local:localUri,remote:remoteUri,output,completing:false,resolved:false,stale:false};
            this.sessions.set(key,session);
        }
        await vscode.commands.executeCommand('_open.mergeEditor',{
            base:session.base,
            input1:{uri:session.local,title:conflict.localObjectId?'Local':'Local (deleted)',description:conflict.path},
            input2:{uri:session.remote,title:conflict.remoteObjectId?'Overleaf':'Overleaf (deleted)',description:conflict.path},
            output:session.output,
        });
        await this.waitForMergeTab(session.output);
        await ConflictManager.updateContext();
    }

    private waitForMergeTab(output:vscode.Uri):Promise<void> {
        const exists=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>
            isNativeMergeInput(tab.input) && tab.input.result.toString()===output.toString()));
        if (exists()) { return Promise.resolve(); }
        return new Promise((resolve,reject)=>{
            const listener=vscode.window.tabGroups.onDidChangeTabs(()=>{
                if (exists()) { clearTimeout(timer); listener.dispose(); resolve(); }
            });
            const timer=setTimeout(()=>{ listener.dispose(); reject(new Error('VS Code did not open the native merge editor.')); },10000);
        });
    }

    private async complete(session:MergeSession):Promise<void> {
        if (session.completing || session.resolved) { return; }
        session.completing=true;
        try {
            let input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            if (!isNativeMergeInput(input) || input.result.toString()!==session.output.toString()) {
                await this.open(session.conflict.id);
                input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
                // Reopening may have loaded newer conflict snapshots. Let the
                // user review those before accepting a result from another tab.
                if (!isNativeMergeInput(input) || input.result.toString()!==session.output.toString()) { return; }
            }
            // Let VS Code check its remaining conflicts and save the exact result.
            const accepted=await this.acceptNativeMerge(session);
            if (!accepted?.successful) { return; }
            await this.applySavedResult(session);
        } catch (error) { this.reportError(error); }
        finally { session.completing=false; }
    }

    private async acceptNativeMerge(session:MergeSession):Promise<{successful:boolean}|undefined> {
        // Opening a native tab does not await its merge model. An undefined
        // command result means it is still loading; no merge was accepted.
        const deadline=Date.now()+5000;
        do {
            const input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            if (!isNativeMergeInput(input) || input.result.toString()!==session.output.toString()) { return; }
            const accepted=await vscode.commands.executeCommand<{successful:boolean}>('mergeEditor.acceptMerge');
            if (accepted) { return accepted; }
            await new Promise(resolve=>setTimeout(resolve,50));
        } while (Date.now()<deadline);
        throw new Error('The merge editor is still loading. Please try completing the merge again.');
    }

    private async applySavedResult(session:MergeSession):Promise<void> {
        if (session.resolved || this.disposed) { return; }
        await this.drafts.flush(session.conflict.id);
        const relative=path.relative(this.root.fsPath,session.output.fsPath).split(path.sep).join('/');
        const content=await this.coordinator.readMergeFile(relative);
        if (!content) { throw new Error('The saved merge result is unavailable'); }
        await this.coordinator.saveConflictDraft(session.conflict.id,content,[]);
        const result=await this.coordinator.resolveConflict(session.conflict.id,content,
            session.conflict.hunks.map((_,index)=>index),session.snapshotKey);
        if (result.ok) {
            session.resolved=true;
            await this.collectGarbage();
            void vscode.window.showInformationMessage(vscode.l10n.t('Marked as resolved: {0}',session.conflict.path));
        } else {
            const reopen=vscode.l10n.t('Reopen Merge Editor');
            void vscode.window.showWarningMessage(result.message??'Conflict remains unresolved. Your merge draft is saved.',reopen).then(choice=>{
                if (choice===reopen && !this.disposed) { void this.open(session.conflict.id); }
            });
        }
        ConflictManager.updateContext();
    }

    private async offerApply(session:MergeSession):Promise<void> {
        if (this.disposed || !await this.coordinator.getConflict(session.conflict.id)) { return; }
        // Native Complete Merge and closing a saved draft both close the tab.
        // Neither is permission to upload: applying always needs an explicit action.
        const mark=vscode.l10n.t('Mark as Resolved'),reopen=vscode.l10n.t('Reopen Merge Editor');
        const choice=await vscode.window.showInformationMessage(
            vscode.l10n.t('The merge for {0} is saved. Mark it as resolved to clear the conflict and resume synchronization.',session.conflict.path),
            mark,reopen);
        if (this.disposed || session.resolved) { return; }
        if (choice===mark) { await this.markResolved(session.conflict.id); }
        if (choice===reopen) { await this.open(session.conflict.id); }
    }

    private async refreshSessions():Promise<void> {
        for (const session of this.sessions.values()) {
            const conflict=await this.coordinator.getConflict(session.conflict.id);
            if (!conflict) { session.resolved=true; continue; }
            if (!session.stale && conflictSnapshotKey(conflict)!==session.snapshotKey) {
                session.stale=true;
                if (!session.completing) {
                    void vscode.window.showWarningMessage('The versions for '+conflict.path+' changed. Your merge draft is preserved; reopen the merge editor before applying it.');
                }
            }
        }
        ConflictManager.updateContext();
    }

    private async openBinary(conflict:ConflictRecord):Promise<void> {
        const choices=[
            {label:conflict.localObjectId?'Keep local version':'Keep local deletion',side:'local' as const},
            {label:conflict.remoteObjectId?'Use Overleaf version':'Use Overleaf deletion',side:'remote' as const},
            ...(conflict.remoteObjectId?[{label:'Save Overleaf version as…',side:undefined}]:[]),
        ];
        const choice=await vscode.window.showQuickPick(choices,{title:'Resolve conflict: '+conflict.path,placeHolder:conflict.reason});
        if (!choice) { return; }
        if (!choice.side) {
            const target=await vscode.window.showSaveDialog({title:'Save Overleaf conflict version as…'});
            const content=await this.coordinator.getObject(conflict.remoteObjectId);
            if (target && content) { await vscode.workspace.fs.writeFile(target,content); }
            return;
        }
        const result=await this.coordinator.resolveWithSide(conflict.id,choice.side);
        if (!result.ok) { void vscode.window.showWarningMessage(result.message??'Conflict remains unresolved.'); }
    }

    private reportError(error:unknown):void {
        console.error('Overleaf merge editor failed',error);
        if (!this.disposed) { void vscode.window.showErrorMessage('Unable to complete the Overleaf merge: '+(error instanceof Error?error.message:String(error))); }
    }

    async collectGarbage():Promise<void> {
        const open=new Set(vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>isNativeMergeInput(tab.input)).map(tab=>(tab.input as NativeMergeInput).result.toString()));
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) { const input=tab.input as {uri?:vscode.Uri}|undefined; if (input?.uri) { open.add(input.uri.toString()); } }
        }
        for (const document of vscode.workspace.textDocuments) { if (document.isDirty && !document.isClosed) { open.add(document.uri.toString()); } }
        const sessions=[...this.sessions.values()].filter(session=>session.completing || open.has(session.output.toString()));
        const ids=sessions.flatMap(session=>[session.conflict.baseObjectId,session.conflict.localObjectId,session.conflict.remoteObjectId,session.conflict.draftObjectId]);
        const unpin=this.coordinator.pinObjects(ids);
        try { await this.coordinator.collectGarbage(sessions.map(session=>path.relative(this.root.fsPath,session.output.fsPath).split(path.sep).join('/'))); }
        finally { unpin(); }
        for (const [key,session] of this.sessions) { if (session.resolved && !open.has(session.output.toString())) { this.sessions.delete(key); } }
    }

    shutdown():Promise<void> {
        if (!this.closing) {
            this.disposed=true;
            this.closing=this.ready.catch(()=>undefined).then(()=>this.drafts.flush()).finally(()=>{ this.drafts.cancelTimers(); this.disposeResources(); });
        }
        return this.closing;
    }
    dispose():void { void this.shutdown().catch(error=>console.error('Unable to flush merge drafts',error)); }
    private disposeResources():void {
        this.disposed=true;

        this.stopListening();
        ConflictManager.managers.delete(this);
        this.disposables.forEach(item=>item.dispose());
        ConflictManager.updateContext();
    }
}
