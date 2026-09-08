import { ConflictRecord, FileSyncRecord } from './model';
import { createHash } from 'crypto';

export function hasUnresolvedConflict(record:FileSyncRecord):boolean {
    return record.status==='conflict' || Boolean(record.pendingConflictId);
}

/** Draft saves do not change the versions the user is reviewing. */
export function conflictSnapshotKey(conflict:ConflictRecord):string {
    return createHash('sha256').update(JSON.stringify([
        conflict.path, conflict.kind, conflict.baseObjectId, conflict.localObjectId,
        conflict.remoteObjectId, conflict.remoteRevision,
    ])).digest('hex');
}

/** Initialization can update decorations without consuming the first notification. */
export class ConflictNotificationTracker {
    private readonly notified=new Set<string>();

    takeNew(records:FileSyncRecord[],ready:boolean):FileSyncRecord[] {
        const conflicts=records.filter(hasUnresolvedConflict);
        const key=(record:FileSyncRecord)=>record.pendingConflictId??record.path;
        const current=new Set(conflicts.map(key));
        for (const id of this.notified) {
            if (!current.has(id)) { this.notified.delete(id); }
        }
        if (!ready) { return []; }
        return conflicts.filter(record=>{
            const id=key(record);
            if (this.notified.has(id)) { return false; }
            this.notified.add(id);
            return true;
        });
    }
}
