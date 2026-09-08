/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { emitWithAckSafe, SocketOutcomeUnknownError } from './socketSafety';
export { SocketOutcomeUnknownError } from './socketSafety';

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    dupIfSource?: string[],
    hash?: string, //(not needed if lastV is provided)
    meta?: {
        source: string, //socketio client id
        ts: number, //unix timestamp
        user_id: string,
    }
}

export interface EventsHandler {
    onOtError?: (docId:string)=>void,
    onDocMetadata?: (data:import('../core/projectMetadataCache').DocMeta) => void,
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
}

type ConnectionScheme = 'v1' | 'v2';
export type SocketConnectionState = 'disconnected' | 'connecting' | 'transport-ready' | 'joining-project' | 'ready' | 'backoff' | 'disposed';

export class SocketIOAPI {
    private forcedDisconnect=false;
    private forcedDisconnectTimer?:ReturnType<typeof setTimeout>;
    get isForcedDisconnected():boolean { return this.forcedDisconnect; }
    allowManualReconnect():void {
        this.forcedDisconnect=false;
        if (this.forcedDisconnectTimer) { clearTimeout(this.forcedDisconnectTimer); this.forcedDisconnectTimer=undefined; }
    }
    private scheme: ConnectionScheme = 'v2';
    private record?: Promise<ProjectEntity>;
    private rejectRecord?: (reason:any)=>void;
    private _handlers: Array<EventsHandler> = [];
    private _publicId?:string;

    private socket?: any;
    private emit: any;
    /** Track the scheme used when the socket was last initialized */
    private _socketInitScheme?: ConnectionScheme;
    private _disposed = false;
    private _epoch = 0;
    private _state:SocketConnectionState='disconnected';
    private epochAbort=new AbortController();

    constructor(private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        if (this.forcedDisconnect) { throw new Error('Server forced disconnection; manual reconnect required'); }
        if (this._disposed) {
            throw new Error('Cannot initialize a disposed SocketIOAPI');
        }

        this.epochAbort.abort(); this.epochAbort=new AbortController();
        this._epoch+=1;
        this._state='connecting';
        this._publicId=undefined;
        this.rejectRecord=undefined;
        // CRITICAL: Properly disconnect old socket before creating a new one.
        // Without this, the old TCP connection is abandoned but still alive. When the
        // server later sends data on it (out-of-order/late packets), the OS TCP stack
        // responds with RST, which can cause the server to drop ALL connections from
        // this client — explaining the "connection lost" loop reported in issue #309.
        this.destroyCurrentSocket();

        // connect
        switch(this.scheme) {
            case 'v1':
                this.record = undefined;
                this.socket = this.api._initSocketV0(this.identity);
                break;
            case 'v2':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        // create emit
        const socket=this.socket,epoch=this._epoch;
        this.emit=(event:string,...args:any[])=>this.emitWithAck(socket,epoch,event,args);
        // resume handlers
        this.initInternalHandlers();
        // Re-register existing event handlers on the new socket
        this.resumeEventHandlers(this._handlers);
        // Track which scheme this socket was created with
        this._socketInitScheme = this.scheme;
    }

    /** Returns true if the socket needs re-initialization (scheme changed, or socket was never init'd) */
    get needsReinit(): boolean {
        return this._socketInitScheme !== this.scheme || !this.socket || this._state==='disconnected' || this._state==='backoff';
    }

    get connectionEpoch():number { return this._epoch; }
    get connectionState():SocketConnectionState { return this._state; }
    get isReady():boolean { return this._state==='ready'; }

    private emitWithAck(socket:any,epoch:number,event:string,args:any[],timeoutMs=10000):Promise<any[]> {
        return emitWithAckSafe(socket,event,args,()=>epoch===this._epoch && socket===this.socket,timeoutMs,this.epochAbort.signal);
    }

    private initInternalHandlers() {
        const socket=this.socket,epoch=this._epoch;
        const current=()=>epoch===this._epoch && socket===this.socket && !this._disposed;
        socket.on('connect', () => {
            if (!current()) { return; }
            this._state='transport-ready';
            console.log('SocketIOAPI: connected');
        });
        socket.on('connect_failed', () => {
            if (!current()) { return; }
            this._state='backoff';
            console.log('SocketIOAPI: connect_failed');
        });
        socket.on('forceDisconnect', (message:string, delay=10) => {
            if (!current()) { return; }
            this.forcedDisconnect=true;
            this._state='backoff';
            console.log('SocketIOAPI: forceDisconnect', message);
            if (this.forcedDisconnectTimer) { clearTimeout(this.forcedDisconnectTimer); }
            this.forcedDisconnectTimer=setTimeout(()=>{
                this.forcedDisconnectTimer=undefined;
                if (!current()) { return; }
                this.pause();
                for (const handlers of this._handlers) { handlers.onDisconnected?.(); }
            },Math.max(0,Number.isFinite(delay)?delay:10)*1000);
        });
        socket.on('disconnect',()=>{
            if (current()) { this._state='disconnected'; }
        });
        socket.on('connectionRejected', (err:any) => {
            if (!current()) { return; }
            console.log('SocketIOAPI: connectionRejected.', err?.message || err);
            // If v2 also gets rejected, fall back to v1 rather than staying stuck
            if (this.scheme === 'v2' && /unsupported|unexpected.*projectid|unknown.*projectid/i.test(err?.message??'')) {
                console.log('SocketIOAPI: v2 rejected, falling back to v1');
                this.scheme = 'v1';
            }
            this.rejectRecord?.(err);
            // Disable auto-reconnect on this socket: the server explicitly rejected
            // our connection parameters. Reconnecting would just get rejected again,
            // creating unnecessary TCP connection churn (and RST packets).
            if (this.socket.io && typeof this.socket.io.reconnect === 'function') {
                this.socket.io.reconnect(false);
            }
        });
        socket.on('error', (err:any) => {
            if (!current()) { return; }
            // Log error instead of throwing to avoid crashing the extension
            console.error('SocketIOAPI: socket error', err?.message || err);
        });

        socket.on('connectionAccepted', (_:any,publicId:any) => {
            if (current() && typeof publicId==='string') { this._publicId=publicId; }
        });

        if (this.scheme==='v2') {
            this.record = new Promise((resolve,reject) => {
                let settled=false;
                const finish=(error?:any,res?:any)=>{
                    if (settled) { return; } settled=true;
                    socket.removeListener('joinProjectResponse',onResponse);
                    this.epochAbort.signal.removeEventListener('abort',onAbort);
                    if (!current()) { reject(new SocketOutcomeUnknownError('joinProjectResponse arrived on a stale connection')); return; }
                    if (error) { reject(error); return; }
                    if (!res?.project || typeof res.publicId!=='string') { reject(new Error('Invalid joinProjectResponse')); return; }
                    this._publicId=res.publicId; resolve(res.project as ProjectEntity);
                };
                const onResponse=(res:any)=>finish(undefined,res);
                const onAbort=()=>finish(new SocketOutcomeUnknownError('joinProject was cancelled with its connection'));
                this.rejectRecord=error=>finish(error);
                socket.once('joinProjectResponse',onResponse);
                this.epochAbort.signal.addEventListener('abort',onAbort,{once:true});
            });
        }
    }

    disconnect() {
        this._state='disconnected';
        this.socket?.disconnect();
    }

    /** Stop transports and timers between initialization attempts, retaining handlers for explicit retry. */
    pause():void {
        if (this._disposed) { return; }
        void this.record?.catch(()=>undefined);
        this.epochAbort.abort(); this._epoch+=1; this._state='backoff';
        this.destroyCurrentSocket(); this.emit=undefined; this.rejectRecord=undefined;
        this.record=undefined;
        this._socketInitScheme=undefined;
    }

    /** Permanently stop this API instance and all of socket.io 0.9's retry work. */
    dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        if (this.forcedDisconnectTimer) { clearTimeout(this.forcedDisconnectTimer); }
        this.epochAbort.abort();
        this._state='disposed';
        this._handlers = [];
        this.destroyCurrentSocket();
        this.emit = undefined;
        this.record = undefined;
        this.rejectRecord=undefined;
        this._socketInitScheme = undefined;
    }

    private destroyCurrentSocket() {
        const namespace = this.socket;
        if (!namespace) {
            return;
        }

        try {
            // socket.io-client 0.9 keeps reconnect state on namespace.socket.
            // Merely disconnecting the namespace can leave its reconnect timer alive.
            const manager = namespace.socket;
            if (manager) {
                manager.options.reconnect = false;
                manager.reconnecting = false;
                if (manager.reconnectionTimer) {
                    clearTimeout(manager.reconnectionTimer);
                    delete manager.reconnectionTimer;
                }
                if (typeof manager.removeAllListeners === 'function') {
                    manager.removeAllListeners();
                }
            }
            if (typeof namespace.removeAllListeners === 'function') {
                namespace.removeAllListeners();
            }
            if (typeof namespace.disconnect === 'function') {
                namespace.disconnect();
            }
        } catch {
            // Best-effort cleanup; the transport may already be closed.
        } finally {
            this.socket = undefined;
        }
    }

    get handlers() {
        return this._handlers;
    }

    private waitUntilConnected(timeoutMs=10000): Promise<void> {
        if (this.socket?.socket?.connected) {
            return Promise.resolve();
        }

        const socket = this.socket;
        const signal=this.epochAbort.signal;
        if (!socket) {
            return Promise.reject(new Error('Socket.IO connection is not initialized'));
        }

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                socket.removeListener('connect', onConnect);
                signal.removeEventListener('abort',onAbort);
            };
            const onConnect = () => {
                cleanup();
                resolve();
            };
            const onAbort=()=>{ cleanup(); reject(new SocketOutcomeUnknownError('Connection wait was cancelled')); };
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Socket.IO connection timed out before joining the project'));
            }, timeoutMs);
            socket.on('connect', onConnect);
            signal.addEventListener('abort',onAbort,{once:true});
            if (signal.aborted) { onAbort(); return; }

            // Avoid missing a connect event between the initial check and listener setup.
            if (socket.socket?.connected) {
                onConnect();
            }
        });
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler):()=>void {
        this._handlers.push(handlers);
        const socket=this.socket,epoch=this._epoch;
        const guard=(callback:(...args:any[])=>void)=>(...args:any[])=>{
            if (!this._disposed && epoch===this._epoch && socket===this.socket && this._handlers.includes(handlers)) { callback(...args); }
        };
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', guard((parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    }));
                    this.socket.on('reciveNewFile', guard((parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    }));
                    this.socket.on('reciveNewFolder', guard((parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    }));
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', guard((entityId:string, newName:string) => {
                        handler(entityId, newName);
                    }));
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', guard((entityId:string) => {
                        handler(entityId);
                    }));
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', guard((entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    }));
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', guard((update: UpdateSchema) => {
                        handler(update);
                    }));
                    break;
                case handlers.onDocMetadata:
                    this.socket.on('broadcastDocMeta', guard(data => handler(data)));
                    break;
                case handlers.onOtError:
                    this.socket.on('otUpdateError', guard((_error:unknown,message:{doc_id?:string})=>{
                        if (typeof message?.doc_id==='string') { handler(message.doc_id); }
                    }));
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', guard(() => {
                        handler();
                    }));
                    break;
                case handlers.onConnectionAccepted:
                    // Fired explicitly after joinProject and project refresh complete.
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', guard((user:UpdateUserSchema) => {
                        handler(user);
                    }));
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', guard((id:string) => {
                        handler(id);
                    }));
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', guard((message:ProjectMessageResponseSchema) => {
                        handler(message);
                    }));
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', guard((language:string) => {
                        handler(language);
                    }));
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', guard((compiler:string) => {
                        handler(compiler);
                    }));
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', guard((rootDocId:string) => {
                        handler(rootDocId);
                    }));
                    break;
                default:
                    break;
            }
        });
        return ()=>{ this._handlers=this._handlers.filter(value=>value!==handlers); };
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        await this.waitUntilConnected();
        this._state='joining-project';
        const socket=this.socket,epoch=this._epoch;

        try {
            let project:ProjectEntity;
            if (this.scheme==='v1') {
                project=await new Promise<ProjectEntity>((resolve,reject)=>{
                    const onRejected=(err:any)=>finish(err);
                    const timer=setTimeout(()=>finish(new Error('joinProject timed out')),10000);
                    const finish=(error?:any,value?:ProjectEntity)=>{
                        clearTimeout(timer); socket.removeListener('connectionRejected',onRejected);
                        if (error) { reject(error); } else { resolve(value!); }
                    };
                    socket.once('connectionRejected',onRejected);
                    this.emit('joinProject',{project_id}).then((values:any[])=>finish(undefined,values[0]),finish);
                });
            } else {
                project=await withTimeout(this.record!,10000,'joinProject response timed out');
            }
            if (epoch!==this._epoch || socket!==this.socket) { throw new SocketOutcomeUnknownError('Project joined on a stale connection'); }
            this.record=Promise.resolve(project);
            return project;
        } catch (error) {
            // dispose may run while joinProject is awaiting network I/O.
            if ((this._state as SocketConnectionState)!=='disposed') { this._state='backoff'; }
            throw error;
        }
    }

    completeProjectRefresh():void {
        if (this._disposed || this._state!=='joining-project') { return; }
        this._state='ready';
        if (this._publicId) { for (const handler of this._handlers) { handler.onConnectionAccepted?.(this._publicId); } }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(docId:string,fromVersion?:number) {
        return (fromVersion===undefined
            ? this.emit('joinDoc', docId, { encodeRanges: true })
            : this.emit('joinDoc', docId, fromVersion, { encodeRanges: true }))
            .then((returns: [Array<string>, number, Array<any>, any, string?]) => {
                const [docLinesAscii, version, updates, ranges, type] = returns;
                if (type && type!=='sharejs-text-ot') { throw new Error(`Unsupported Overleaf OT type: ${type}`); }
                if (!Array.isArray(docLinesAscii) || !docLinesAscii.every(line=>typeof line==='string')
                    || !Number.isSafeInteger(version) || version<0 || !Array.isArray(updates)) {
                    throw new Error('Invalid joinDoc response');
                }
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates:updates.map((update,index)=>({...update,doc:docId,v:update.v??((fromVersion??version)+index)})), ranges};
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        return this.emit('applyOtUpdate', docId, update)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        return this.emit('clientTracking.updatePosition', {row, column, doc_id})
            .then(() => {
                return;
            });
    }
}

function withTimeout<T>(promise:Promise<T>,timeoutMs:number,message:string):Promise<T> {
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(message)),timeoutMs);
        promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
    });
}
