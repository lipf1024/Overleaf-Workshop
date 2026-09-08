import * as assert from 'assert';
import { mergeText } from '../../scm/localReplicaSync/merge';

const bytes=(value:string)=>new TextEncoder().encode(value);
const text=(value?:Uint8Array)=>value && new TextDecoder().decode(value);

suite('Local replica three-way merge',()=>{
    test('merges non-overlapping line edits',()=>{
        const result=mergeText(bytes('a\nb\nc\n'),bytes('A\nb\nc\n'),bytes('a\nb\nC\n'));
        assert.strictEqual(result.kind,'clean-merge'); assert.strictEqual(text(result.merged),'A\nb\nC\n');
    });
    test('reports edits to the same line',()=>{
        const result=mergeText(bytes('a\nb\n'),bytes('A\nb\n'),bytes('R\nb\n'));
        assert.strictEqual(result.kind,'conflict'); assert.ok(result.hunks.length>0);
    });
    test('deduplicates identical insertion',()=>{
        const result=mergeText(bytes('a\n'),bytes('x\na\n'),bytes('x\na\n'));
        assert.strictEqual(text(result.merged),'x\na\n');
    });
    test('preserves CRLF and missing terminal newline',()=>{
        const result=mergeText(bytes('a\r\nb'),bytes('A\r\nb'),bytes('a\r\nB'));
        assert.strictEqual(text(result.merged),'A\r\nB');
    });
    test('handles Unicode',()=>{
        const result=mergeText(bytes('甲\n乙\n'),bytes('甲一\n乙\n'),bytes('甲\n乙二\n'));
        assert.strictEqual(text(result.merged),'甲一\n乙二\n');
    });
    test('keeps adjacent line edits independent',()=>{
        const result=mergeText(bytes('a\nb\nc\n'),bytes('A\nb\nc\n'),bytes('a\nB\nc\n'));
        assert.strictEqual(result.kind,'clean-merge'); assert.strictEqual(text(result.merged),'A\nB\nc\n');
    });
    test('conflicts on different insertions at the same point',()=>{
        const result=mergeText(bytes('a\n'),bytes('L\na\n'),bytes('R\na\n'));
        assert.strictEqual(result.kind,'conflict');
    });
    test('handles empty files',()=>{
        const result=mergeText(bytes(''),bytes('local\n'),bytes(''));
        assert.strictEqual(result.kind,'clean-merge'); assert.strictEqual(text(result.merged),'local\n');
    });
    test('refuses text larger than safety limit',()=>{
        const huge=bytes('x'.repeat(5*1024*1024+1));
        assert.strictEqual(mergeText(huge,huge,huge).kind,'conflict');
    });
    test('provides exact local offsets for conflict hunk actions',()=>{
        const local='b\nc\n';
        const result=mergeText(bytes('a\nb\nc\n'),bytes(local),bytes('REMOTE\nb\nc\n'));
        assert.strictEqual(result.kind,'conflict');
        for (const hunk of result.hunks) { assert.strictEqual(local.slice(hunk.localStart,hunk.localEnd),hunk.local); }
    });
});
