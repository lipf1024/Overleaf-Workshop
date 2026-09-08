export type SyncMode = 'safeAuto' | 'manual';
export type FileKind = 'text' | 'binary';

export type FileSyncStatus =
    | 'clean'
    | 'local-changed'
    | 'remote-changed'
    | 'pending-upload'
    | 'pending-download'
    | 'syncing'
    | 'conflict'
    | 'error';

export type RemoteRevision =
    | {kind:'document'; documentVersion:number; contentHash:string}
    | {kind:'file'; entityId:string; contentHash:string};

export interface StoredBase {
    objectId: string;
    hash: string;
    remoteRevision: RemoteRevision;
}

export interface FileSyncRecord {
    key: string;
    entityId?: string;
    path: string;
    kind: FileKind;
    base?: StoredBase;
    observed: {localHash?:string; remoteHash?:string};
    status: FileSyncStatus;
    pendingConflictId?: string;
    message?: string;
    suspension?: 'ignored' | 'blocked' | 'dirty-buffer';
}

export interface SyncStateV1 {
    schemaVersion: 1;
    project: {projectId:string; serverIdentityHash:string};
    generation: number;
    files: Record<string, FileSyncRecord>;
}

export interface RemoteSnapshot {
    path: string;
    entityId: string;
    kind: FileKind;
    content: Uint8Array;
    hash: string;
    revision: RemoteRevision;
    connectionEpoch?: number;
}

export type RemoteReadResult =
    | {type:'found';snapshot:RemoteSnapshot}
    | {type:'missing'}
    | {type:'offline'|'auth-required'|'transient-error'|'fatal-error';message:string};

export interface MergeEdit {
    start: number;
    end: number;
    replacement: string[];
}

export interface MergeHunk {
    start: number;
    end: number;
    base: string;
    local: string;
    remote: string;
    localStart?: number;
    localEnd?: number;
}

export interface MergeResult {
    kind: 'unchanged' | 'clean-merge' | 'conflict';
    merged?: Uint8Array;
    hunks: MergeHunk[];
    reason?: string;
}

export type ReconcileAction =
    | 'none'
    | 'establish-base'
    | 'upload'
    | 'download'
    | 'delete-local'
    | 'delete-remote'
    | 'merge'
    | 'pending-upload'
    | 'pending-download'
    | 'conflict';

export interface ReconcileDecision {
    action: ReconcileAction;
    merged?: Uint8Array;
    hunks?: MergeHunk[];
    reason?: string;
}

export interface ConflictRecord {
    id: string;
    path: string;
    kind: FileKind;
    reason: string;
    baseObjectId?: string;
    localObjectId?: string;
    remoteObjectId?: string;
    draftObjectId?: string;
    localHash?: string;
    remoteHash?: string;
    remoteRevision?: RemoteRevision;
    hunks: MergeHunk[];
    resolvedHunks?: number[];
    hunkChoices?: Record<string,'local'|'remote'|'both'>;
    createdAt: number;
    updatedAt?: number;
}

export interface JournalEntry {
    id: string;
    operationId?: string;
    path: string;
    phase: 'prepared' | 'local-applied' | 'remote-staged' | 'remote-applied' | 'unknown';
    operation: 'download' | 'upload' | 'merge' | 'delete-local' | 'delete-remote' | 'move-local' | 'move-remote';
    sourcePath?: string;
    targetHash?: string;
    backupObjectId?: string;
    remoteBeforeObjectId?: string;
    expectedRevision?: RemoteRevision;
    connectionEpoch?: number;
    temporaryPath?: string;
    temporaryEntityId?: string;
    originalEntityId?: string;
    localStage?: 'prepared' | 'captured' | 'installed';
    localStagingPath?: string;
    localRecoveryPath?: string;
    localExpectedHash?: string;
    localExpectedExists?: boolean;
    recoveryRequired?: boolean;
    createdAt: number;
}

export interface ApplyResult {
    type: 'verified' | 'conflict' | 'unknown' | 'failed';
    snapshot?: RemoteSnapshot;
    message?: string;
    temporaryPath?: string;
    temporaryEntityId?: string;
    connectionEpoch?: number;
}
