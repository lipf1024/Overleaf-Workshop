import * as vscode from 'vscode';
import { SyncProgress } from './syncProgress';
import { createHash } from 'crypto';
import * as path from 'path';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ConflictManager, contentHash, FileSyncRecord, findPathCollisions, LocalChangeMonitor, PathIssue, RemoteChangeMonitor, SyncAdapter, SyncCoordinator, SyncMode, SyncStateStore, validateReplicaPath } from './localReplicaSync';
import { NetworkRequestError } from '../api/network';
import { ConflictPresentation } from './localReplicaSync/conflictPresentation';
import { hasUnresolvedConflict } from './localReplicaSync/conflictState';
import { LocalPathAccess, PathPolicy } from './localReplicaSync/pathPolicy';
import { ReplicaOtBridge } from './localReplicaSync/otBridge';

const IGNORE_SETTING_KEY = 'ignore-patterns';

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');
    private static readonly instances=new Set<LocalReplicaSCMProvider>();
    private static commandDisposables:vscode.Disposable[]=[];
    private static commandUsers=0;

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private coordinator?:SyncCoordinator;
    private store?:SyncStateStore;
    private pathPolicy?:PathPolicy;
    private stop?:()=>Promise<void>;
    private stopping?:Promise<void>;
    private watchInitialization?:Promise<vscode.Disposable[]>;
    private paused?:vscode.SourceControlResourceGroup;
    private static readonly closing=new Set<Promise<void>>();
    private get policy():PathPolicy {
        return this.pathPolicy??=new PathPolicy(this.store?.access??new LocalPathAccess(this.baseUri.fsPath),()=>this.getSetting<string[]>(IGNORE_SETTING_KEY)||this.ignorePatterns);
    }
    private shutdown():Promise<void> {
        if (!this.stopping) {
            this.watchInitialization=undefined;
            this.stopping=this.stop?.()??Promise.resolve();
            const closing=this.stopping; LocalReplicaSCMProvider.closing.add(closing);
            void closing.finally(()=>LocalReplicaSCMProvider.closing.delete(closing)).catch(error=>console.error('Replica shutdown failed',error));
        }
        return this.stopping;
    }
    static async shutdownAll():Promise<void> {
        await Promise.allSettled([...this.instances].map(provider=>provider.shutdown()));
        await Promise.allSettled([...this.closing]);
    }
    private conflictManager?:ConflictManager;
    private conflictPresentation?:ConflictPresentation;
    private sourceControl?:vscode.SourceControl;
    private incoming?:vscode.SourceControlResourceGroup;
    private outgoing?:vscode.SourceControlResourceGroup;
    private conflicts?:vscode.SourceControlResourceGroup;
    private output?:vscode.OutputChannel;
    private readonly loggedErrors=new Map<string,string>();
    private treeQueue:Promise<void>=Promise.resolve();
    private scanIssues:PathIssue[]=[];
    private initializingSync=true;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    public static async prepareForCompile(uri?:vscode.Uri):Promise<boolean> {
        const provider=uri?[...this.instances].find(item=>uri.scheme==='file'&&(uri.fsPath===item.baseUri.fsPath||uri.fsPath.startsWith(item.baseUri.fsPath+path.sep))):this.activeProvider();
        if (!provider?.coordinator) { return true; }
        const relative=uri?.scheme==='file' && uri.fsPath!==provider.baseUri.fsPath
            ? path.relative(provider.baseUri.fsPath,uri.fsPath).split(path.sep).join('/')
            : undefined;
        const published=relative
            ? ()=>provider.coordinator!.isObservedLocalPathPublished(relative)
            : ()=>provider.coordinator!.isObservedLocalStatePublished();
        if (!provider.coordinator.isOwner && !await published()) {
            void vscode.window.showWarningMessage('Compile paused: the synchronization window has not confirmed these local files on Overleaf yet.');
            return false;
        }
        if (provider.coordinator.isOwner) {
            await provider.coordinator.flushCurrent();
            if (relative) { await provider.coordinator.prepareLocalForCompile(relative); }
            await provider.coordinator.flushCurrent();
        }
        const pending=provider.coordinator.records().filter(record=>record.status!=='clean' && record.suspension!=='ignored');
        if (!pending.length) { return true; }
        void vscode.window.showWarningMessage(`Compile paused: ${pending.length} local replica change(s) are not on Overleaf. Review Source Control or run “Local Replica: Sync Now”.`);
        return false;
    }

    private static activeProvider():LocalReplicaSCMProvider|undefined {
        const activeUri=vscode.window.activeTextEditor?.document.uri;
        if (activeUri?.scheme==='file') {
            const match=[...this.instances].find(item=>activeUri.fsPath===item.baseUri.fsPath || activeUri.fsPath.startsWith(item.baseUri.fsPath+'/'));
            if (match) { return match; }
        }
        const folders=vscode.workspace.workspaceFolders?.filter(folder=>folder.uri.scheme==='file')??[];
        return [...this.instances].find(item=>folders.some(folder=>folder.uri.fsPath===item.baseUri.fsPath));
    }

    public static acquireCommands():vscode.Disposable {
        this.commandUsers++;
        if (!this.commandDisposables.length) {
            const withProvider=(callback:(provider:LocalReplicaSCMProvider)=>unknown)=>()=>{
                const provider=this.activeProvider();
                return provider ? callback(provider) : vscode.window.showWarningMessage('No active Overleaf local replica workspace was found.');
            };
            const withConflict=(callback:(provider:LocalReplicaSCMProvider,id?:string)=>unknown)=>(target?:string|vscode.Uri|vscode.SourceControlResourceState)=>{
                const uri=target instanceof vscode.Uri?target:typeof target==='object'?target.resourceUri:undefined;
                for (const provider of this.instances) {
                    const record=provider.coordinator?.records().find(item=>typeof target==='string'
                        ?item.pendingConflictId===target
                        :uri && vscode.Uri.joinPath(provider.baseUri,item.path).toString()===uri.toString());
                    if (record?.pendingConflictId) { return callback(provider,record.pendingConflictId); }
                }
                if (target!==undefined) { return vscode.window.showInformationMessage('No pending merge conflict was found for this file.'); }
                const provider=this.activeProvider();
                return provider?callback(provider):vscode.window.showWarningMessage('No active Overleaf local replica workspace was found.');
            };
            this.commandDisposables=[
                ConflictManager.acquireResources(),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.syncFile',async(target?:vscode.Uri|vscode.SourceControlResourceState)=>{
                    const uri=target instanceof vscode.Uri?target:target?.resourceUri??vscode.window.activeTextEditor?.document.uri;
                    if (!uri || uri.scheme!=='file') { return; }
                    const provider=[...this.instances].filter(item=>uri.fsPath.startsWith(item.baseUri.fsPath+path.sep))
                        .sort((a,b)=>b.baseUri.fsPath.length-a.baseUri.fsPath.length)[0];
                    if (!provider?.coordinator) { return vscode.window.showWarningMessage('This file does not belong to an active Overleaf local replica.'); }
                    if (vscode.workspace.textDocuments.some(doc=>doc.uri.toString()===uri.toString()&&doc.isDirty)) {
                        return vscode.window.showWarningMessage('Save this file before synchronizing it.');
                    }
                    const relative=path.relative(provider.baseUri.fsPath,uri.fsPath).split(path.sep).join('/');
                    try {
                        await provider.coordinator.syncPath(relative);
                        const record=provider.coordinator.records().find(item=>item.path===relative);
                        if (record && record.status!=='clean') { await vscode.window.showWarningMessage(record.message??'This file still has pending changes. Review Source Control.'); }
                    } catch (error:any) { await vscode.window.showWarningMessage(`Unable to sync this file: ${error.message}`); }
                }),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.syncNow',withProvider(provider=>provider.coordinator!.syncNow())),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.reviewPending',()=>vscode.commands.executeCommand('workbench.view.scm')),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.setSyncMode',withProvider(provider=>provider.selectSyncMode())),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.openConflict',withConflict((provider,id)=>provider.openConflict(id))),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.useLocal',withConflict((provider,id)=>provider.useSide('local',id))),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.useRemote',withConflict((provider,id)=>provider.useSide('remote',id))),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.retryFailed',withProvider(provider=>provider.coordinator!.syncNow())),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.showDiagnostics',withProvider(provider=>provider.showDiagnostics())),
                vscode.commands.registerCommand('overleaf-workshop.localReplica.reviewRecovery',withProvider(provider=>provider.reviewRecovery())),
            ];
        }
        let released=false;
        return new vscode.Disposable(()=>{
            if (released) { return; } released=true;
            if (--this.commandUsers===0) { this.commandDisposables.forEach(item=>item.dispose()); this.commandDisposables=[]; }
        });
    }

    private async selectSyncMode():Promise<void> {
        const configuration=vscode.workspace.getConfiguration('overleaf-workshop.localReplica',this.baseUri);
        const current=configuration.get<SyncMode>('syncMode','safeAuto');
        await configuration.update('syncMode',current==='safeAuto'?'manual':'safeAuto',vscode.ConfigurationTarget.WorkspaceFolder);
    }

    private createAutoSyncStatus():vscode.Disposable {
        const item=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
        item.name='Overleaf Auto Sync';
        item.command='overleaf-workshop.localReplica.setSyncMode';
        const update=()=>{
            if (LocalReplicaSCMProvider.activeProvider()!==this) { item.hide(); return; }
            const enabled=vscode.workspace.getConfiguration('overleaf-workshop.localReplica',this.baseUri).get<SyncMode>('syncMode','safeAuto')==='safeAuto';
            item.text=enabled?'$(sync) Auto Sync: On':'$(debug-pause) Auto Sync: Off';
            item.tooltip=`Overleaf — ${this.vfs.projectName}\nClick to turn auto sync ${enabled?'off':'on'}. Sync Now remains available in the Explorer toolbar.`;
            item.show();
        };
        update();
        return vscode.Disposable.from(item,
            vscode.window.onDidChangeActiveTextEditor(update),
            vscode.workspace.onDidChangeConfiguration(update),
            vscode.workspace.onDidChangeWorkspaceFolders(update));
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static parsePersistedBaseUri(value: string): vscode.Uri {
        return value.startsWith('file:') ? vscode.Uri.parse(value) : vscode.Uri.file(value);
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    public static async readSettings(workspaceRoot=vscode.workspace.workspaceFolders?.[0]?.uri):Promise<any|undefined> {
        if (workspaceRoot?.scheme!=='file') { return; }
        try {
            const content=await new LocalPathAccess(workspaceRoot.fsPath).read('.overleaf/settings.json',true);
            return content?JSON.parse(Buffer.from(content).toString('utf8')):undefined;
        } catch { return undefined; }
    }

    private matchIgnorePatterns(path:string):boolean { return this.policy.isIgnored(path); }

    private async initWatch():Promise<vscode.Disposable[]> {
        const serverIdentityHash=createHash('sha256').update(`${this.vfs.serverName}\0${this.vfs._userId}`).digest('hex');
        const store=this.store=new SyncStateStore(this.baseUri.fsPath,{projectId:this.vfs.projectId,serverIdentityHash});
        const resources:vscode.Disposable[]=[],ownerResources:Array<LocalChangeMonitor|RemoteChangeMonitor>=[];
        const progress=new SyncProgress(this.vfs.projectName);
        resources.push(progress);
        let disposed=false,observerTask:Promise<void>|undefined;
        const report=(error:unknown)=>this.output?.appendLine(String(error));
        this.stop=async()=>{
            disposed=true;
            ownerResources.forEach(item=>item.dispose()); resources.forEach(item=>item.dispose());
            await observerTask;
            await Promise.all(ownerResources.map(item=>item.whenIdle()));
            try { await this.conflictManager?.shutdown(); }
            finally {
                if (this.coordinator) { await this.coordinator.shutdown(); } else { await store.close(); }
                LocalReplicaSCMProvider.instances.delete(this);
            }
        };
        try {
            await store.initialize();
            const bytes=await store.access.read('.overleaf/settings.json',true);
            let settings=bytes?JSON.parse(Buffer.from(bytes).toString('utf8')):undefined;
            if (settings) {
                let legacyIdentityMatches=false;
                try { const linked=parseUri(vscode.Uri.parse(settings.uri)); legacyIdentityMatches=linked.projectId===this.vfs.projectId&&linked.serverName===this.vfs.serverName&&linked.userId===this.vfs._userId; } catch { /* invalid association */ }
                if ((settings.projectId!==undefined&&settings.projectId!==this.vfs.projectId)
                    || (settings.serverIdentityHash!==undefined&&settings.serverIdentityHash!==serverIdentityHash)
                    || (settings.projectId===undefined&&!legacyIdentityMatches)) { throw new Error('This folder is linked to a different Overleaf project, server, or user'); }
            }
            if (store.isOwner) {
                settings={uri:this.vfs.origin.toString(),serverName:this.vfs.serverName,projectName:this.vfs.projectName,...settings,
                    projectId:this.vfs.projectId,serverIdentityHash,syncEngineVersion:1};
                await store.saveProjectSettings(settings);
            }
            const configured=vscode.workspace.getConfiguration('overleaf-workshop.localReplica',this.baseUri).get<SyncMode>('syncMode','safeAuto');
            const textBridge=new ReplicaOtBridge(this.baseUri,this.vfs,store,vscode);
            resources.push(textBridge);
        const adapter:SyncAdapter={
            establishText:(path,snapshot)=>textBridge.establish(path,snapshot),
            syncText:path=>textBridge.sync(path),
            checkPath:path=>this.policy.check(path),
            listPaths:()=>this.listAllPaths(), listLocalPaths:()=>this.listLocalPaths(), listIssues:()=>this.scanIssues, readLocal:async path=>await this.readFile(path),
            readRemote:async(path,force)=>{
                try { const snapshot=await this.vfs.readRemoteSnapshot(this.vfs.pathToUri('/'+path),force); return snapshot?{type:'found',snapshot}:{type:'missing'}; }
                catch (error:any) {
                    const kind=error instanceof NetworkRequestError?error.kind:(this.vfs.isConnectionReady?'fatal-error':'offline');
                    return {type:kind==='not-found'?'missing':kind,message:error?.message??String(error)} as any;
                }
            },
            applyRemote:async(path,expected,content,kind,operationId)=>{
                if ((await this.policy.check(path)).type!=='allowed') { throw new Error('Replica path is excluded or unsafe'); }
                await store.assertWritable(); await this.ensureRemoteParent(path);
                return (expected?.kind==='document' || (!expected && kind==='text'))
                    ? this.vfs.applyDocumentSnapshot(this.vfs.pathToUri('/'+path),expected,content)
                    : this.vfs.applyFileSnapshot(this.vfs.pathToUri('/'+path),expected,content,operationId);
            },
            deleteRemote:async(path,expected)=>{ await store.assertWritable(); if ((await this.policy.check(path)).type!=='allowed') { throw new Error('Replica path is excluded or unsafe'); } return this.vfs.deleteRemoteSnapshot(this.vfs.pathToUri('/'+path),expected); },
            locateRemotePath:async entityId=>this.vfs._resolveById(entityId)?.path.replace(/^\//,''),
            findLocalPathsByHash:(hash,exclude)=>this.findLocalPathsByHash(hash,exclude),
            renameRemote:async(oldPath,newPath,expected)=>{
                await store.assertWritable();
                if ((await this.policy.check(oldPath)).type!=='allowed' || (await this.policy.check(newPath)).type!=='allowed') { throw new Error('Replica move is excluded or unsafe'); }
                await this.ensureRemoteParent(newPath);
                return this.vfs.renameRemoteSnapshot(this.vfs.pathToUri('/'+oldPath),this.vfs.pathToUri('/'+newPath),expected);
            },
            recoverRemote:(entry,original)=>this.vfs.recoverStagedFileSnapshot(entry,original),
            isLocalDirty:path=>vscode.workspace.textDocuments.some(doc=>doc.isDirty && doc.uri.fsPath===vscode.Uri.joinPath(this.baseUri,path).fsPath),
            connectionEpoch:()=>this.vfs.connectionEpoch,
            isConnectionReady:()=>this.vfs.isConnectionReady,
            syncActivity:(path,active)=>progress.activity(path,active),
        };
            this.coordinator=new SyncCoordinator(store,adapter,configured);
            const initialized=await this.coordinator.initialize();
            this.output=vscode.window.createOutputChannel(`Overleaf Local Replica: ${this.vfs.projectName}`);
            this.createSourceControl();
            this.conflictPresentation=new ConflictPresentation(this.baseUri,id=>this.openConflict(id));
            const stopSourceControl=this.coordinator.onDidChange(records=>this.updateSourceControl(records));
            resources.push(this.output,this.sourceControl!,this.conflictPresentation,LocalReplicaSCMProvider.acquireCommands(),new vscode.Disposable(stopSourceControl));
            LocalReplicaSCMProvider.instances.add(this);
            resources.push(this.createAutoSyncStatus());
            const startOwner=async()=>{
                if (disposed) { return; }
                this.conflictManager=new ConflictManager(this.coordinator!,this.baseUri);
                ownerResources.push(
                    new LocalChangeMonitor(this.baseUri,(path,stable)=>stable?this.coordinator!.handleLocal(path):this.coordinator!.markUnstable(path),()=>this.coordinator!.refreshLocalChanges(),path=>this.coordinator!.handleTreeDelete('local',path),this.policy,report),
                    new RemoteChangeMonitor(this.vfs.origin,uri=>parseUri(uri).pathParts.join('/'),path=>this.coordinator!.handleRemote(path),path=>this.coordinator!.handleTreeDelete('remote',path),report),
                );
                this.sourceControl!.statusBarCommands=[];
                await this.conflictManager.ready;
                if (!disposed) { await this.conflictManager.collectGarbage(); }
            };
            if (this.coordinator.isOwner) { await startOwner(); }
            else { this.sourceControl!.statusBarCommands=[{command:'overleaf-workshop.localReplica.showDiagnostics',title:'$(eye) Synchronization is owned by another window'}]; }
            this.initializingSync=false;
            this.updateSourceControl(this.coordinator.records());
            const poll=setInterval(()=>{
                if (disposed || observerTask || this.coordinator!.isOwner) { return; }
                observerTask=(async()=>{
                    if (await this.coordinator!.tryTakeOwnership()) {
                        if (disposed) { return; }
                        await this.coordinator!.initialize();
                        if (!disposed) { await startOwner(); }
                    } else { await this.coordinator!.refreshObservedState(); }
                    if (!disposed) { this.updateSourceControl(this.coordinator!.records()); }
                })().catch(report).finally(()=>{ observerTask=undefined; });
            },2000);
            const maintenance=setInterval(()=>{ if (!disposed) { void this.conflictManager?.collectGarbage().catch(report); } },10*60*1000);
            resources.push(new vscode.Disposable(()=>{ clearInterval(poll); clearInterval(maintenance); }),
                vscode.workspace.onDidChangeConfiguration(event=>{
                    if (event.affectsConfiguration('overleaf-workshop.localReplica.syncMode',this.baseUri)) {
                        this.coordinator!.setMode(vscode.workspace.getConfiguration('overleaf-workshop.localReplica',this.baseUri).get<SyncMode>('syncMode','safeAuto'));
                        if (this.coordinator!.isOwner) { void this.coordinator!.scan('bootstrap').catch(report); }
                    }
                }));
            if (initialized.safeInitialization && this.coordinator.isOwner && this.coordinator.records().some(record=>record.status!=='clean')) {
                void vscode.window.showInformationMessage('Local replica safety scan completed. Review pending changes in Source Control.');
            }
            return [new vscode.Disposable(()=>{ void this.shutdown().catch(report); })];
        } catch (error) { await this.shutdown(); throw error; }
    }

    private async listAllPaths():Promise<string[]> {
        this.scanIssues=[]; this.policy.setIssues([]);
        const candidates=await this.listLocalPaths();
        const walkRemote=async(root:vscode.Uri,prefix:string):Promise<void>=>{
            let entries:[string,vscode.FileType][]=[];
            try { entries=await vscode.workspace.fs.readDirectory(root); }
            catch (error) { if (isFileNotFound(error)) { return; } throw error; }
            for (const [name,type] of entries) {
                const relative=(prefix?prefix+'/':'')+name;
                if (this.matchIgnorePatterns(relative)) { continue; }
                const invalid=validateReplicaPath(relative); if (invalid) { this.scanIssues.push({path:relative,message:invalid}); continue; }
                if ((type&vscode.FileType.SymbolicLink)!==0) { this.scanIssues.push({path:relative,message:'Symbolic links are not supported by local replica sync'}); continue; }
                if ((type&vscode.FileType.Directory)!==0) { await walkRemote(vscode.Uri.joinPath(root,name),relative); }
                else if ((type&vscode.FileType.File)!==0) { candidates.push(relative); }
            }
        };
        await walkRemote(this.vfs.origin,'');
        this.scanIssues.push(...findPathCollisions([...new Set(candidates)]));
        this.policy.setIssues(this.scanIssues);
        const accepted:string[]=[];
        for (const relative of new Set(candidates)) { if ((await this.policy.check(relative)).type==='allowed') { accepted.push(relative); } }
        return accepted.sort();
    }

    private async listLocalPaths():Promise<string[]> {
        const candidates:string[]=[];
        const walk=async(prefix:string):Promise<void>=>{
            for (const entry of await this.policy.access.list(prefix)) {
                const relative=(prefix?prefix+'/':'')+entry.name;
                const decision=await this.policy.check(relative);
                if (decision.type==='blocked') { this.scanIssues.push({path:relative,message:decision.message}); }
                if (decision.type!=='allowed') { continue; }
                if (entry.isDirectory()) { await walk(relative); }
                else if (entry.isFile()) { candidates.push(relative); }
            }
        };
        await walk(''); return candidates;
    }

    private async ensureRemoteParent(path:string):Promise<void> {
        const operation=this.treeQueue.catch(()=>undefined).then(async()=>{
            const parts=path.split('/').slice(0,-1); let current='';
            for (const part of parts) {
                current+=(current?'/':'')+part;
                const uri=this.vfs.pathToUri('/'+current);
                const resolved=await this.vfs._resolveUri(uri);
                if (!resolved.fileType) { await this.vfs.mkdir(uri); }
                else if (resolved.fileType!=='folder') { throw new Error(`Remote parent path is not a folder: ${current}`); }
            }
        });
        this.treeQueue=operation.catch(()=>undefined); await operation;
    }

    private async findLocalPathsByHash(hash:string,exclude:string):Promise<string[]> {
        const matches:string[]=[];
        for (const relative of await this.listLocalPaths()) {
            if (relative!==exclude && contentHash(await this.readFile(relative))===hash) { matches.push(relative); }
        }
        return matches;
    }

    private createSourceControl():void {
        this.sourceControl=vscode.scm.createSourceControl('overleafLocalReplica','Overleaf Local Replica',this.baseUri);
        this.incoming=this.sourceControl.createResourceGroup('incoming','Incoming');
        this.outgoing=this.sourceControl.createResourceGroup('outgoing','Outgoing');
        this.conflicts=this.sourceControl.createResourceGroup('conflicts','Conflicts');
        this.paused=this.sourceControl.createResourceGroup('paused','Paused');
    }

    private updateSourceControl(records:FileSyncRecord[]):void {
        const item=(record:FileSyncRecord):vscode.SourceControlResourceState=>({resourceUri:vscode.Uri.joinPath(this.baseUri,record.path),
            command:record.pendingConflictId && this.coordinator?.isOwner && !record.suspension?{command:'overleaf-workshop.localReplica.openConflict',title:'Open Conflict Editor',arguments:[record.pendingConflictId]}:undefined,
            contextValue:hasUnresolvedConflict(record)?'overleafConflict':!record.suspension?'overleafSyncFile':undefined,
            decorations:{tooltip:hasUnresolvedConflict(record)?'Overleaf conflict: '+(record.message??'Synchronization paused'):record.message,
                iconPath:hasUnresolvedConflict(record)?new vscode.ThemeIcon('warning',new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')):undefined}});
        this.incoming!.resourceStates=records.filter(r=>!r.suspension && !hasUnresolvedConflict(r) && (r.status==='pending-download'||r.status==='remote-changed')).map(item);
        this.outgoing!.resourceStates=records.filter(r=>!r.suspension && !hasUnresolvedConflict(r) && (r.status==='pending-upload'||r.status==='local-changed'||r.status==='error')).map(item);
        this.conflicts!.resourceStates=records.filter(r=>!r.suspension && hasUnresolvedConflict(r)).map(item);
        this.paused!.resourceStates=records.filter(r=>r.suspension && r.suspension!=='ignored').map(item);
        this.conflictPresentation?.update(records.filter(r=>!r.suspension),!this.initializingSync && !!this.coordinator?.isOwner);
        for (const record of records.filter(item=>item.status==='error' && item.message)) {
            if (this.loggedErrors.get(record.path)===record.message) { continue; }
            this.loggedErrors.set(record.path,record.message!);
            this.output?.appendLine(`${new Date().toISOString()} [${record.path}] ${record.message}`);
        }
        const attention=records.filter(r=>r.status!=='clean' && r.suspension!=='ignored').length;
        this.sourceControl!.count=attention; this.status=attention?{status:'need-attention',message:`${attention} local replica item(s) need attention`}:{status:'idle',message:''};
    }

    private async openConflict(id?:string):Promise<void> {
        if (!this.coordinator?.isOwner) { void vscode.window.showInformationMessage('Resolve this conflict in the window that owns synchronization.'); return; }
        const target=await this.selectConflict(id);
        if (target) { await this.conflictManager?.open(target); }
    }

    private async useSide(side:'local'|'remote',id?:string):Promise<void> {
        if (!this.coordinator?.isOwner) { void vscode.window.showInformationMessage('Resolve this conflict in the window that owns synchronization.'); return; }
        const target=await this.selectConflict(id);
        if (!target) { return; }
        const result=await this.coordinator!.resolveWithSide(target,side);
        if (!result.ok) { void vscode.window.showWarningMessage(result.message??'Conflict remains unresolved.'); }
    }

    private async selectConflict(id?:string):Promise<string|undefined> {
        if (id) { return id; }
        const records=this.coordinator?.records().filter(record=>record.pendingConflictId)??[];
        if (!records.length) { void vscode.window.showInformationMessage('No local replica merge conflict is pending.'); return; }
        if (records.length===1) { return records[0].pendingConflictId; }
        const selected=await vscode.window.showQuickPick(records.map(record=>({label:record.path,description:record.message,id:record.pendingConflictId})),
            {title:'Choose an Overleaf conflict'});
        return selected?.id;
    }

    private async reviewRecovery():Promise<void> {
        const reviews=await this.coordinator!.localRecoveryReviews();
        if (!reviews.length) { void vscode.window.showInformationMessage(vscode.l10n.t('No interrupted local replacement needs review.')); return; }
        const selected=reviews.length===1?reviews[0]:(await vscode.window.showQuickPick(reviews.map(review=>({label:review.entry.path,description:review.entry.localRecoveryPath,review})),{title:vscode.l10n.t('Review preserved local versions')}))?.review;
        if (!selected) { return; }
        const recoveryPath=selected.entry.localRecoveryPath;
        if (recoveryPath) {
            await vscode.commands.executeCommand('vscode.diff',vscode.Uri.joinPath(this.baseUri,recoveryPath),vscode.Uri.joinPath(this.baseUri,selected.entry.path),vscode.l10n.t('Preserved original ↔ Current local file'));
        }
        const keep=vscode.l10n.t('Keep Current File and Resume');
        const choice=await vscode.window.showWarningMessage(vscode.l10n.t('Review {0}. Resuming keeps the current local file and backs up the preserved versions. Overleaf changes will be checked again before synchronization.',selected.entry.path),{modal:true},keep);
        if (choice===keep) { await this.coordinator!.acknowledgeLocalRecovery(selected); }
    }

    private async showDiagnostics():Promise<void> {
        const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(await this.coordinator?.diagnostics()??{},null,2)});
        await vscode.window.showTextDocument(document,{preview:true});
    }

    async writeFile(relPath:string,content:Uint8Array):Promise<void> {
        if (!this.store || (await this.policy.check(relPath)).type!=='allowed') { throw new Error('Replica path is not writable'); }
        await this.store.assertWritable();
        const current=await this.readFile(relPath);
        const entry=await this.store.atomicLocalWrite(relPath,content,'download',undefined,contentHash(current),true);
        await this.store.removeJournal(entry.id);
    }

    async readFile(relPath:string):Promise<Uint8Array|undefined> {
        const decision=await this.policy.check(relPath);
        if (decision.type!=='allowed') { throw new Error(decision.message); }
        return this.policy.access.read(relPath);
    }

    get triggers():Promise<vscode.Disposable[]> {
        if (!this.watchInitialization) {
            const previousStop=this.stopping;
            this.watchInitialization=(async()=>{
                if (previousStop) { await previousStop; }
                this.stopping=undefined; this.stop=undefined; this.pathPolicy=undefined;
                this.coordinator=undefined; this.conflictManager=undefined; this.initializingSync=true; this.loggedErrors.clear();
                return this.initWatch();
            })().catch(error=>{ this.watchInitialization=undefined; throw error; });
        }
        return this.watchInitialization;
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}

function isFileNotFound(error:unknown):boolean {
    const value=error as any;
    return value?.code==='FileNotFound' || value?.code==='ENOENT';
}
