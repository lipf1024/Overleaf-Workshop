import * as fs from 'fs/promises';
import { constants, Dirent, Stats } from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { isInternalReplicaPath, pathComparisonKey, PathIssue, validateReplicaPath } from './pathSafety';

export type PathDecision = {type:'allowed'} | {type:'ignored'|'blocked';message:string};
interface DirectoryIdentity {path:string;dev:number;ino:number}
export interface CheckedPath {path:string;parents:DirectoryIdentity[]}

/** All local I/O, including metadata, goes through the same boundary checks. */
export class LocalPathAccess {
    private identity?:DirectoryIdentity;
    private canonical?:string;
    private readonly metadataDirectories=new Map<string,DirectoryIdentity>();
    constructor(readonly root:string) {}

    async initialize():Promise<void> {
        if (this.canonical) { return; }
        const canonical=await fs.realpath(this.root),stat=await fs.lstat(canonical);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('The replica root must be a real directory'); }
        this.canonical=canonical; this.identity={path:canonical,dev:stat.dev,ino:stat.ino};
    }

    relative(absolute:string):string { return path.relative(this.canonical??path.resolve(this.root),absolute).split(path.sep).join('/'); }

    resolve(relative:string,internal=false):string {
        const normalized=relative.replace(/\\/g,'/');
        if (path.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.split('/').some(p=>!p || p==='.' || p==='..' || /[\0-\x1f]/.test(p))
            || (!internal && (validateReplicaPath(normalized) || isInternalReplicaPath(normalized)))) {
            throw new Error(`Unsafe local replica path: ${relative}`);
        }
        const root=this.canonical??path.resolve(this.root),target=path.resolve(root,normalized);
        if (!target.startsWith(root+path.sep)) { throw new Error(`Path escapes local replica: ${relative}`); }
        return target;
    }

    async check(relative:string,internal=false,createParents=false):Promise<CheckedPath> {
        await this.initialize();
        const target=this.resolve(relative,internal),parents:DirectoryIdentity[]=[this.identity!];
        await this.verify({path:target,parents});
        const components=path.relative(this.canonical!,path.dirname(target)).split(path.sep).filter(Boolean);
        let current=this.canonical!,missing=false;
        for (const component of components) {
            current=path.join(current,component);
            let stat:Stats;
            try { stat=await fs.lstat(current); }
            catch (error:any) {
                if (error.code!=='ENOENT') { throw error; }
                if (!createParents) { missing=true; break; }
                await this.verify({path:target,parents});
                await fs.mkdir(current).catch((e:any)=>{ if (e.code!=='EEXIST') { throw e; } });
                stat=await fs.lstat(current);
            }
            if (stat.isSymbolicLink() || !stat.isDirectory()) { throw new Error(`Unsupported replica parent: ${current}`); }
            const identity={path:current,dev:stat.dev,ino:stat.ino};
            if (path.relative(this.canonical!,current).split(path.sep)[0]==='.overleaf') {
                const remembered=this.metadataDirectories.get(current);
                if (remembered && (remembered.dev!==stat.dev || remembered.ino!==stat.ino)) { throw new Error(`Replica metadata directory changed: ${current}`); }
                this.metadataDirectories.set(current,identity);
            }
            parents.push(identity);
        }
        if (!missing) {
            try { if ((await fs.lstat(target)).isSymbolicLink()) { throw new Error(`Symbolic links cannot be synchronized: ${relative}`); } }
            catch (error:any) { if (error.code!=='ENOENT') { throw error; } }
        }
        const checked={path:target,parents}; await this.verify(checked); return checked;
    }

    async verify(checked:CheckedPath):Promise<void> {
        if (this.identity) {
            const root=await fs.stat(this.root);
            if (root.dev!==this.identity.dev || root.ino!==this.identity.ino) { throw new Error('The selected replica root changed during access'); }
        }
        for (const expected of checked.parents) {
            const actual=await fs.lstat(expected.path);
            if (actual.isSymbolicLink() || !actual.isDirectory() || actual.dev!==expected.dev || actual.ino!==expected.ino) {
                throw new Error(`Replica directory changed during access: ${expected.path}`);
            }
        }
    }

    async list(relative='',internal=false):Promise<Dirent[]> {
        const checked=await this.check(`${relative?relative+'/':''}.overleaf-directory-check`,internal);
        try {
            const entries=await fs.readdir(path.dirname(checked.path),{withFileTypes:true});
            await this.verify(checked); return entries;
        } catch (error:any) { if (error.code==='ENOENT') { await this.verify(checked); return []; } throw error; }
    }

    async stat(relative:string):Promise<Stats|undefined> {
        const checked=await this.check(relative);
        try { const stat=await fs.lstat(checked.path); await this.verify(checked); if (stat.isSymbolicLink()) { throw new Error(`Symbolic links cannot be synchronized: ${relative}`); } return stat; }
        catch (error:any) { if (error.code==='ENOENT') { await this.verify(checked); return undefined; } throw error; }
    }

    async read(relative:string,internal=false):Promise<Uint8Array|undefined> {
        const checked=await this.check(relative,internal);
        let handle:fs.FileHandle;
        try { handle=await fs.open(checked.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)); }
        catch (error:any) { if (error.code==='ENOENT') { return undefined; } throw error; }
        try {
            const before=await handle.stat(),named=await fs.lstat(checked.path);
            await this.verify(checked);
            if (!before.isFile() || named.isSymbolicLink() || before.dev!==named.dev || before.ino!==named.ino) { throw new Error(`Replica file changed during open: ${relative}`); }
            const content=await handle.readFile(),after=await handle.stat(),namedAfter=await fs.lstat(checked.path);
            await this.verify(checked);
            if (namedAfter.isSymbolicLink() || before.dev!==namedAfter.dev || before.ino!==namedAfter.ino
                || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs) { throw new Error(`Replica file changed during read: ${relative}`); }
            return content;
        } finally { await handle.close(); }
    }
}

/** Policy applies to existing records as well as new scanner/watcher paths. */
export class PathPolicy {
    private issues:PathIssue[]=[];
    constructor(readonly access:LocalPathAccess,private readonly patterns:()=>string[]) {}
    setIssues(issues:PathIssue[]):void { this.issues=issues; }
    isIgnored(value:string):boolean {
        if (isInternalReplicaPath(value)) { return true; }
        const parts=value.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'').split('/');
        return this.patterns().some(pattern=>parts.some((_,index)=>minimatch(parts.slice(0,index+1).join('/'),pattern,{dot:true})));
    }
    async check(value:string):Promise<PathDecision> {
        if (this.isIgnored(value)) { return {type:'ignored',message:'Excluded by local replica ignore rules'}; }
        const issue=validateReplicaPath(value);
        if (issue) { return {type:'blocked',message:issue}; }
        const key=pathComparisonKey(value),blocked=this.issues.find(item=>key===pathComparisonKey(item.path) || key.startsWith(pathComparisonKey(item.path)+'/'));
        if (blocked) { return {type:'blocked',message:blocked.message}; }
        try { await this.access.check(value); return {type:'allowed'}; }
        catch (error:any) { return {type:'blocked',message:error.message}; }
    }
}
