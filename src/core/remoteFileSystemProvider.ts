/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { BaseAPI, MemberEntity, ProjectSettingsSchema } from '../api/base';
import { SocketIOAPI, UpdateSchema } from '../api/socketio';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { GlobalStateManager } from '../utils/globalStateManager';
import { ClientManager } from '../collaboration/clientManager';
import { EventBus } from '../utils/eventBus';
import { SCMCollectionProvider } from '../scm/scmCollectionProvider';
import { ExtendedBaseAPI, ProjectLinkedFileProvider, UrlLinkedFileProvider } from '../api/extendedBase';
import { ApplyResult, JournalEntry, RemoteRevision, RemoteSnapshot } from '../scm/localReplicaSync/model';
import { contentHash } from '../scm/localReplicaSync/hash';
import { NetworkRequestError } from '../api/network';
import { createHash, randomUUID } from 'crypto';
import { SyncStateStore } from '../scm/localReplicaSync/stateStore';
import { OtDocuments } from './ot/documents';
import { OtSession } from './ot/session';
import { OtEditor } from './ot/editor';
import { TextOperation } from './ot/text';
import { ProjectMetadataCache } from './projectMetadataCache';
import { DebouncedTasks } from '../utils/debouncedTasks';

const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;

export type FileType = 'doc' | 'file' | 'folder' | 'outputs';
export type FolderKey = 'docs' | 'fileRefs' | 'folders' | 'outputs';
const FolderKeys: {[_type:string]: FolderKey} = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
    'outputs': 'outputs',
};

export interface FileEntity {
    _id: string,
    name: string,
    _type?: FileType,
    readonly?: boolean,
}

export interface DocumentEntity extends FileEntity {
    version?: number,
    mtime?: number,
    lastVersion?: number,
    localCache?: string,
    remoteCache?: string,
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: ProjectLinkedFileProvider | UrlLinkedFileProvider | null,
    created: string, //ISO date string
}

export interface OutputFileEntity extends FileEntity {
    path: string, //output file name
    url: string, // `project/${projectId}/user/${userId}/output/${build}/output/${path}`
    type: string, //output file type (postfix)
    build: string, //build id
}

export interface FolderEntity extends FileEntity {
    docs: Array<DocumentEntity>,
    fileRefs: Array<FileRefEntity>,
    folders: Array<FolderEntity>,
    outputs?: Array<OutputFileEntity>,
}

export interface ProjectEntity {
    _id: string,
    name: string,
    rootDoc_id: string,
    rootFolder: Array<FolderEntity>,
    publicAccessLevel: string, //"tokenBased"
    compiler: string,
    spellCheckLanguage: string,
    deletedDocs: Array<{
        _id: string,
        name: string,
        deletedAt: string,
    }>,
    members: Array<MemberEntity>,
    invites: Array<MemberEntity>,
    owner: MemberEntity,
    features: {[key:string]:any},
    settings: ProjectSettingsSchema,
}

export class File implements vscode.FileStat {
    type: vscode.FileType;
    name: string;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: vscode.FilePermission;
    constructor(name: string, type: vscode.FileType, ctime?: number, permissions?:vscode.FilePermission) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.permissions = permissions;
    }
}

export function parseUri(uri: vscode.Uri) {
    const query:any = uri.query.split('&').reduce((acc, v) => {
        const [key,value] = v.split('=');
        return {...acc, [key]:value};
    }, {});
    const [userId, projectId] = [query.user, query.project];
    const _pathParts = uri.path.split('/');
    const serverName = uri.authority;
    const projectName = decodeURIComponent(_pathParts[1]);
    const pathParts = _pathParts.splice(2);
    const identifier = `${userId}/${projectId}/${projectName}`;
    return {userId, projectId, serverName, projectName, identifier, pathParts};
}

export class VirtualFileSystem extends vscode.Disposable {
    private root?: ProjectEntity;
    private currentVersion?: number;
    private context: vscode.ExtensionContext;
    private api: BaseAPI;
    private socket: SocketIOAPI;
    private publicId?: string;
    private userId: string;
    private isDirty: boolean = true;
    private editorBases=new Map<string,string>();
    private editorWrites=new Map<string,Promise<void>>();
    private otDocuments?:OtDocuments;
    private otEditors=new Map<string,OtEditor>();
    private otOutput?:vscode.OutputChannel;
    private otListeners=new Set<(id:string,op?:TextOperation)=>void>();
    private otLifecycle:vscode.Disposable[]=[];
    private initializing?: Promise<ProjectEntity>;
    private initializationActive=false;
    private static runtimeUiOwner?:VirtualFileSystem;
    private retryConnection: number = 0;
    private reconnectError?:Error;
    private reconnectAbort?:AbortController;
    private remoteTreeWrites:Promise<unknown>=Promise.resolve();
    private retryTimer?: NodeJS.Timeout;
    private reconnectingStatus?: vscode.Disposable;
    private disposed = false;
    /** Whether event handlers have been registered on the current socket */
    private handlersRegistered: boolean = false;
    private runtimeInitialized=false;
    private disconnectedTree?:Map<string,{path:string;signature:string}>;
    private readonly snapshotReads=new Map<string,Promise<RemoteSnapshot|undefined>>();
    private refreshTreePromise?:Promise<void>;
    private metadataCache?:ProjectMetadataCache;
    private metadataTasks?:DebouncedTasks;
    private readonly metadataRunning=new Set<string>();
    private metadataRefreshUnavailable=false;
    private get projectMetadata():ProjectMetadataCache { return this.metadataCache??=new ProjectMetadataCache(); }
    private outputBuildId?: string;
    private compileGroup?: string;
    private clsiServerId?: string;
    private pdfDownloadDomain?: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly projectId: string;

    constructor(context: vscode.ExtensionContext, uri: vscode.Uri, notify: (events:vscode.FileChangeEvent[])=>void, onDispose?:()=>void) {
        // define the dispose behavior
        super(() => {
            this.disposed = true;
            this.otDocuments?.dispose();
            this.otEditors?.forEach(editor=>editor.dispose());
            this.otLifecycle?.forEach(listener=>listener.dispose());
            this.otOutput?.dispose();
            this.metadataTasks?.dispose();
            this.metadataCache?.reset();
            if (VirtualFileSystem.runtimeUiOwner===this) { VirtualFileSystem.runtimeUiOwner=undefined; }
            this.reconnectAbort?.abort();
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = undefined;
            }
            this.closeReconnectingProgress();
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem = undefined;
            // disconnect socketio
            this.socket.dispose();
            onDispose?.();
        });

        const {userId,projectId,serverName,projectName} = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({path: '/'+projectName});
        this.userId = userId;
        this.projectId = projectId;
        this.context = context;
        this.notify = notify;
        this.otLifecycle.push(vscode.workspace.onDidOpenTextDocument(document=>{
            if (document.uri.scheme!==ROOT_NAME || parseUri(document.uri).projectId!==this.projectId || document.uri.authority!==this.serverName) { return; }
            void this.textSession(document.uri).then(session=>{ if (session) { this.bindOtEditor(document,session); } }).catch(()=>undefined);
        }),vscode.workspace.onDidCloseTextDocument(document=>{
            const key=document.uri.toString(); this.otEditors.get(key)?.dispose(); this.otEditors.delete(key);
        }));

        const res = GlobalStateManager.initSocketIOAPI(this.context, this.serverName, projectId);
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
        } else {
            throw new Error( vscode.l10n.t('Cannot init SocketIOAPI for {serverName}', {serverName}) );
        }
    }

    get _userId() {
        return this.userId;
    }

    get isDisposed() {
        return this.disposed;
    }

    get connectionEpoch():number { return this.socket.connectionEpoch; }
    get isConnectionReady():boolean { return this.socket.isReady; }

    private async refreshProjectTree():Promise<void> {
        if (this.refreshTreePromise) { return this.refreshTreePromise; }
        // A normal reconnect already owns connect/join while the tree is absent.
        // Reuse it instead of starting a competing socket epoch.
        if (!this.root && this.initializing) { await this.initializing; return; }
        const previous=this.treeIndex(this.root);
        this.metadataTasks?.dispose();
        this.metadataCache?.reset();
        const refreshTask=(async():Promise<ProjectEntity>=>{
            this.socket.init();
            const project=await this.socket.joinProject(this.projectId);
            project.settings=await this.fetchProjectSettings();
            this.root=project; this.socket.completeProjectRefresh();
            this.publishReconnectTreeChanges(previous,this.treeIndex(project));
            return project;
        })();
        // Hide the stale pre-refresh tree. Any concurrent resolver now shares the
        // same project join through init() rather than reading obsolete entities.
        this.root=undefined;
        this.initializing=refreshTask;
        const completion=refreshTask.then(()=>undefined).finally(()=>{
            if (this.initializing===refreshTask) { this.initializing=undefined; }
            if (this.refreshTreePromise===completion) { this.refreshTreePromise=undefined; }
        });
        this.refreshTreePromise=completion;
        return completion;
    }

    private async fetchProjectSettings():Promise<ProjectSettingsSchema> {
        const identity=await GlobalStateManager.authenticate(this.context,this.serverName);
        const response=await this.api.getProjectSettings(identity,this.projectId);
        if (response.type!=='success' || !response.settings) {
            throw new NetworkRequestError(response.errorKind??'fatal-error',response.message??'Project refresh returned no settings',response.statusCode);
        }
        return response.settings;
    }

    async init() : Promise<ProjectEntity> {
        if (this.disposed) {
            throw new Error('Cannot initialize a disposed virtual file system');
        }
        if (this.root) {
            return Promise.resolve(this.root);
        }

        if (this.reconnectError) { throw this.reconnectError; }
        if (!this.initializing) {
            this.initializing = this.initializingPromise;
        }
        return this.initializing;
    }

    public async createLocalReplica(baseUri: vscode.Uri): Promise<vscode.Uri> {
        await this.init();
        const collection = this.scmCollectionItem?.collection;
        if (!collection) {
            throw new Error(vscode.l10n.t('Local replica source control is not available.'));
        }
        return collection.createLocalReplica(baseUri);
    }

    private closeReconnectingProgress() {
        this.reconnectingStatus?.dispose();
        this.reconnectingStatus = undefined;
    }

    async retryInitialization():Promise<ProjectEntity> {
        if (this.disposed) { throw new Error('Cannot reconnect a disposed project'); }
        if ((this.initializationActive || this.refreshTreePromise) && this.initializing) { return this.initializing; }
        this.reconnectError=undefined; this.retryConnection=0; this.initializing=undefined;
        this.socket.allowManualReconnect?.();
        return this.init();
    }

    private get initializingPromise():Promise<ProjectEntity> {
        this.initializationActive=true;
        return this.initializeProject().finally(()=>{ this.initializationActive=false; });
    }
    private async waitForReconnect(delayMs:number):Promise<void> {
        this.reconnectAbort??=new AbortController();
        const signal=this.reconnectAbort.signal;
        if (signal.aborted || this.disposed) { throw new Error('Reconnect cancelled'); }
        if (!delayMs) { return; }
        await new Promise<void>((resolve,reject)=>{
            const cancel=()=>{ clearTimeout(timer); reject(new Error('Reconnect cancelled')); };
            const timer=setTimeout(()=>{ signal.removeEventListener('abort',cancel); resolve(); },delayMs);
            signal.addEventListener('abort',cancel,{once:true});
        });
    }
    private async initializeProject():Promise<ProjectEntity> {
        const maxAttempts=5;
        let lastError:Error=new Error('Connection lost');
        for (;this.retryConnection<maxAttempts;) {
            const attempt=this.retryConnection;
            await this.waitForReconnect(attempt?(3+Math.floor(Math.random()*7))*1000:0);
            let newClient:ClientManager|undefined,newCollection:SCMCollectionProvider|undefined;
            try {
                if (attempt>0 || this.socket.needsReinit) { this.socket.init(); }
                if (!this.handlersRegistered) { this.remoteWatch(); this.handlersRegistered=true; }
                this.root=undefined;
                const project=await this.socket.joinProject(this.projectId);
                project.settings=await this.fetchProjectSettings();
                if (this.disposed) { throw new Error('Project initialization was cancelled'); }
                this.root=project; this.socket.completeProjectRefresh();
                await this.otDocuments?.reconnect();
                const activeCondition=!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders[0]?.uri.scheme!==ROOT_NAME || vscode.workspace.workspaceFolders[0]?.uri.toString()===this.origin.toString();
                const firstInitialization=!this.runtimeInitialized;
                if (activeCondition && firstInitialization) {
                    const ownsUI=!VirtualFileSystem.runtimeUiOwner || VirtualFileSystem.runtimeUiOwner===this;
                    if (ownsUI) {
                        VirtualFileSystem.runtimeUiOwner=this;
                        newClient=new ClientManager(this,this.context,this.publicId||'',this.socket);
                        this.clientManagerItem={manager:newClient,triggers:newClient.triggers};
                    }
                    newCollection=new SCMCollectionProvider(this,this.context,ownsUI);
                    await newCollection.ready;
                    if (this.disposed) { throw new Error('Project initialization was cancelled'); }
                    this.scmCollectionItem={collection:newCollection,triggers:newCollection.triggers};
                }
                this.runtimeInitialized=true;
                if (this.disconnectedTree) { this.publishReconnectTreeChanges(this.disconnectedTree,this.treeIndex(project)); this.disconnectedTree=undefined; }
                this.retryConnection=0; this.reconnectError=undefined; this.closeReconnectingProgress();
                if (firstInitialization) { void vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`,this.origin); }
                return project;
            } catch (error:any) {
                this.root=undefined;
                newClient?.dispose(); newCollection?.dispose();
                if (this.clientManagerItem?.manager===newClient) { this.clientManagerItem=undefined; }
                if (this.scmCollectionItem?.collection===newCollection) { this.scmCollectionItem=undefined; }
                if (!this.runtimeInitialized && VirtualFileSystem.runtimeUiOwner===this) { VirtualFileSystem.runtimeUiOwner=undefined; }
                lastError=error instanceof Error?error:new Error(String(error));
                this.socket.pause();
                this.retryConnection++;
                if (this.disposed) { this.closeReconnectingProgress(); throw lastError; }
                const authFailure=[401,403].includes(error?.statusCode??error?.status) || /unauthori[sz]ed|not.?authorized|login required|not logged in|invalid credentials|forbidden/i.test(lastError.message);
                const fatal=this.socket.isForcedDisconnected || authFailure || (error instanceof NetworkRequestError && ['auth-required','fatal-error','not-found'].includes(error.kind));
                if (fatal) { break; }
                if (!this.reconnectingStatus && this.retryConnection<maxAttempts) { this.reconnectingStatus=vscode.window.setStatusBarMessage(`$(sync~spin) Reconnecting to ${this.serverName}…`); }
            }
        }
        this.closeReconnectingProgress(); this.reconnectError=lastError;
        vscode.window.setStatusBarMessage(`$(error) Overleaf connection stopped. Run “Overleaf: Retry Connection”.`,10000);
        throw lastError;
    }

    async _resolveUri(uri: vscode.Uri) {
        // resolve path
        const [parentFolder, fileName] = await (async () => {
            const {pathParts} = parseUri(uri);
            const root = await this.init();

            let currentFolder = root.rootFolder[0];
            for (let i = 0; i < pathParts.length-1; i++) {
                const folderName = pathParts[i];
                const folders=currentFolder.folders.filter(folder=>folder.name===folderName);
                if (folders.length>1) { throw new Error(`Ambiguous remote path: duplicate folder ${folderName}`); }
                const folder = folders[0];
                if (folder) {
                    currentFolder = folder;
                } else {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
            }
            const fileName = pathParts[pathParts.length-1];
            return [currentFolder, fileName];
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            if (!fileName) { return [parentFolder,'folder' as FileType,parentFolder._id]; }
            const matches:Array<{entity:FileEntity;type:FileType}>=[];
            for (const _type of Object.keys(FolderKeys)) {
                for (const entity of parentFolder[FolderKeys[_type]]?.filter(entity=>entity.name===fileName)??[]) {
                    matches.push({entity,type:_type as FileType});
                }
            }
            if (matches.length>1) { throw new Error(`Ambiguous remote path: duplicate entity ${fileName}`); }
            return matches.length ? [matches[0].entity,matches[0].type,matches[0].entity._id] : [];
        })();
        return {parentFolder, fileName, fileEntity, fileType, fileId};
    }

    _resolveById(entityId: string, root?: FolderEntity, path?:string):{
        parentFolder: FolderEntity, fileEntity: FileEntity, fileType:FileType, path:string
    } | undefined {
        if (!this.root) {
            throw vscode.FileSystemError.FileNotFound();
        }
        root = root || this.root.rootFolder[0];
        path = path || '/';

        if (root._id === entityId) {
            return {parentFolder: root, fileType: 'folder', fileEntity: root, path};
        } else {
            // search files in root
            for (const _type of Object.keys(FolderKeys)) {
                const key = FolderKeys[_type];
                if (key==='folders') { continue; }
                const entity = root[key]?.find((entity) => entity._id === entityId);
                if (entity) {
                    return {parentFolder: root, fileType: _type as FileType, fileEntity: entity, path:path+entity.name};
                }
            }
            // recursive search
            for (const folder of root.folders) {
                const res = this._resolveById(entityId, folder, path+folder.name+'/');
                if (res) { return res; }
            }
        }
        return undefined;
    }

    walk(filter:(entity:FileEntity)=>boolean): {entity:FileEntity, path:string}[] {
        const result = [];
        const folders = this.root ? [{entity:this.root.rootFolder[0], path:'/'}] : [];

        // apply filter to root folder
        filter(folders[0].entity) && result.push(folders[0]);
        // walk through all folders
        for (const folder of folders) {
            for (const [key,value] of Object.entries(FolderKeys)) {
                if (value==='folders') {
                    folder.entity[value]?.forEach((entity) => {
                        folders.push({entity, path:folder.path+entity.name+'/'});
                    });
                }
                folder.entity[value]?.forEach((entity) => {
                    entity._type = key as FileType;
                    filter(entity) && result.push({ entity, path:folder.path+entity.name });
                });
            };
        }

        return result;
    }

    private insertEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index===undefined || index<0) {
            parentFolder[key]?.push(entity as any);
        }
    }

    private treeIndex(project?:ProjectEntity):Map<string,{path:string;signature:string}> {
        const result=new Map<string,{path:string;signature:string}>();
        const root=project?.rootFolder?.[0]; if (!root) { return result; }
        const visit=(folder:FolderEntity,prefix:string)=>{
            for (const doc of folder.docs??[]) {
                result.set(doc._id,{path:prefix+doc.name,signature:`doc:${doc.version??-1}:${doc.lastVersion??-1}`});
            }
            for (const file of folder.fileRefs??[]) {
                result.set(file._id,{path:prefix+file.name,signature:`file:${(file as any).created??''}:${(file as any).updatedAt??''}`});
            }
            for (const child of folder.folders??[]) { visit(child,`${prefix}${child.name}/`); }
        };
        visit(root,'/'); return result;
    }

    private publishReconnectTreeChanges(before:Map<string,{path:string;signature:string}>,after:Map<string,{path:string;signature:string}>):void {
        const events:vscode.FileChangeEvent[]=[];
        for (const [id,oldEntry] of before) {
            const next=after.get(id);
            if (!next) { events.push({type:vscode.FileChangeType.Deleted,uri:this.pathToUri(oldEntry.path)}); }
            else if (next.path!==oldEntry.path) {
                events.push({type:vscode.FileChangeType.Deleted,uri:this.pathToUri(oldEntry.path)},{type:vscode.FileChangeType.Created,uri:this.pathToUri(next.path)});
            } else if (next.signature!==oldEntry.signature) { events.push({type:vscode.FileChangeType.Changed,uri:this.pathToUri(next.path)}); }
        }
        for (const [id,next] of after) { if (!before.has(id)) { events.push({type:vscode.FileChangeType.Created,uri:this.pathToUri(next.path)}); } }
        if (events.length) { this.notify(events); }
    }

    private removeEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private removeEntityById(parentFolder: FolderEntity, fileType:FileType, entityId: string, recursive?:boolean) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entityId);
        if (index!==undefined && index>=0) {
            const entity=parentFolder[key]?.[index];
            if (entity) { this.removeMetadata(entity,fileType); }
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private removeMetadata(entity:FileEntity,type:FileType):void {
        this.projectMetadata.remove(entity._id);
        this.metadataTasks?.cancel(entity._id);
        if (type==='folder') {
            const folder=entity as FolderEntity;
            for (const doc of folder.docs??[]) { this.removeMetadata(doc,'doc'); }
            for (const child of folder.folders??[]) { this.removeMetadata(child,'folder'); }
        }
    }

    private remoteWatch(): void {
        this.socket.updateEventHandlers({
            onOtError:docId=>{
                this.otDocuments?.peek(docId)?.fail(new Error('The server rejected the document operation; local changes retained'));
            },
            onDisconnected: () => {
                this.otDocuments?.disconnect();
                if (this.disposed) { return; }
                if (this.root===undefined) { return; } // bypass the first initialization
                console.log("Disconnected");
                // Never expose the pre-disconnect project tree as a fresh snapshot.
                this.metadataTasks?.dispose();
                this.metadataCache?.reset();
                this.disconnectedTree=this.treeIndex(this.root);
                this.root=undefined;
                this.initializing=undefined;
                if (this.socket.isForcedDisconnected) {
                    this.reconnectError=new Error('Server forced disconnection; run Overleaf: Retry Connection when available');
                    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer=undefined; }
                    this.closeReconnectingProgress();
                    void vscode.window.showWarningMessage(
                        'The Overleaf server requested a disconnect. Automatic reconnection is paused. After maintenance, run Overleaf: Retry Connection.',
                        'Retry Connection',
                    ).then(action=>{
                        if (action==='Retry Connection' && !this.disposed) {
                            void this.retryInitialization().catch(error=>vscode.window.showErrorMessage(`Unable to reconnect: ${error.message}`));
                        }
                    });
                    return;
                }
                if (this.retryTimer) { return; }
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = undefined;
                    if (this.disposed || this.reconnectError) { return; }
                    if (!this.initializing) {
                        this.initializing = this.initializingPromise;
                        void this.initializing.catch(error=>console.error(`${ROOT_NAME}: reconnect failed`,error));
                    }
                }, (3+Math.floor(Math.random()*7))*1000);
            },
            onConnectionAccepted: (publicId:string) => {
                if (this.disposed) { return; }
                // Transport acceptance is not project readiness. The retry task must
                // continue until joinProject succeeds.
                this.publicId = publicId;
            },
            onFileCreated: (parentFolderId:string, type:FileType, entity:FileEntity) => {
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity,path} = res;
                    const entityPath = path + entity.name;
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
                    this.notify([
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(entityPath)}
                    ]);
                }
            },
            onFileRenamed: (entityId:string, newName:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {fileEntity} = res;
                    const oldName = fileEntity.name;
                    fileEntity.name = newName;
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(res.path.replace(oldName, newName))}
                    ]);
                }
            },
            onDocMetadata: data => { this.projectMetadata.update(data); },
            onFileRemoved: (entityId:string) => {
                this.projectMetadata.remove(entityId);
                this.metadataTasks?.cancel(entityId);
                const res = this._resolveById(entityId);
                if (res) {
                    const {parentFolder, fileType, fileEntity} = res;
                    this.removeMetadata(fileEntity,fileType);
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)}
                    ]);
                }
            },
            onFileMoved: (entityId:string, folderId:string) => {
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity as FolderEntity;
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(newPath.path, oldPath.fileEntity.name)}
                    ]);
                }
            },
            onFileChanged: (update:UpdateSchema) => {
                if (this.otDocuments?.receive(update)) { return; }
                const res = this._resolveById(update.doc);
                if (res===undefined) { return; }

                // Only the OT session may advance a subscribed document's version.
                // An unsolicited update for an unopened document invalidates its hint.
                (res.fileEntity as DocumentEntity).remoteCache=undefined;
            },
            onSpellCheckLanguageUpdated: (language:string) => {
                if (this.root) {
                    this.root.spellCheckLanguage = language;
                    EventBus.fire('spellCheckLanguageUpdateEvent', {language});
                }
            },
            onCompilerUpdated: (compiler:string) => {
                if (this.root) {
                    this.root.compiler = compiler;
                    EventBus.fire('compilerUpdateEvent', {compiler,uri:this.origin});
                }
            },
            onRootDocUpdated: (rootDocId:string) => {
                //NOTE: do not sync rootDocId
                // if (this.root) {
                //     this.root.rootDoc_id = rootDocId;
                //     EventBus.fire('rootDocUpdateEvent', {rootDocId});
                // }
            },
        });
    }

    pathToUri(...path: string[]): vscode.Uri {
        return vscode.Uri.joinPath(this.origin, ...path);
    }

    async resolve(uri: vscode.Uri): Promise<File> {
        const {fileName, fileEntity, fileType} = await this._resolveUri(uri);
        const readonly = fileEntity?.readonly ? vscode.FilePermission.Readonly : undefined;
        switch (fileType) {
            case undefined:
                throw vscode.FileSystemError.FileNotFound(uri);
            case 'folder':
                return new File(fileName, vscode.FileType.Directory, undefined, readonly);
            case 'file':
                if ((fileEntity as FileRefEntity).linkedFileData!==null) {
                    return new File(fileName, vscode.FileType.File | vscode.FileType.SymbolicLink, Date.parse((fileEntity as FileRefEntity).created), readonly);
                } else {
                    return new File(fileName, vscode.FileType.File, Date.parse((fileEntity as FileRefEntity).created), readonly);
                }
            default:
                return new File(fileName, vscode.FileType.File, undefined, readonly);
        }
    }

    async list(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const {fileEntity} = await this._resolveUri(uri);
        const folder = fileEntity as FolderEntity;
        let results:[string, vscode.FileType][] = [];
        if (folder) {
            Object.values(FolderKeys).forEach((key) => {
                const _type = key==='folders'? vscode.FileType.Directory : vscode.FileType.File;
                folder[key]?.forEach((entity) => {
                    results.push([entity.name, _type]);
                });
            });
        }
        return results;
    }

    async readEditorFile(uri:vscode.Uri):Promise<Uint8Array> {
        const content=await this.openFile(uri);
        const {fileType,fileEntity}=await this._resolveUri(uri);
        if (fileType==='doc' && fileEntity) {
            this.editorBases??=new Map();
            const dirty=vscode.workspace.textDocuments.some(document=>document.uri.toString()===uri.toString()&&document.isDirty);
            if (!dirty || !this.editorBases.has(fileEntity._id)) { this.editorBases.set(fileEntity._id,new TextDecoder('utf8',{fatal:true}).decode(content)); }
        }
        return content;
    }

    private get documents():OtDocuments {
        if (!this.otDocuments) {
            const identity=createHash('sha256').update(`${this.serverName}\0${this.projectId}\0${this.userId}`).digest('hex');
            const root=vscode.Uri.joinPath(this.context.globalStorageUri,'ot',identity);
            const store=new SyncStateStore(root.fsPath,{projectId:this.projectId,serverIdentityHash:identity});
            this.otOutput=vscode.window.createOutputChannel('Overleaf OT');
            this.otDocuments=new OtDocuments(store,{
                join:async(id,version)=>{
                    await vscode.workspace.fs.createDirectory(root);
                    return this.socket.joinDoc(id,version);
                },source:()=>this.publicId,
                send:update=>this.socket.applyOtUpdate(update.doc,update as UpdateSchema),
                log:(id,stage,elapsed)=>this.otOutput?.appendLine(`${new Date().toISOString()} doc=${id} ${stage} ${elapsed}ms`),
                error:(id,error)=>{ this.otOutput?.appendLine(`doc=${id} paused: ${error.message}`); void vscode.window.showWarningMessage(`Overleaf synchronization paused: ${error.message}`); },
                changed:(id,session,remote,op)=>{
                    const found=this._resolveById(id);
                    if (!found) { return; }
                    const doc=found.fileEntity as DocumentEntity;
                    const savedChanged=doc.localCache!==session.saved;
                    const confirmedChanged=doc.remoteCache!==session.confirmed;
                    if (confirmedChanged) {
                        this.isDirty=true;
                        if (!remote && doc.remoteCache!==undefined) { this.scheduleMetadataRefresh(id); }
                    }
                    doc.version=session.version; doc.remoteCache=session.confirmed; doc.localCache=session.saved;
                    const uri=this.pathToUri(found.path);
                    const editor=vscode.workspace.textDocuments.find(item=>item.uri.toString()===uri.toString());
                    if (editor) { this.bindOtEditor(editor,session); }
                    for (const binding of [...this.otEditors.values()]) {
                        if (binding.session.id===id && binding.session!==session && !binding.document.isClosed) { this.bindOtEditor(binding.document,session); }
                    }
                    for (const binding of this.otEditors.values()) {
                        if (binding.session===session) { void binding.refresh().catch(()=>undefined); }
                    }
                    if (savedChanged) { this.notify([{type:vscode.FileChangeType.Changed,uri}]); }
                    this.otListeners.forEach(listener=>listener(id,op));
                },
            },vscode.workspace.fs.createDirectory(root));
        }
        return this.otDocuments;
    }
    bindOtEditor(document:vscode.TextDocument,session:OtSession):void {
        const key=document.uri.toString();
        if (this.otEditors.get(key)?.session!==session) { this.otEditors.get(key)?.dispose(); this.otEditors.delete(key); }
        if (!this.otEditors.has(key)) {
            this.otEditors.set(key,new OtEditor(document,session,error=>{
                this.otOutput?.appendLine(`editor paused: ${error.message}`);
                void vscode.window.showWarningMessage(`Overleaf editor synchronization paused: ${error.message}`);
            },vscode));
        }
    }
    onOtChange(listener:(id:string,op?:TextOperation)=>void):vscode.Disposable { this.otListeners.add(listener); return new vscode.Disposable(()=>this.otListeners.delete(listener)); }
    async textSession(uri:vscode.Uri):Promise<OtSession|undefined> {
        const {fileType,fileEntity}=await this._resolveUri(uri);
        return fileType==='doc' && fileEntity ? this.documents.get(fileEntity._id) : undefined;
    }
    async confirmedTextSnapshot(uri:vscode.Uri):Promise<RemoteSnapshot|undefined> {
        const session=await this.textSession(uri);
        if (!session) { return; }
        const {fileEntity}=await this._resolveUri(uri);
        const content=Buffer.from(session.confirmed),hash=contentHash(content)!;
        return {path:uri.path,entityId:fileEntity!._id,kind:'text',content,hash,
            revision:{kind:'document',documentVersion:session.version,contentHash:hash},connectionEpoch:this.socket.connectionEpoch};
    }
    async waitForSavedText():Promise<void> { await this.otDocuments?.barrier(); }
    logSyncStage(stage:string,elapsed:number):void { this.otOutput?.appendLine(`${new Date().toISOString()} ${stage} ${elapsed}ms`); }

    async openFile(uri: vscode.Uri): Promise<Uint8Array> {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (fileType==='doc') {
            const session=await this.documents.get(fileEntity._id);
            EventBus.fire('fileWillOpenEvent',{uri});
            return Buffer.from(session.saved);
        } else if (fileType==='outputs') {
            const {compileGroup, clsiServerId, pdfDownloadDomain} = this;
            return GlobalStateManager.authenticate(this.context, this.serverName)
            .then((identity) => {
                return this.api.getFileFromClsi(identity, (fileEntity as OutputFileEntity).url, compileGroup || 'standard', clsiServerId, pdfDownloadDomain)
                .then((res) => {
                    if (res.type==='success') {
                        EventBus.fire('fileWillOpenEvent', {uri});
                        return res.content;
                    }
                    throw new Error(res.message??'Failed to download compile output');
                });
            });
        } else {
            const fileId = fileEntity._id;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.getFile(identity, this.projectId, fileId);
            if (res.type==='success' && res.content) {
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content;
            }
            throw new NetworkRequestError(res.errorKind??'fatal-error',res.message??'Failed to download remote file',res.statusCode);
        }
    }

    async describePdf(uri:vscode.Uri):Promise<import('../api/pdfByteSource').PdfSourceDescriptor> {
        const {fileType,fileEntity}=await this._resolveUri(uri);
        if (!fileEntity) { throw vscode.FileSystemError.FileNotFound(uri); }
        const identity=await GlobalStateManager.authenticate(this.context,this.serverName);
        if (fileType==='outputs') {
            return this.api.describePdf(identity,(fileEntity as OutputFileEntity).url,this.outputBuildId??randomUUID(),this.compileGroup,this.clsiServerId,this.pdfDownloadDomain);
        }
        if (fileType==='file') { return this.api.describePdf(identity,`project/${this.projectId}/file/${fileEntity._id}`,randomUUID()); }
        throw vscode.FileSystemError.Unavailable('Only PDF files support byte-range preview');
    }

    /** Reads a versioned snapshot for the safe local-replica synchronizer. */
    async readRemoteSnapshot(uri:vscode.Uri, force=false,retainSubscription=false):Promise<RemoteSnapshot|undefined> {
        const key=`${uri.toString()}\0${force}\0${retainSubscription}`;
        const inFlight=this.snapshotReads.get(key); if (inFlight) { return inFlight; }
        const task=this.readRemoteSnapshotImpl(uri,force,retainSubscription).finally(()=>this.snapshotReads.delete(key));
        this.snapshotReads.set(key,task); return task;
    }

    private async readRemoteSnapshotImpl(uri:vscode.Uri, force:boolean,retainSubscription:boolean):Promise<RemoteSnapshot|undefined> {
        let snapshotEpoch:number|undefined;
        try {
            await this.init();
            snapshotEpoch=this.socket.connectionEpoch;
            if (!this.socket.isReady) { throw new NetworkRequestError('offline','The Overleaf project connection is not ready'); }
            const {fileType,fileEntity}=await this._resolveUri(uri);
            if (!fileEntity || fileType==='folder' || fileType==='outputs') {
                if (this.socket.connectionEpoch!==snapshotEpoch || !this.socket.isReady) {
                    throw new NetworkRequestError('transient-error','The project connection changed while verifying remote absence');
                }
                return undefined;
            }
            let content:Uint8Array;
            if (fileType==='doc') {
                const session=await this.documents.get(fileEntity._id);
                content=Buffer.from(session.confirmed);
                (fileEntity as DocumentEntity).version=session.version;
            } else {
                content=await this.openFile(uri);
            }
            if (this.socket.connectionEpoch!==snapshotEpoch || !this.socket.isReady) {
                throw new NetworkRequestError('transient-error','The project connection changed while reading a remote snapshot');
            }
            const hash=contentHash(content)!;
            const revision:RemoteRevision=fileType==='doc'
                ? {kind:'document',documentVersion:(fileEntity as DocumentEntity).version??-1,contentHash:hash}
                : {kind:'file',entityId:fileEntity._id,contentHash:hash};
            return {path:uri.path,entityId:fileEntity._id,kind:fileType==='doc'?'text':'binary',content,hash,revision,connectionEpoch:snapshotEpoch};
        } catch (error:any) {
            if (error instanceof vscode.FileSystemError && error.code==='FileNotFound') {
                if (snapshotEpoch===this.socket.connectionEpoch && this.socket.isReady) { return undefined; }
                throw new NetworkRequestError('transient-error','The project connection changed while resolving a remote file');
            }
            throw error;
        }
    }

    private isRemoteDocumentOpen(uri:vscode.Uri):boolean {
        return vscode.workspace.textDocuments.some(document=>document.uri.toString()===uri.toString());
    }

    async applyDocumentSnapshot(uri:vscode.Uri,expected:RemoteRevision|undefined,content:Uint8Array):Promise<ApplyResult> {
        return this.applyVerifiedDocumentSnapshot(uri,expected,content);
    }

    async applyFileSnapshot(uri:vscode.Uri,expected:RemoteRevision|undefined,content:Uint8Array,operationId:string=randomUUID()):Promise<ApplyResult> {
        const operationEpoch=this.socket.connectionEpoch;
        const slash=uri.path.lastIndexOf('/'),name=uri.path.slice(slash+1);
        const temporaryPath=`${uri.path.slice(0,slash+1)}.overleaf-sync-${operationId}-${name}`;
        const temporaryUri=uri.with({path:temporaryPath});
        try {
            const [before,existingTemporary]=await Promise.all([this.readRemoteSnapshot(uri,true),this.readRemoteSnapshot(temporaryUri,true)]);
            if (expected && (!before || before.hash!==expected.contentHash || before.entityId!==(expected.kind==='file'?expected.entityId:before.entityId))) {
                return {type:'conflict',snapshot:before,message:'Remote binary revision changed before staging'};
            }
            if (existingTemporary && existingTemporary.hash!==contentHash(content)) {
                return {type:'conflict',snapshot:existingTemporary,message:`A different staged upload already exists at ${temporaryPath}`,temporaryPath,temporaryEntityId:existingTemporary.entityId};
            }
            if (!existingTemporary) {
                try { await this.createUploadedFile(temporaryUri,content); }
                catch (error:any) {
                    if (!(error instanceof NetworkRequestError) || !['offline','transient-error','unknown-outcome'].includes(error.kind)) { throw error; }
                    await this.refreshProjectTree();
                    const uncertainStage=await this.readRemoteSnapshot(temporaryUri,true);
                    return {
                        type:'unknown',
                        message:uncertainStage?.hash===contentHash(content)
                            ? 'The staged upload exists, but its original response was lost; replacement was paused for recovery'
                            : 'The staged upload result is unknown; replacement was paused without deleting the original',
                        temporaryPath,
                        temporaryEntityId:uncertainStage?.entityId,
                    };
                }
            }
            const staged=await this.readRemoteSnapshot(temporaryUri,true);
            if (!staged || staged.hash!==contentHash(content)) {
                return {type:'unknown',message:'Staged binary upload could not be verified',temporaryPath,temporaryEntityId:staged?.entityId};
            }
            if (this.socket.connectionEpoch!==operationEpoch || staged.connectionEpoch!==operationEpoch
                || (before && before.connectionEpoch!==operationEpoch)) {
                return {type:'unknown',snapshot:before,message:'Connection changed before the staged binary could replace the original',temporaryPath,temporaryEntityId:staged.entityId};
            }
            if (before) {
                await this.remove(uri,false);
                if (await this.readRemoteSnapshot(uri,true)) {
                    return {type:'unknown',message:'Original binary deletion could not be verified',temporaryPath,temporaryEntityId:staged.entityId};
                }
            }
            await this.rename(temporaryUri,uri,false);
            const after=await this.readRemoteSnapshot(uri,true);
            if (this.socket.connectionEpoch!==operationEpoch) {
                return {type:'unknown',snapshot:after,message:'Binary upload verification crossed a connection boundary',temporaryPath,temporaryEntityId:staged.entityId};
            }
            if (after?.entityId===staged.entityId && after.hash===contentHash(content)) {
                if (before?.hash!==after.hash) { this.isDirty=true; }
                return {type:'verified',snapshot:after,temporaryPath,temporaryEntityId:staged.entityId};
            }
            return {type:'unknown',snapshot:after,message:'Staged binary rename could not be verified',temporaryPath,temporaryEntityId:staged.entityId};
        } catch (error:any) {
            return {type:'unknown',message:error?.message??String(error),temporaryPath};
        }
    }

    async recoverStagedFileSnapshot(entry:JournalEntry,remoteBefore?:Uint8Array):Promise<ApplyResult> {
        if (!entry.temporaryPath || !entry.targetHash) { return {type:'failed',message:'Journal has no staged binary identity'}; }
        const targetUri=this.pathToUri('/'+entry.path);
        const temporaryUri=this.pathToUri('/'+entry.temporaryPath.replace(/^\//,''));
        try {
            let target:RemoteSnapshot|undefined,temporary:RemoteSnapshot|undefined;
            try { [target,temporary]=await Promise.all([this.readRemoteSnapshot(targetUri,true),this.readRemoteSnapshot(temporaryUri,true)]); }
            catch {
                // A mutation whose response was lost can leave the in-memory tree stale.
                // Refresh once before deciding whether either entity exists; never infer
                // deletion from the stale cache.
                await this.refreshProjectTree();
                [target,temporary]=await Promise.all([this.readRemoteSnapshot(targetUri,true),this.readRemoteSnapshot(temporaryUri,true)]);
            }
            const recoveryEpoch=this.socket.connectionEpoch;
            if ((target && target.connectionEpoch!==recoveryEpoch) || (temporary && temporary.connectionEpoch!==recoveryEpoch)) {
                return {type:'unknown',snapshot:target,message:'Connection changed while reading staged binary recovery state',temporaryPath:entry.temporaryPath,temporaryEntityId:temporary?.entityId};
            }
            if (target?.hash===entry.targetHash) {
                if (temporary?.hash===entry.targetHash) {
                    await this.remove(temporaryUri,false);
                    temporary=await this.readRemoteSnapshot(temporaryUri,true);
                    if (temporary) { return {type:'unknown',snapshot:target,message:'Committed target is safe, but duplicate staged entity remains',temporaryPath:entry.temporaryPath,temporaryEntityId:temporary.entityId}; }
                }
                return {type:'verified',snapshot:target};
            }
            const originalHash=remoteBefore&&contentHash(remoteBefore);
            if (temporary?.hash===entry.targetHash && (!target || (target.entityId===entry.originalEntityId && target.hash===originalHash))) {
                if (target) {
                    await this.remove(targetUri,false);
                    if (this.socket.connectionEpoch!==recoveryEpoch) { return {type:'unknown',message:'Connection changed while deleting the original binary',temporaryPath:entry.temporaryPath,temporaryEntityId:temporary.entityId}; }
                    if (await this.readRemoteSnapshot(targetUri,true)) { return {type:'unknown',message:'Original entity deletion remains unverified',temporaryPath:entry.temporaryPath,temporaryEntityId:temporary.entityId}; }
                }
                await this.rename(temporaryUri,targetUri,false);
                const after=await this.readRemoteSnapshot(targetUri,true);
                return this.socket.connectionEpoch===recoveryEpoch && after?.connectionEpoch===recoveryEpoch
                    && after.entityId===temporary.entityId && after.hash===entry.targetHash
                    ? {type:'verified',snapshot:after}
                    : {type:'unknown',snapshot:after,message:'Staged rename remains unverified',temporaryPath:entry.temporaryPath,temporaryEntityId:temporary.entityId};
            }
            if (!target && !temporary && remoteBefore) {
                await this.createUploadedFile(targetUri,remoteBefore);
                target=await this.readRemoteSnapshot(targetUri,true);
                return target?.hash===originalHash
                    ? {type:'failed',snapshot:target,message:'Both remote entities were absent; the saved original was restored'}
                    : {type:'unknown',snapshot:target,message:'Could not verify restoration of the saved remote original'};
            }
            if (target && !temporary && remoteBefore && target.hash===originalHash && target.entityId===entry.originalEntityId) {
                return {type:'failed',snapshot:target,message:'The interrupted replacement was verified as not applied'};
            }
            return {type:'conflict',snapshot:target,message:'Staged binary recovery found an ambiguous remote state',temporaryPath:entry.temporaryPath,temporaryEntityId:temporary?.entityId};
        } catch (error:any) {
            return {type:'unknown',message:error?.message??String(error),temporaryPath:entry.temporaryPath,temporaryEntityId:entry.temporaryEntityId};
        }
    }

    private async applyVerifiedDocumentSnapshot(uri:vscode.Uri,expected:RemoteRevision|undefined,content:Uint8Array):Promise<ApplyResult> {
        try {
            let session=await this.textSession(uri);
            if (!session) {
                if (expected) { return {type:'conflict',message:'Remote document disappeared'}; }
                await this.createFile(uri,new Uint8Array(),false);
                session=await this.textSession(uri);
            }
            if (!session) { return {type:'failed',message:'Could not initialize document OT'}; }
            const before=await this.confirmedTextSnapshot(uri);
            if (expected && (!before || !sameRemoteRevision(before.revision,expected))) {
                return {type:'conflict',snapshot:before,message:'Recovery baseline changed'};
            }
            await session.save(new TextDecoder('utf8',{fatal:true}).decode(content));
            if (before?.hash!==contentHash(Buffer.from(session.confirmed))) { this.isDirty=true; }
            return {type:'verified',snapshot:await this.confirmedTextSnapshot(uri)};
        } catch (error:any) { return {type:'unknown',message:error?.message??String(error)}; }
    }

    async deleteRemoteSnapshot(uri:vscode.Uri,expected?:RemoteRevision):Promise<ApplyResult> {
        const operationEpoch=this.socket.connectionEpoch;
        try {
            const before=await this.readRemoteSnapshot(uri,true);
            if (this.socket.connectionEpoch!==operationEpoch || (before && before.connectionEpoch!==operationEpoch)) {
                return {type:'unknown',snapshot:before,message:'Connection changed before remote delete'};
            }
            if (!before) { return expected
                ? {type:'conflict',message:'The expected remote entity is no longer present'}
                : {type:'verified',connectionEpoch:operationEpoch}; }
            if (!expected || !sameRemoteRevision(before.revision,expected)) { return {type:'conflict',snapshot:before,message:'Remote revision changed before delete'}; }
            await this.remove(uri,true);
            const after=await this.readRemoteSnapshot(uri,true);
            if (this.socket.connectionEpoch!==operationEpoch) { return {type:'unknown',snapshot:after,message:'Remote delete verification crossed a connection boundary'}; }
            if (after) { return {type:'unknown',snapshot:after,message:'Remote delete could not be verified'}; }
            this.isDirty=true;
            return {type:'verified',connectionEpoch:operationEpoch};
        } catch (error:any) { return {type:'unknown',message:error?.message??String(error)}; }
    }

    async renameRemoteSnapshot(oldUri:vscode.Uri,newUri:vscode.Uri,expected?:RemoteRevision):Promise<ApplyResult> {
        const operationEpoch=this.socket.connectionEpoch;
        try {
            const [before,target]=await Promise.all([this.readRemoteSnapshot(oldUri,true),this.readRemoteSnapshot(newUri,true)]);
            if (this.socket.connectionEpoch!==operationEpoch || before?.connectionEpoch!==operationEpoch || (target && target.connectionEpoch!==operationEpoch)) {
                return {type:'unknown',snapshot:before,message:'Connection changed before remote rename'};
            }
            if (!before) { return {type:'conflict',message:'Remote rename source no longer exists'}; }
            if (target) { return {type:'conflict',snapshot:target,message:'Remote rename target already exists'}; }
            if (expected && !sameRemoteRevision(before.revision,expected)) {
                return {type:'conflict',snapshot:before,message:'Remote source changed before rename'};
            }
            await this.rename(oldUri,newUri,false);
            const after=await this.readRemoteSnapshot(newUri,true);
            if (this.socket.connectionEpoch===operationEpoch && after?.connectionEpoch===operationEpoch
                && after.entityId===before.entityId && after.hash===before.hash) {
                this.isDirty=true;
                return {type:'verified',snapshot:after};
            }
            return {type:'unknown',snapshot:after,message:'Remote rename could not be verified'};
        } catch (error:any) { return {type:'unknown',message:error?.message??String(error)}; }
    }

    async createFile(uri: vscode.Uri, content:Uint8Array, overwrite?:boolean):Promise<FileEntity> {
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        if (fileEntity && !overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }

        let res = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);

        if (content.length===0) {
            const _res = await this.api.addDoc(identity, this.projectId, parentFolder._id, fileName);
            if (_res.type==='success') {
                res = _res.entity;
            } else { throw new NetworkRequestError(_res.errorKind??'fatal-error',_res.message??'Remote document creation failed',_res.statusCode); }
        } else {
            const parentFolderId = parentFolder._id;
            const _res = await this.api.uploadFile(identity, this.projectId, parentFolderId, fileName, content);
            if (_res.type==='success' && _res.entity!==undefined) {
                res = _res.entity;
            } else {
                throw new NetworkRequestError(_res.errorKind??'fatal-error',_res.message??'Remote upload failed',_res.statusCode);
            }
        }
        if (res && res._type) {
            this.insertEntity(parentFolder, res._type, res);
            if (res._type==='doc' && content.length) { this.scheduleMetadataRefresh(res._id,250); }
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
            return res;
        }
        throw new NetworkRequestError(res?'fatal-error':'unknown-outcome','Remote create returned no entity');
    }

    private async createUploadedFile(uri:vscode.Uri,content:Uint8Array):Promise<FileEntity> {
        const {parentFolder,fileName,fileEntity}=await this._resolveUri(uri);
        if (fileEntity) { throw vscode.FileSystemError.FileExists(uri); }
        const identity=await GlobalStateManager.authenticate(this.context,this.serverName);
        const result=await this.api.uploadFile(identity,this.projectId,parentFolder._id,fileName,content);
        if (result.type!=='success' || !result.entity || result.entity._type!=='file') {
            throw new NetworkRequestError(result.errorKind??'fatal-error',result.message??'Binary upload did not create a file entity',result.statusCode);
        }
        this.insertEntity(parentFolder,'file',result.entity);
        this.notify([{type:vscode.FileChangeType.Created,uri}]);
        return result.entity;
    }

    async refreshLinkedFile(uri: vscode.Uri) {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType==='file' && fileEntity) {
            if ((fileEntity as FileRefEntity).linkedFileData===null) {
                void vscode.window.showInformationMessage(vscode.l10n.t('This is not an external linked file.'));
                return;
            }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${vscode.l10n.t('Refreshing')} ${fileEntity.name}`,
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {});
                
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
                const res = await (this.api as ExtendedBaseAPI).refreshLinkedFile(identity, this.projectId, fileEntity._id);

                if (res.type==='success' && res.message!==undefined) {
                    // refresh the entity id
                    fileEntity._id = res.message;
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri},
                    ]);
                    progress.report({message: vscode.l10n.t('Done')});
                } else {
                    if (res.message!==undefined) {
                        throw new Error(res.message);
                    }
                }
            });
        }
    }

    async createLinkedFile(uri: vscode.Uri) {
        const res = await this._resolveUri(uri);
        const parentFolder = res.fileType==='folder' ? res.fileEntity as FolderEntity : res.parentFolder;

        const supportedProviders = [
            vscode.l10n.t('From Another Project'),
            vscode.l10n.t('From External URL'),
        ];
        const selection = await vscode.window.showQuickPick(supportedProviders, {
            placeHolder: vscode.l10n.t('Import file from...'),
        });

        let provider = undefined, entityId = undefined, fileName = undefined, data = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        if (selection === vscode.l10n.t('From Another Project')) {
            provider = 'project_file';
            const allTags = (await this.api.getAllTags(identity)).tags || [];
            const projectId = await vscode.window.showQuickPick(
                (await this.api.userProjectsJson(identity)).projects!
                .filter(project => project.id!==this.projectId)
                .map(project => {
                    let detail = '';
                    for (const tag of allTags) {
                        if (tag.project_ids.includes(project.id)) {
                            detail += `$(tag) ${tag.name} `;
                        }
                    }
                    return {label: project.name, id: project.id, detail};
                }),
                {
                    title: vscode.l10n.t('Select a Project'),
                    ignoreFocusOut: true,
                }
            );
            const filePath = projectId && await vscode.window.showQuickPick(
                (await this.api.projectEntitiesJson(identity, projectId!.id)).entities!.map(entity => entity.path),
                {
                    title: vscode.l10n.t('Select a File'),
                    ignoreFocusOut: true,
                }
            );
            fileName = filePath && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: filePath?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {source_entity_path: filePath!, source_project_id: projectId!.id};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else if (selection === vscode.l10n.t('From External URL')) {
            provider = 'url';
            const url = await vscode.window.showInputBox({
                title: vscode.l10n.t('URL to fetch the file from'),
                placeHolder: 'https://example.com/my-file.png',
                ignoreFocusOut: true,
            });
            fileName = url && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: url?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {url:url!};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else {
            return;
        }

        // insert entity
        const entity = {
            _id: entityId!, name: fileName!, _type: 'file', readonly: false,
            linkedFileData: { provider, ...data! },
            created: new Date().toISOString(),
        } as FileRefEntity;
        this.insertEntity(parentFolder, 'file', entity);
        const {path} = this._resolveById(entityId!)!;
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri.with({path:`/${this.projectName}${path}`})},
        ]);
    }

    async writeFile(uri:vscode.Uri,content:Uint8Array,create:boolean,overwrite:boolean):Promise<void> {
        this.editorWrites??=new Map();
        const key=uri.toString(),bytes=content.slice();
        const task=(this.editorWrites.get(key)??Promise.resolve()).catch(()=>undefined).then(()=>this.writeEditorFile(uri,bytes,create,overwrite));
        this.editorWrites.set(key,task);
        try { await task; } finally { if (this.editorWrites.get(key)===task) { this.editorWrites.delete(key); } }
    }

    private async writeEditorFile(uri:vscode.Uri,content:Uint8Array,create:boolean,overwrite:boolean):Promise<void> {
        const {fileType,fileEntity}=await this._resolveUri(uri);
        if (!fileType) {
            if (!create) { throw vscode.FileSystemError.FileNotFound(uri); }
            await this.createFile(uri,content,false); return;
        }
        if (!overwrite) { throw vscode.FileSystemError.FileExists(uri); }
        if (fileEntity?.readonly || fileType==='outputs') { throw vscode.FileSystemError.NoPermissions(uri); }
        if (fileType==='folder') { throw vscode.FileSystemError.FileIsADirectory(uri); }
        if (fileType!=='doc' || !fileEntity) { await this.createFile(uri,content,true); return; }
        if (!this.documents.peek(fileEntity._id)) { throw vscode.FileSystemError.Unavailable('The editing baseline is unavailable; open the document before saving'); }
        const session=await this.documents.get(fileEntity._id);
        const document=vscode.workspace.textDocuments.find(item=>item.uri.toString()===uri.toString());
        if (document) { this.bindOtEditor(document,session); }
        const target=new TextDecoder('utf8',{fatal:true}).decode(content);
        const binding=this.otEditors.get(uri.toString());
        if (binding) { await binding.save(target); } else { await session.save(target); }
        this.scheduleMetadataRefresh(fileEntity._id);
        this.isDirty=true;
        this.notify([{type:vscode.FileChangeType.Changed,uri}]);
    }

    async mkdir(uri: vscode.Uri) {
        const {parentFolder, fileName} = await this._resolveUri(uri);
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);

        if (res.type==='success' && res.entity!==undefined) {
            this.insertEntity(parentFolder, 'folder', res.entity as FolderEntity);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
        } else { throw new NetworkRequestError(res.errorKind??'fatal-error',res.message??'Remote folder creation failed',res.statusCode); }
    }

    async remove(uri: vscode.Uri, recursive: boolean) {
        const {parentFolder, fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType && fileEntity) {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
            if (res.type==='success') {
                this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: uri},
                ]);
            } else { throw new NetworkRequestError(res.errorKind??'fatal-error',res.message??'Remote delete failed',res.statusCode); }
        }
    }

    async rename(oldUri:vscode.Uri,newUri:vscode.Uri,force:boolean):Promise<void> {
        const task=(this.remoteTreeWrites??Promise.resolve()).catch(()=>undefined).then(()=>this.renameImpl(oldUri,newUri,force));
        this.remoteTreeWrites=task.catch(()=>undefined); await task;
    }
    private async renameImpl(oldUri:vscode.Uri,newUri:vscode.Uri,force:boolean):Promise<void> {
        const from=parseUri(oldUri),to=parseUri(newUri);
        if (from.serverName!==to.serverName || from.userId!==to.userId || from.projectId!==to.projectId) { throw vscode.FileSystemError.NoPermissions('A move must stay within the same Overleaf project'); }
        const oldPath=await this._resolveUri(oldUri),newPath=await this._resolveUri(newUri);
        if (!oldPath.fileType || !oldPath.fileEntity) { throw vscode.FileSystemError.FileNotFound(oldUri); }
        const entity=oldPath.fileEntity,type=oldPath.fileType;
        if (entity.readonly || type==='outputs' || newPath.parentFolder.readonly || newPath.fileEntity?.readonly) { throw vscode.FileSystemError.NoPermissions(oldUri); }
        if (type==='folder' && newUri.path.startsWith(oldUri.path+'/')) { throw vscode.FileSystemError.NoPermissions('A folder cannot be moved into itself'); }
        if (newPath.fileEntity?._id===entity._id) { return; }
        if (newPath.fileType && !force) { throw vscode.FileSystemError.FileExists(newUri); }
        const identity=await GlobalStateManager.authenticate(this.context,this.serverName);
        const requireSuccess=(response:any)=>{ if (response?.type!=='success') { throw new NetworkRequestError(response?.errorKind??'unknown-outcome',response?.message??'Remote move or rename was not confirmed',response?.statusCode); } };
        let currentParent=oldPath.parentFolder,backupUri:vscode.Uri|undefined;
        try {
            if (newPath.fileEntity) {
                if (newPath.fileType==='folder') { throw vscode.FileSystemError.NoPermissions('Overwriting a remote directory is not supported'); }
                const before=await this.readRemoteSnapshot(newUri,true);
                if (!before || !this.context.globalStorageUri) { throw vscode.FileSystemError.Unavailable('The replacement target could not be backed up'); }
                const directory=vscode.Uri.joinPath(this.context.globalStorageUri,'remote-replacement-backups',randomUUID());
                backupUri=vscode.Uri.joinPath(directory,'content');
                await vscode.workspace.fs.createDirectory(directory);
                await vscode.workspace.fs.writeFile(backupUri,before.content);
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory,'metadata.json'),Buffer.from(JSON.stringify({uri:newUri.toString(),fileName:newPath.fileName,entityId:before.entityId,hash:before.hash,createdAt:Date.now()})));
                if (contentHash(await vscode.workspace.fs.readFile(backupUri))!==before.hash) { throw new Error('Replacement backup verification failed'); }
                const latest=await this.readRemoteSnapshot(newUri,true);
                if (!latest || latest.entityId!==before.entityId || !sameRemoteRevision(latest.revision,before.revision)) { throw new Error('The replacement target changed while being backed up'); }
                await this.remove(newUri,false);
            }
            if (currentParent._id!==newPath.parentFolder._id) {
                const intermediateExists=Object.values(FolderKeys).some(key=>((newPath.parentFolder as any)[key]??[]).some((item:FileEntity)=>item.name===entity.name));
                if (intermediateExists) {
                    const temporaryName=`.overleaf-sync-${randomUUID()}-${entity.name}`;
                    requireSuccess(await this.api.renameEntity(identity,this.projectId,type,entity._id,temporaryName));
                    entity.name=temporaryName;
                }
                requireSuccess(await this.api.moveEntity(identity,this.projectId,type,entity._id,newPath.parentFolder._id));
                this.removeEntity(currentParent,type,entity); this.insertEntity(newPath.parentFolder,type,entity); currentParent=newPath.parentFolder;
            }
            if (entity.name!==newPath.fileName) {
                requireSuccess(await this.api.renameEntity(identity,this.projectId,type,entity._id,newPath.fileName));
                entity.name=newPath.fileName;
            }
            this.notify([{type:vscode.FileChangeType.Deleted,uri:oldUri},{type:vscode.FileChangeType.Created,uri:newUri}]);
        } catch (error:any) {
            await this.refreshProjectTree().catch(()=>undefined);
            const actual=this._resolveById(entity._id)?.path??`${currentParent.name}/${entity.name}`;
            throw new NetworkRequestError('unknown-outcome',`Move/rename incomplete: ${error.message}. Current known path: ${actual}${backupUri?`. Replaced content is backed up at ${backupUri.fsPath}`:''}`);
        }
    }

    private compileRecoveryNeeded=false;
    lastCompileStatus?:string;
    lastCompileHasLog=false;

    async compile(force:boolean=false, draft:boolean=false, stopOnFirstError:boolean=false, rootDocId?:string, signal?:AbortSignal) {
        if (force || (this.root && this.isDirty)) {
            this.isDirty = false;
            let completed=false;
            try {
            this.lastCompileHasLog=false;
            this.lastCompileStatus=undefined;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            // compile project
            const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
            let rootResourcePath: string | null = null;
            if (resolvedRootDocId) {
                const rootEntry = this._resolveById(resolvedRootDocId);
                if (rootEntry?.path) {
                    rootResourcePath = rootEntry.path.replace(/^\//, '');
                } else {
                    console.warn(`Unable to resolve root document id '${resolvedRootDocId}' to a path; compiling without explicit rootResourcePath.`);
                }
            }
            const res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError,!force,!this.compileRecoveryNeeded,signal);
            if (res.type!=='success' || !res.compile) {
                this.compileRecoveryNeeded=true;
                throw new NetworkRequestError(res.errorKind??'fatal-error',res.message??'Compile request failed',res.statusCode);
            }
            this.lastCompileStatus=res.compile.status;
            const status=res.compile.status;
            this.compileRecoveryNeeded=!['success','stopped-on-first-error','autocompile-backoff','too-recently-compiled','compile-in-progress'].includes(status);
            this.compileGroup=res.compile.compileGroup;
            this.clsiServerId=res.compile.clsiServerId;
            this.pdfDownloadDomain=res.compile.pdfDownloadDomain;
            const outputs=res.compile.outputFiles??[];
            if (outputs.length) { await this.updateOutputs(outputs); }
            this.lastCompileHasLog=outputs.some(file=>file.path==='output.log');
            completed=status==='success';
            return completed;
            } catch (error) { this.compileRecoveryNeeded=true; throw error;
            } finally { if (!completed) { this.isDirty=true; } }
        }
        return Promise.resolve(undefined);
    }

    async stopCompile() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.stopCompile(identity, this.projectId);
        if (res.type==='success') {
            return true;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        }
    }

    async updateOutputs(outputs: Array<OutputFileEntity>) {
        if (this.root) {
            // update output buildId
            // '/project/65dbfff719ad65b54b9eaed4/user/65094b5fa537faaba0bec01f/build/19620231e54-5372f67292889500/output/output.aux' --> 19620231e54-5372f67292889500'
            this.outputBuildId = outputs[0]?.url.match(/\/build\/([^\/]+)/)?.[1];

            const rootFolder = this.root.rootFolder[0];
            if (this.removeEntityById(rootFolder, 'folder', __OUTPUTS_ID)) {
                this.notify([
                    {type:vscode.FileChangeType.Deleted, uri:this.pathToUri(OUTPUT_FOLDER_NAME)}
                ]);
            }

            this.insertEntity(rootFolder, 'folder', {
                _id: __OUTPUTS_ID,
                name: OUTPUT_FOLDER_NAME,
                readonly: true,
                docs: [], fileRefs: [], folders:[],
                outputs: outputs.map((file) => {
                    file._id = __OUTPUTS_ID;
                    file.name=file.path;
                    file.readonly=true;
                    return file;
                })
            } as FolderEntity);
            this.notify([
                {type:vscode.FileChangeType.Created, uri:this.pathToUri(OUTPUT_FOLDER_NAME)},
                ...(outputs.map((file) => {
                    return {type:vscode.FileChangeType.Changed, uri:this.pathToUri(OUTPUT_FOLDER_NAME, file.path)};
                }))
            ]);
        }
    }

    async syncCode(filePath: string, line:number, column:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncCode(identity, this.projectId, filePath, line, column, this.outputBuildId ?? '');
        if (res.type==='success') {
            return res.syncCode;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async syncPdf(page:number, h:number, v:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncPdf(identity, this.projectId, page, h, v, this.outputBuildId ?? '');
        if (res.type==='success') {
            return res.syncPdf;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    private spellCheckUnavailable=false;

    async spellCheck(uri: vscode.Uri, words: string[]) {
        if (this.spellCheckUnavailable) { return; }
        if (this.root?.spellCheckLanguage==='') { return []; }

        const {fileType} = await this._resolveUri(uri);
        if (fileType==='doc' || fileType==='file') {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = this.root && await this.api.proxyRequestToSpellingApi(identity, this.root.spellCheckLanguage, this.userId, words);
            if (res?.type==='success' && Array.isArray(res.misspellings)) {
                return res.misspellings;
            }
            if (res?.statusCode===404 || res?.statusCode===405 || res?.statusCode===501) {
                this.spellCheckUnavailable=true;
                void vscode.window.showWarningMessage('This Overleaf server does not provide the legacy spell-check service. Built-in spelling checks are unavailable for this project; compilation is unaffected.');
            }
        }
    }

    async spellLearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerLearn(identity, this.userId, word);
        if (res.type==='success') {
            this.root?.settings.learnedWords.push(word);
            return true;
        } else {
            return false;
        }
    }

    async spellUnlearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerUnlearn(identity, word);
        if (res.type==='success') {
            const index = this.root?.settings.learnedWords.findIndex((w) => w===word);
            if (index!==undefined && index>=0) {
                this.root?.settings.learnedWords.splice(index, 1);
            }
            return true;
        } else {
            return false;
        }
    }

    getSpellCheckLanguage() {
        const language = this.root?.spellCheckLanguage;
        if (language==='') {
            return {name:'Off', code:''};
        } else {
            return this.root?.settings.languages.find(item => item.code===language);
        }
    }

    getAllSpellCheckLanguages() {
        return this.root?.settings.languages;
    }

    getCompiler() {
        const compiler = this.root?.compiler;
        const compilerItem = this.root?.settings.compilers.find(item => item.code===compiler);
        return compilerItem;
    }

    getAllCompilers() {
        return this.root?.settings.compilers;
    }

    getDictionary() {
        return this.root?.settings.learnedWords;
    }

    getRootDocName() {
        return this._resolveById(this.root?.rootDoc_id!)?.path ?? '';
    }

    getValidMainDocs() {
        return this.walk((entity) => {
            return entity._type==='doc' && entity.name.match(/\.tex$/g)!==null;
        });
    }

    getProjectSCMPersist(scmKey: string) {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.serverName, this.projectId);
        return scmPersists[scmKey];
    }

    setProjectSCMPersist(scmKey: string, persist: any) {
        return GlobalStateManager.updateServerProjectSCMPersist(this.context, this.serverName, this.projectId, scmKey, persist);
    }

    async updateSettings(setting: any) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.updateProjectSettings(identity, this.projectId, setting);
        if (res.type==='success') {
            const keys = Object.keys(setting);
            if (keys.includes('spellCheckLanguage')) {
                this.root!.spellCheckLanguage = setting.spellCheckLanguage;
            }
            if (keys.includes('compiler')) {
                this.root!.compiler = setting.compiler;
            }
            if (keys.includes('rootDocId')) {
                this.root!.rootDoc_id = setting.rootDocId;
            }
        }
        return res.type==='success'? true : false;
    }

    private scheduleMetadataRefresh(docId:string,delay=2000):void {
        if (this.disposed || !this.root) { return; }
        const tasks=this.metadataTasks??=new DebouncedTasks();
        tasks.schedule(docId,delay,()=>{
            if (this.metadataRunning.has(docId)) { this.scheduleMetadataRefresh(docId); return; }
            const epoch=this.connectionEpoch;
            if (!this.isConnectionReady || !this._resolveById(docId)) { return; }
            this.metadataRunning.add(docId);
            void (async()=>{
                const identity=await GlobalStateManager.authenticate(this.context,this.serverName);
                if (this.disposed || epoch!==this.connectionEpoch) { return; }
                if (this.metadataRefreshUnavailable) {
                    this.projectMetadata.reset();
                    await this.metadata();
                    return;
                }
                const broadcast=(this.clientManagerItem?.manager.collaboratorCount??0)>0;
                const res=await this.api.refreshDocMetadata(identity,this.projectId,docId,broadcast);
                if (this.disposed || epoch!==this.connectionEpoch) { return; }
                if (res.type==='success' && res.meta?.projectMeta) {
                    for (const [id,meta] of Object.entries(res.meta.projectMeta)) { this.projectMetadata.update({docId:id,meta}); }
                } else if (res.type==='error' && [403,404,405,501].includes(res.statusCode??0)) {
                    this.metadataRefreshUnavailable=true;
                    this.projectMetadata.reset();
                    await this.metadata();
                    console.warn('Document metadata refresh is unavailable; using debounced project metadata reads');
                }
            })().catch(error=>console.warn('Unable to refresh document metadata',error))
                .finally(()=>this.metadataRunning.delete(docId));
        });
    }

    async metadata() {
        return this.projectMetadata.get(async()=>{
            const identity=await GlobalStateManager.authenticate(this.context,this.serverName);
            const res=await this.api.getMetadata(identity,this.projectId);
            return res.type==='success'?res.meta?.projectMeta:undefined;
        });
    }

    async getUpdates(before?: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetUpdates(identity, this.projectId, before);
        if (res.type==='success') {
            return res.updates;
        } else {
            return undefined;
        }
    }

    async getFileDiff(pathname:string, from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileDiff(identity, this.projectId, pathname, from, to);
        if (res.type==='success') {
            return res.diff;
        } else {
            return undefined;
        }
    }

    async getFileTreeDiff(from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileTreeDiff(identity, this.projectId, from, to);
        if (res.type==='success') {
            return res.treeDiff;
        } else {
            return undefined;
        }
    }

    async getCurrentVersion() {
        const base = this.currentVersion ?? 0;
        let lb = base;
        let rb = base+2**4;
        // firstly try: a) no update `+1`, b) one update `+2`
        const res = await this.getFileTreeDiff(base+1, base+1);
        if (res===undefined) {
            this.currentVersion = base;
            return base;
        }
        const res2 = await this.getFileTreeDiff(base+2, base+2);
        if (res2===undefined) {
            this.currentVersion = base+1;
            return this.currentVersion;
        }
        // locate the actual upper bound
        do {
            const res = await this.getFileTreeDiff(rb, rb);
            if (res!==undefined) {
                rb = lb + (rb-lb)*2;
            } else {
                break;
            }
        } while (true);
        // binary search the current version
        while (lb<rb) {
            const mid = Math.floor((lb+rb)/2);
            const res = await this.getFileTreeDiff(mid, mid);
            if (res!==undefined) {
                lb = mid+1;
            } else {
                rb = mid;
            }
        }
        // update current version
        this.currentVersion = rb-1;
        return this.currentVersion;
    }

    async createLabel(comment: string, version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        if (res.type==='success') {
            return res.labels?.at(0);
        } else {
            return undefined;
        }
    }

    async deleteLabel(labelId: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.deleteLabel(identity, this.projectId, labelId);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }

    async downloadProjectArchive(version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.downloadZipOfVersion(identity, this.projectId, version);
        return res.content;
    }

    async getMessages() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMessages(identity, this.projectId);
        if (res.type==='success') {
            return res.messages;
        } else {
            return undefined;
        }
    }

    async sendMessage(publicId:string, content: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.sendMessage(identity, this.projectId, publicId, content);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }
}

function sameRemoteRevision(left:RemoteRevision,right:RemoteRevision):boolean {
    if (left.kind!==right.kind || left.contentHash!==right.contentHash) { return false; }
    return left.kind==='document' && right.kind==='document'
        ? left.documentVersion===right.documentVersion
        : left.kind==='file' && right.kind==='file' && left.entityId===right.entityId;
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private vfss: {[key:string]:VirtualFileSystem};

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
    }

    private cacheKey(uri:vscode.Uri):string {
        // A query can contain the same user/project identifiers on different
        // servers. Including the transport identity prevents cross-server VFS reuse.
        return `${uri.scheme}\0${uri.authority}\0${uri.query}`;
    }

    private getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        const key=this.cacheKey(uri);
        const vfs = this.vfss[key];
        if (vfs && !vfs.isDisposed) {
            return Promise.resolve(vfs);
        } else {
            let vfs: VirtualFileSystem;
            vfs = new VirtualFileSystem(this.context, uri, this.notify.bind(this), () => {
                if (this.vfss[key] === vfs) {
                    delete this.vfss[key];
                }
            });
            this.vfss[key] = vfs;
            return Promise.resolve(vfs);
        }
    }

    prefetch(uri: vscode.Uri): Promise<VirtualFileSystem> {
        return this.getVFS(uri).then((vfs) => {return vfs;});
    }

    notify(events :vscode.FileChangeEvent[]) {
        this._emitter.fire(events);
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.getVFS(uri).then( vfs => vfs.resolve(uri) );
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.getVFS(uri).then( vfs => vfs.list(uri) );
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.mkdir(uri) );
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.getVFS(uri).then( vfs => vfs.readEditorFile(uri) );
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Thenable<void> {
        return this.getVFS(uri).then(async vfs => { await vfs.writeFile(uri, content, options.create, options.overwrite); });
    }

    delete(uri: vscode.Uri, options: { recursive: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.remove(uri, options.recursive) );
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) {
        if (oldUri.authority !== newUri.authority) {
            vscode.window.showErrorMessage( vscode.l10n.t('Cannot rename across servers') );
            return;
        } else {
            return this.getVFS(oldUri).then( vfs => vfs.rename(oldUri, newUri, options.overwrite) );
        }
    }

    get triggers() {
        return [
            new vscode.Disposable(() => {
                Object.values(this.vfss).forEach((vfs) => vfs.dispose());
                this.vfss = {};
                this._emitter.dispose();
            }),
            // register file system provider
            vscode.workspace.registerFileSystemProvider(ROOT_NAME, this, { isCaseSensitive: true }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.retryConnection`,async(uri?:vscode.Uri)=>{
                const targets=uri?.scheme===ROOT_NAME?[await this.getVFS(uri)]:Object.values(this.vfss).filter(vfs=>!vfs.isDisposed&&!vfs.isConnectionReady);
                await Promise.all(targets.map(vfs=>vfs.retryInitialization()));
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.refreshLinkedFile`, (uri: vscode.Uri) => {
                return this.prefetch(uri).then((vfs) => vfs.refreshLinkedFile(uri));
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.createLinkedFile`, (uri?: vscode.Uri) => {
                uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
                if (uri) {
                    return this.prefetch(uri).then((vfs) => vfs.createLinkedFile(uri!));
                }                
            }),
            vscode.commands.registerCommand('remoteFileSystem.prefetch', (uri: vscode.Uri) => {
                return this.prefetch(uri);
            }),
        ];
    }
}
