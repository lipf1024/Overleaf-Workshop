import * as DiffMatchPatch from 'diff-match-patch';
import { MergeEdit, MergeHunk, MergeResult } from './model';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_LINES = 100000;
const MAX_TOKENS = 65000;
const MAX_MERGE_MS = 2000;

function splitLines(value:string): string[] {
    return value.match(/.*?(?:\r\n|\n|\r|$)/g)?.filter(line => line.length>0) ?? [];
}

function encodeLines(a:string[], b:string[]): {a:string; b:string; values:string[]} | undefined {
    const ids = new Map<string,number>();
    const values = [''];
    const encode = (lines:string[]) => {
        let encoded = '';
        for (const line of lines) {
            let id = ids.get(line);
            if (id===undefined) {
                id = values.length;
                if (id>MAX_TOKENS) { return undefined; }
                ids.set(line, id);
                values.push(line);
            }
            encoded += String.fromCharCode(id);
        }
        return encoded;
    };
    const ea = encode(a);
    const eb = encode(b);
    return ea===undefined || eb===undefined ? undefined : {a:ea, b:eb, values};
}

function calculateEdits(base:string[], side:string[], deadline:number): MergeEdit[] | undefined {
    const encoded = encodeLines(base, side);
    if (!encoded) { return undefined; }
    const dmp = new DiffMatchPatch();
    (dmp as any).Diff_Timeout = Math.max(0.001, (deadline-Date.now())/1000);
    const diffs = dmp.diff_main(encoded.a, encoded.b, false) as Array<[number,string]>;
    if (Date.now()>deadline) { return undefined; }

    const edits:MergeEdit[] = [];
    let basePos = 0;
    let current:MergeEdit | undefined;
    const flush = () => {
        if (current) { edits.push(current); current = undefined; }
    };
    for (const [operation, text] of diffs) {
        const lines = [...text].map(char => encoded.values[char.charCodeAt(0)]);
        if (operation===0) {
            flush();
            basePos += lines.length;
        } else {
            current ??= {start:basePos, end:basePos, replacement:[]};
            if (operation<0) {
                current.end += lines.length;
                basePos += lines.length;
            } else {
                current.replacement.push(...lines);
            }
        }
    }
    flush();
    return edits;
}

function overlaps(a:MergeEdit, b:MergeEdit): boolean {
    if (a.start===a.end && b.start===b.end) { return a.start===b.start; }
    if (a.start===a.end) { return a.start>b.start && a.start<b.end; }
    if (b.start===b.end) { return b.start>a.start && b.start<a.end; }
    return a.start<b.end && b.start<a.end;
}

function applyEdits(base:string[], start:number, end:number, edits:MergeEdit[]): string[] {
    const result:string[] = [];
    let cursor = start;
    for (const edit of edits.filter(e => e.start>=start && e.end<=end).sort((a,b) => a.start-b.start)) {
        result.push(...base.slice(cursor, edit.start), ...edit.replacement);
        cursor = edit.end;
    }
    result.push(...base.slice(cursor, end));
    return result;
}

function sameLines(a:string[], b:string[]): boolean {
    return a.length===b.length && a.every((line,index) => line===b[index]);
}

function sideBoundary(position:number,edits:MergeEdit[],after:boolean):number {
    let baseCursor=0,sideCursor=0;
    for (const edit of edits.sort((a,b)=>a.start-b.start||a.end-b.end)) {
        if (edit.start>position || (edit.start===position && !after)) { break; }
        sideCursor+=edit.start-baseCursor;
        if (position<edit.end) { return after?sideCursor+edit.replacement.length:sideCursor; }
        sideCursor+=edit.replacement.length; baseCursor=edit.end;
    }
    return sideCursor+(position-baseCursor);
}

function characterOffset(lines:string[],line:number):number { let result=0; for (let index=0;index<line;index++) { result+=lines[index]?.length??0; } return result; }

export function mergeText(baseBytes:Uint8Array, localBytes:Uint8Array, remoteBytes:Uint8Array):MergeResult {
    if (baseBytes.byteLength>MAX_BYTES || localBytes.byteLength>MAX_BYTES || remoteBytes.byteLength>MAX_BYTES) {
        return {kind:'conflict', hunks:[], reason:'File exceeds the 5 MiB automatic merge limit'};
    }
    const decoder = new TextDecoder('utf-8', {fatal:true});
    let baseText:string, localText:string, remoteText:string;
    try {
        baseText = decoder.decode(baseBytes);
        localText = new TextDecoder('utf-8', {fatal:true}).decode(localBytes);
        remoteText = new TextDecoder('utf-8', {fatal:true}).decode(remoteBytes);
    } catch {
        return {kind:'conflict', hunks:[], reason:'Content is not valid UTF-8 text'};
    }
    if (localText===remoteText) {
        return {kind:localText===baseText?'unchanged':'clean-merge', merged:localBytes, hunks:[]};
    }
    const base = splitLines(baseText);
    const local = splitLines(localText);
    const remote = splitLines(remoteText);
    if (base.length>MAX_LINES || local.length>MAX_LINES || remote.length>MAX_LINES) {
        return {kind:'conflict', hunks:[], reason:'File exceeds the 100,000 line automatic merge limit'};
    }
    const deadline = Date.now()+MAX_MERGE_MS;
    const localEdits = calculateEdits(base, local, deadline);
    const remoteEdits = calculateEdits(base, remote, deadline);
    if (!localEdits || !remoteEdits || Date.now()>deadline) {
        return {kind:'conflict', hunks:[], reason:'Automatic merge exceeded its safety budget'};
    }

    const conflictRanges:Array<{start:number;end:number}> = [];
    for (const le of localEdits) {
        for (const re of remoteEdits) {
            if (!overlaps(le,re)) { continue; }
            const start = Math.min(le.start,re.start);
            const end = Math.max(le.end,re.end);
            const localResult = applyEdits(base,start,end,localEdits);
            const remoteResult = applyEdits(base,start,end,remoteEdits);
            if (!sameLines(localResult,remoteResult)) {
                conflictRanges.push({start,end});
            }
        }
    }
    if (conflictRanges.length) {
        const mergedRanges:Array<{start:number;end:number}>=[];
        for (const range of conflictRanges.sort((a,b)=>a.start-b.start||a.end-b.end)) {
            const previous=mergedRanges.at(-1);
            if (previous && range.start<=previous.end) { previous.end=Math.max(previous.end,range.end); }
            else { mergedRanges.push({...range}); }
        }
        const hunks=mergedRanges.map(({start,end})=>({start,end,base:base.slice(start,end).join(''),
            local:applyEdits(base,start,end,localEdits).join(''),remote:applyEdits(base,start,end,remoteEdits).join(''),
            localStart:characterOffset(local,sideBoundary(start,localEdits,false)),localEnd:characterOffset(local,sideBoundary(end,localEdits,true))}));
        return {kind:'conflict', hunks, reason:'Local and Overleaf changed the same lines'};
    }

    const edits = [...localEdits, ...remoteEdits]
        .sort((a,b) => a.start-b.start || a.end-b.end)
        .filter((edit,index,all) => index===0 || !(
            edit.start===all[index-1].start && edit.end===all[index-1].end
            && sameLines(edit.replacement,all[index-1].replacement)
        ));
    const merged = applyEdits(base,0,base.length,edits).join('');
    return {kind:merged===baseText?'unchanged':'clean-merge', merged:new TextEncoder().encode(merged), hunks:[]};
}
