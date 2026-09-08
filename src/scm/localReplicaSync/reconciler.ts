import { equalContent } from './hash';
import { mergeText } from './merge';
import { FileKind, ReconcileDecision, SyncMode } from './model';

export interface ReconcileInput {
    base?: Uint8Array;
    local?: Uint8Array;
    remote?: Uint8Array;
    kind: FileKind;
    mode: SyncMode;
    cause: 'bootstrap' | 'local' | 'remote' | 'manual';
}

export function reconcile(input:ReconcileInput):ReconcileDecision {
    const {base,local,remote,kind,mode,cause} = input;
    if (local===undefined && remote===undefined) { return {action:'none'}; }

    if (base===undefined) {
        if (local!==undefined && remote!==undefined) {
            return equalContent(local,remote)
                ? {action:'establish-base'}
                : {action:'conflict', reason:'No common base exists and both sides contain different data'};
        }
        if (local!==undefined) {
            return mode==='safeAuto' && cause==='manual'
                ? {action:'upload'}
                : {action:'pending-upload', reason:'Local-only file requires confirmation'};
        }
        return mode==='manual' ? {action:'pending-download'} : {action:'download'};
    }

    const localEqualsBase = equalContent(local,base);
    const remoteEqualsBase = equalContent(remote,base);
    if (equalContent(local,remote)) { return {action:'establish-base'}; }
    if (local===undefined) {
        return remoteEqualsBase
            ? (mode==='manual'?{action:'pending-upload',reason:'Local deletion pending'}:{action:'delete-remote'})
            : {action:'conflict',reason:'Local was deleted while Overleaf was modified'};
    }
    if (remote===undefined) {
        return localEqualsBase
            ? (mode==='manual'?{action:'pending-download',reason:'Remote deletion pending'}:{action:'delete-local'})
            : {action:'conflict',reason:'Overleaf was deleted while local was modified'};
    }
    if (localEqualsBase) { return mode==='manual'?{action:'pending-download'}:{action:'download'}; }
    if (remoteEqualsBase) {
        return mode==='manual' || (kind==='binary' && cause!=='manual')
            ? {action:'pending-upload',reason:kind==='binary'?'Binary uploads require explicit confirmation':undefined}
            : {action:'upload'};
    }
    if (kind==='binary') { return {action:'conflict',reason:'Binary file changed on both sides'}; }
    const merge = mergeText(base,local,remote);
    return merge.kind==='conflict'
        ? {action:'conflict',hunks:merge.hunks,reason:merge.reason}
        : mode==='manual'
            ? {action:'conflict',merged:merge.merged,reason:'Both sides changed; review the clean merge before applying'}
            : {action:'merge',merged:merge.merged};
}
