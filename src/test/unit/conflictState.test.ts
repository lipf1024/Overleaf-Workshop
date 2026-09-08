import * as assert from 'assert';
import { ConflictNotificationTracker, hasUnresolvedConflict } from '../../scm/localReplicaSync/conflictState';
import { FileSyncRecord } from '../../scm/localReplicaSync/model';

const conflict=(path='main.tex',id='conflict-1'):FileSyncRecord=>({
    key:path,path,kind:'text',observed:{},status:'conflict',pendingConflictId:id,
});

suite('Conflict notifications and persistent visibility',()=>{
    test('notifies about startup conflicts once initialization finishes',()=>{
        const tracker=new ConflictNotificationTracker();
        const records=[conflict(),conflict('chapter.tex','conflict-2')];
        assert.deepStrictEqual(tracker.takeNew(records,false),[]);
        assert.deepStrictEqual(tracker.takeNew(records,false),[]);
        assert.deepStrictEqual(tracker.takeNew(records,true),records);
        assert.deepStrictEqual(tracker.takeNew(records,true),[]);
    });

    test('restored conflicts notify again in a new window, but repeated scans do not',()=>{
        const records=[conflict()];
        assert.strictEqual(new ConflictNotificationTracker().takeNew(records,true).length,1);
        const restarted=new ConflictNotificationTracker();
        assert.strictEqual(restarted.takeNew(records,true).length,1);
        assert.strictEqual(restarted.takeNew(records,true).length,0);
    });

    test('keeps a conflict visible through an I/O error or unverified merge upload',()=>{
        const record=conflict();
        const tracker=new ConflictNotificationTracker();
        tracker.takeNew([record],true);
        for (const status of ['error','pending-upload','pending-download'] as const) {
            record.status=status;
            assert.strictEqual(hasUnresolvedConflict(record),true);
            assert.deepStrictEqual(tracker.takeNew([record],true),[]);
        }
        record.status='clean'; record.pendingConflictId=undefined;
        assert.strictEqual(hasUnresolvedConflict(record),false);
        tracker.takeNew([record],true);
        assert.strictEqual(tracker.takeNew([conflict()],true).length,1);
    });

    test('also reports frozen paths that do not have an editable merge',()=>{
        const record=conflict(); record.pendingConflictId=undefined;
        assert.strictEqual(new ConflictNotificationTracker().takeNew([record],true).length,1);
    });
});
