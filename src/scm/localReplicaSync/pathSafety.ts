export interface PathIssue {path:string;message:string}

/** Metadata and temporary files owned by the synchronizer are never user content. */
export function isInternalReplicaPath(value:string):boolean {
    const normalized=value.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
    if (!normalized) { return false; }
    const parts=normalized.split('/').map(part=>part.normalize('NFC').toLocaleLowerCase('en-US'));
    return parts[0]==='.overleaf' || parts.some(part=>part.startsWith('.overleaf-sync-'));
}

export function pathComparisonKey(value:string,caseInsensitive=process.platform==='darwin'||process.platform==='win32'):string {
    const normalized=value.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'').normalize('NFC');
    return caseInsensitive?normalized.toLocaleLowerCase('en-US'):normalized;
}

export function validateReplicaPath(value:string):string|undefined {
    const path=value.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
    const parts=path.split('/');
    if (!path || parts.some(part=>!part || part==='.' || part==='..' || /[\0-\x1f]/.test(part))) { return 'Illegal or traversing path'; }
    if (parts[0].normalize('NFC').toLocaleLowerCase('en-US')==='.overleaf') { return 'The .overleaf metadata directory is reserved'; }
    if (parts.some(part=>part.normalize('NFC').toLocaleLowerCase('en-US').startsWith('.overleaf-sync-'))) { return 'The local replica temporary-file namespace is reserved'; }
    if (process.platform==='win32' && parts.some(part=>/[<>:"|?*]/.test(part) || /[. ]$/.test(part))) { return 'Path cannot be represented safely on Windows'; }
    return undefined;
}

export function findPathCollisions(paths:string[],caseInsensitive=process.platform==='darwin'||process.platform==='win32'):PathIssue[] {
    const seen=new Map<string,string>(); const issues:PathIssue[]=[];
    for (const path of paths) {
        const key=pathComparisonKey(path,caseInsensitive); const previous=seen.get(key);
        if (previous!==undefined && previous!==path) {
            const message=`Path collides after ${caseInsensitive?'case/':''}Unicode normalization: ${previous} and ${path}`;
            issues.push({path:previous,message},{path,message});
        } else { seen.set(key,path); }
    }
    return issues;
}

/** Collapse a watcher delete burst so a removed directory owns all child events. */
export function coalesceTreePaths(values:string[]):string[] {
    const unique=new Map<string,string>();
    for (const value of values) {
        const normalized=value.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
        if (normalized) { unique.set(pathComparisonKey(normalized),normalized); }
    }
    const ordered=[...unique.values()].sort((left,right)=>left.split('/').length-right.split('/').length || left.length-right.length);
    const result:string[]=[];
    for (const value of ordered) {
        const key=pathComparisonKey(value);
        if (!result.some(parent=>key.startsWith(`${pathComparisonKey(parent)}/`))) { result.push(value); }
    }
    return result;
}
