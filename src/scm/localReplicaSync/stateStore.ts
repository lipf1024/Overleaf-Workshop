import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import { ConflictRecord, JournalEntry, SyncStateV1 } from './model';
import { LocalPathAccess, PathDecision } from './pathPolicy';
import { ReplicaOwnership } from './ownership';

interface JournalFile {schemaVersion:1|2|3; entries:JournalEntry[]}
export interface LocalRecoveryReview {entry:JournalEntry;key:string}
export class UnsupportedSyncStateError extends Error {}
export class LocalMutationConflictError extends Error {
    readonly type='conflict';
    constructor(message:string,readonly entry?:JournalEntry) { super(message); }
}

export class SyncStateStore {
    private writeQueue:Promise<unknown>=Promise.resolve();
    private journalCorrupt=false;
    private legacyJournal=false;
    private initialized?:Promise<void>;
    private writeBlocked?:Error;
    private mutationPolicy?:((path:string)=>Promise<PathDecision>);
    readonly access:LocalPathAccess;
    private readonly ownership:ReplicaOwnership;
    private readonly pins=new Map<string,number>();
    readonly syncDir:string;
    private readonly objectsDir:string;
    private readonly conflictsDir:string;
    private readonly backupsDir:string;
    private readonly statePath:string;
    private readonly journalPath:string;

    constructor(
        readonly root:string,
        private readonly project:{projectId:string;serverIdentityHash:string},
    ) {
        this.access=new LocalPathAccess(root);
        this.ownership=new ReplicaOwnership(this.access);
        this.syncDir = path.join(root,'.overleaf','sync');
        this.objectsDir = path.join(this.syncDir,'objects');
        this.conflictsDir = path.join(this.syncDir,'conflicts');
        this.backupsDir = path.join(this.syncDir,'backups');
        this.statePath = path.join(this.syncDir,'state.json');
        this.journalPath = path.join(this.syncDir,'journal.json');
    }

    get isOwner():boolean { return this.ownership.isOwner; }
    async readOtJournal(id:string):Promise<import('../../core/ot/session').OtJournal|undefined> {
        if (!/^[a-f0-9]{64}$/.test(id)) { throw new Error('Invalid OT journal key'); }
        await this.initialize();
        try { return await this.readJson(path.join(this.syncDir,`ot-${id}.json`)); }
        catch (error:any) { if (error.code==='ENOENT') { return undefined; } throw error; }
    }
    async writeOtJournal(id:string,journal:import('../../core/ot/session').OtJournal):Promise<void> {
        if (!/^[a-f0-9]{64}$/.test(id)) { throw new Error('Invalid OT journal key'); }
        await this.assertWritable();
        await this.atomicJson(path.join(this.syncDir,`ot-${id}.json`),journal);
    }
    async archiveOtJournal(id:string,journal:import('../../core/ot/session').OtJournal):Promise<void> {
        if (!/^[a-f0-9]{64}$/.test(id)) { throw new Error('Invalid OT journal key'); }
        await this.assertWritable();
        await this.atomicJson(path.join(this.syncDir,`ot-recovery-${id}-${randomUUID()}.json`),journal);
    }
    async initialize():Promise<void> {
        if (!this.initialized) { this.initialized=this.initializeImpl().catch(error=>{ this.initialized=undefined; throw error; }); }
        await this.initialized;
    }
    private async initializeImpl():Promise<void> {
        await this.access.initialize();
        await this.ownership.acquire();
        await this.verifyFormats();
        if (this.isOwner) { await this.createStorageDirectories(); }
    }
    private async verifyFormats():Promise<void> {
        try {
            try { await this.readStateSnapshot(); } catch (error) { if (!(error instanceof SyntaxError)) { throw error; } }
            try {
                const journal=await this.readJson(this.journalPath);
                if (![1,2,3].includes(journal.schemaVersion)) { this.writeBlocked=new UnsupportedSyncStateError('Unsupported journal schema; synchronization is read-only'); throw this.writeBlocked; }
            } catch (error:any) { if (error.code!=='ENOENT' && !(error instanceof SyntaxError)) { throw error; } }
        } catch (error:any) { this.writeBlocked=error; throw error; }
    }
    setMutationPolicy(policy?:((path:string)=>Promise<PathDecision>)):void { this.mutationPolicy=policy; }
    private async assertUserPath(relative:string):Promise<void> {
        const decision=await this.mutationPolicy?.(relative);
        if (decision && decision.type!=='allowed') { throw new Error(decision.message); }
    }
    private async createStorageDirectories():Promise<void> {
        for (const directory of ['objects','conflicts','backups']) {
            await this.access.check(`.overleaf/sync/${directory}/placeholder`,true,true);
        }
    }
    async tryTakeOwnership():Promise<boolean> {
        await this.initialize();
        if (!await this.ownership.acquire()) { return false; }
        await this.verifyFormats(); await this.createStorageDirectories(); return true;
    }
    async assertWritable():Promise<void> { if (this.writeBlocked) { throw this.writeBlocked; } await this.initialize(); await this.ownership.assert(); }
    async close():Promise<void> { await this.writeQueue; await this.ownership.close(); }
    pinObjects(ids:(string|undefined)[]):()=>void {
        const values=ids.filter((id):id is string=>!!id);
        for (const id of values) { this.pins.set(id,(this.pins.get(id)??0)+1); }
        return ()=>{ for (const id of values) { const count=(this.pins.get(id)??1)-1; if (count) { this.pins.set(id,count); } else { this.pins.delete(id); } } };
    }
    private relative(target:string):string { return path.relative(this.root,target).split(path.sep).join('/'); }
    private async readBytes(target:string):Promise<Uint8Array|undefined> { return this.access.read(this.relative(target),true); }
    private async readJson(target:string):Promise<any> {
        const content=await this.readBytes(target);
        if (content===undefined) { const error:any=new Error('File not found'); error.code='ENOENT'; throw error; }
        return JSON.parse(Buffer.from(content).toString('utf8'));
    }
    async readStateSnapshot():Promise<SyncStateV1> {
        try {
            const parsed=await this.readJson(this.statePath) as SyncStateV1;
            if (parsed.schemaVersion!==1 || parsed.project?.projectId!==this.project.projectId || parsed.project?.serverIdentityHash!==this.project.serverIdentityHash || !parsed.files) {
                this.writeBlocked=new UnsupportedSyncStateError('Incompatible sync state or project identity; synchronization is read-only'); throw this.writeBlocked;
            }
            return parsed;
        } catch (error:any) { if (error.code==='ENOENT') { return this.emptyState(); } throw error; }
    }

    emptyState():SyncStateV1 {
        return {schemaVersion:1,project:this.project,generation:0,files:{}};
    }

    async loadState():Promise<{state:SyncStateV1;safeInitialization:boolean}> {
        await this.initialize();
        await this.listJournal();
        try {
            const state=await this.readStateSnapshot();
            const exists=await this.readBytes(this.statePath);
            return {state,safeInitialization:!exists || this.journalCorrupt || this.legacyJournal};
        } catch (error:any) {
            if (error instanceof UnsupportedSyncStateError) { throw error; }
            if (this.isOwner && error instanceof SyntaxError) {
                const checked=await this.access.check('.overleaf/sync/state.json',true);
                await fs.rename(checked.path,`${checked.path}.corrupt-${Date.now()}-${randomUUID()}`);
                return {state:this.emptyState(),safeInitialization:true};
            }
            throw error;
        }
    }

    async saveState(state:SyncStateV1):Promise<void> {
        await this.serial(async()=>{ state.generation += 1; await this.atomicJson(this.statePath,state); });
    }

    async saveProjectSettings(settings:unknown):Promise<void> {
        await this.serial(()=>this.atomicJson(path.join(this.root,'.overleaf','settings.json'),settings));
    }

    async putObject(content:Uint8Array):Promise<string> {
        await this.assertWritable();
        const id = createHash('sha256').update(content).digest('hex');
        const target = path.join(this.objectsDir,id);
        const existing=await this.readBytes(target);
        if (existing===undefined) { await this.atomicBytes(target,content); }
        else if (hash(existing)!==id) { throw new Error(`Stored synchronization object is corrupt: ${id}`); }
        return id;
    }

    async getObject(id?:string):Promise<Uint8Array|undefined> {
        if (!id) { return undefined; }
        if (!/^[a-f0-9]{64}$/.test(id)) { return undefined; }
        return this.readBytes(path.join(this.objectsDir,id));
    }

    private checkConflictId(id:string):void { if (!/^[\w-]+$/.test(id)) { throw new Error('Invalid conflict identifier'); } }

    async saveConflict(conflict:ConflictRecord,preserveCurrentDraft=false):Promise<void> {
        this.checkConflictId(conflict.id);
        await this.serial(async()=>{
            try { if (preserveCurrentDraft) {
                const current=await this.readJson(path.join(this.conflictsDir,`${conflict.id}.json`)) as ConflictRecord;
                // A concurrently saved user draft always wins over a recomputed snapshot.
                if (current.draftObjectId) { conflict.draftObjectId=current.draftObjectId; }
            }} catch (error:any) { if (error.code!=='ENOENT') { throw error; } }
            conflict.updatedAt=Date.now();
            await this.atomicJson(path.join(this.conflictsDir,`${conflict.id}.json`),conflict);
        });
    }

    async updateConflictDraft(id:string,draftObjectId:string,resolvedHunks:number[],hunkChoices:Record<string,'local'|'remote'|'both'>):Promise<void> {
        this.checkConflictId(id);
        await this.serial(async()=>{
            let conflict:ConflictRecord;
            try { conflict=await this.readJson(path.join(this.conflictsDir,`${id}.json`)); }
            catch (error:any) { if (error.code==='ENOENT') { return; } throw error; }
            conflict.draftObjectId=draftObjectId; conflict.resolvedHunks=[...new Set(resolvedHunks)]; conflict.hunkChoices=hunkChoices; conflict.updatedAt=Date.now();
            await this.atomicJson(path.join(this.conflictsDir,`${id}.json`),conflict);
        });
    }

    async readConflict(id:string):Promise<ConflictRecord|undefined> {
        this.checkConflictId(id);
        try { return await this.readJson(path.join(this.conflictsDir,`${id}.json`)); }
        catch (error:any) { if (error.code==='ENOENT') { return undefined; } throw error; }
    }

    async removeConflict(id:string):Promise<void> {
        this.checkConflictId(id);
        await this.serial(async()=>{ const checked=await this.access.check(`.overleaf/sync/conflicts/${id}.json`,true); await fs.unlink(checked.path).catch((e:any)=>{ if (e.code!=='ENOENT') { throw e; } }); });
    }

    async listConflicts():Promise<ConflictRecord[]> {
        await this.access.check('.overleaf/sync/conflicts/placeholder',true);
        const names=(await this.access.list('.overleaf/sync/conflicts',true)).map(entry=>entry.name); const result:ConflictRecord[]=[];
        for (const name of names.filter(value=>value.endsWith('.json'))) {
            const conflict=await this.readConflict(name.slice(0,-5)); if (conflict) { result.push(conflict); }
        }
        return result;
    }

    async listJournal():Promise<JournalEntry[]> {
        try {
            const journal=await this.readJson(this.journalPath) as JournalFile;
            if (![1,2,3].includes(journal.schemaVersion)) { this.writeBlocked=new UnsupportedSyncStateError('Unsupported journal schema; synchronization is read-only'); throw this.writeBlocked; }
            if (!Array.isArray(journal.entries)) { throw new SyntaxError('Invalid synchronization journal'); }
            for (const entry of journal.entries) {
                for (const value of [entry.localStagingPath,entry.localRecoveryPath]) {
                    if (value!==undefined && !/(?:^|\/)\.overleaf-sync-[a-f0-9-]{36}\/(original|result)$/.test(value)) { throw new SyntaxError('Invalid local recovery journal path'); }
                }
            }
            if (journal.schemaVersion!==3) { this.legacyJournal=true; }
            return journal.entries;
        } catch (error:any) {
            if (error.code==='ENOENT') { return []; }
            if (error instanceof UnsupportedSyncStateError || !(error instanceof SyntaxError)) { throw error; }
            this.journalCorrupt=true;
            if (this.isOwner) {
                const checked=await this.access.check('.overleaf/sync/journal.json',true);
                await fs.rename(checked.path,`${checked.path}.corrupt-${Date.now()}-${randomUUID()}`);
            }
            return [];
        }
    }

    async putJournal(entry:JournalEntry):Promise<void> {
        await this.serial(async()=>{
            const entries = (await this.listJournal()).filter(item=>item.id!==entry.id);
            entries.push(entry);
            await this.atomicJson(this.journalPath,{schemaVersion:3,entries});
        });
    }

    async beginJournal(entry:Omit<JournalEntry,'id'|'createdAt'|'phase'>):Promise<JournalEntry> {
        const value:JournalEntry={...entry,id:randomUUID(),createdAt:Date.now(),phase:'prepared'};
        await this.putJournal(value);
        return value;
    }

    async removeJournal(id:string):Promise<void> {
        await this.serial(async()=>{
            const entries=await this.listJournal(),entry=entries.find(item=>item.id===id);
            await this.atomicJson(this.journalPath,{schemaVersion:3,entries:entries.filter(item=>item.id!==id)});
            if (entry?.localStagingPath) {
                const checked=await this.access.check(entry.localStagingPath,true);
                await fs.unlink(checked.path).catch((e:any)=>{ if (e.code!=='ENOENT') { throw e; } });
                await fs.rmdir(path.dirname(checked.path)).catch(()=>undefined);
            }
        });
    }

    async backup(pathname:string,content:Uint8Array):Promise<string> {
        await this.assertWritable();
        const id = `${Date.now()}-${randomUUID()}`;
        await this.atomicBytes(path.join(this.backupsDir,id),content);
        await this.atomicJson(path.join(this.backupsDir,`${id}.json`),{path:pathname,createdAt:Date.now()});
        return id;
    }

    private async hasUncertainRecovery():Promise<boolean> {
        return this.journalCorrupt || (await this.access.list('.overleaf/sync',true)).some(entry=>/^(state|journal)\.json\.corrupt-/.test(entry.name));
    }

    async pruneBackups():Promise<void> {
        await this.assertWritable();
        if (await this.hasUncertainRecovery()) { return; }
        const protectedIds=new Set((await this.listJournal()).map(entry=>entry.backupObjectId).filter((id):id is string=>!!id));
        const names=(await this.access.list('.overleaf/sync/backups',true)).map(entry=>entry.name);
        const items:Array<{id:string;createdAt:number;size:number;localPath?:string}>=[];
        for (const name of names.filter(value=>value.endsWith('.json'))) {
            const id=name.slice(0,-5);
            try {
                const metadata=await this.readJson(path.join(this.backupsDir,name));
                if (metadata.localPath!==undefined && !/(?:^|\/)\.overleaf-sync-[a-f0-9-]{36}\/original$/.test(metadata.localPath)) { continue; }
                const checked=await this.access.check(metadata.localPath??`.overleaf/sync/backups/${id}`,true);
                const stat=await fs.lstat(checked.path);
                if (!stat.isFile()) { continue; }
                items.push({id,createdAt:metadata.localPath?Math.max(Number(metadata.createdAt)||0,stat.mtimeMs):(Number(metadata.createdAt)||stat.mtimeMs),size:stat.size,localPath:metadata.localPath});
            } catch { /* leave unrecognized data untouched */ }
        }
        items.sort((a,b)=>b.createdAt-a.createdAt);
        let retained=0;
        const cutoff=Date.now()-30*24*60*60*1000;
        for (const item of items) {
            const keep=protectedIds.has(item.id) || (item.createdAt>=cutoff && retained+item.size<=500*1024*1024);
            if (keep) { retained+=item.size; continue; }
            const checked=await this.access.check(item.localPath??`.overleaf/sync/backups/${item.id}`,true);
            await this.access.verify(checked); await fs.unlink(checked.path).catch((error:any)=>{ if (error.code!=='ENOENT') { throw error; } });
            const metadata=await this.access.check(`.overleaf/sync/backups/${item.id}.json`,true);
            await this.access.verify(metadata); await fs.unlink(metadata.path).catch((error:any)=>{ if (error.code!=='ENOENT') { throw error; } });
            if (item.localPath) { await fs.rmdir(path.dirname(checked.path)).catch(()=>undefined); }
        }
    }

    async atomicLocalWrite(relativePath:string,content:Uint8Array,operation:JournalEntry['operation'],operationId?:string,expectedCurrentHash?:string,verifyCurrent=false):Promise<JournalEntry> {
        return this.applyLocal(relativePath,content,operation,operationId,expectedCurrentHash,verifyCurrent);
    }
    async atomicLocalDelete(relativePath:string,operationId?:string,expectedCurrentHash?:string):Promise<JournalEntry> {
        return this.applyLocal(relativePath,undefined,'delete-local',operationId,expectedCurrentHash,true);
    }
    async atomicLocalMove(fromPath:string,toPath:string,operationId?:string,expectedCurrentHash?:string):Promise<JournalEntry> {
        const source=await this.access.read(fromPath);
        if (!source) { throw new Error(`Move source is missing: ${fromPath}`); }
        return this.applyLocal(toPath,source,'move-local',operationId,expectedCurrentHash??hash(source),true,fromPath);
    }
    private async applyLocal(relativePath:string,content:Uint8Array|undefined,operation:JournalEntry['operation'],operationId?:string,expectedHash?:string,verifyCurrent=false,sourcePath=relativePath):Promise<JournalEntry> {
        await this.assertWritable(); await this.assertUserPath(relativePath); await this.assertUserPath(sourcePath);
        const source=await this.access.check(sourcePath),destination=await this.access.check(relativePath,false,true);
        const original=await this.access.read(sourcePath);
        if (verifyCurrent && hash(original)!==expectedHash) { throw new LocalMutationConflictError(`Local file changed before ${operation}`); }
        if (sourcePath!==relativePath && await this.access.read(relativePath)!==undefined) { throw new LocalMutationConflictError(`Move target already exists: ${relativePath}`); }
        const id=randomUUID(),directory=path.posix.join(path.posix.dirname(sourcePath),`.overleaf-sync-${id}`);
        const checked=await this.access.check(directory,true);
        await this.access.verify(source); await fs.mkdir(checked.path,{mode:0o700});
        try { await this.verifyInstallCapability(directory,destination.path); }
        catch (error) { await fs.rmdir(checked.path).catch(()=>undefined); throw error; }
        const entry:JournalEntry={id,operationId,path:relativePath,sourcePath:sourcePath===relativePath?undefined:sourcePath,operation,phase:'prepared',localStage:'prepared',
            targetHash:hash(content),localExpectedHash:hash(original),localExpectedExists:original!==undefined,
            localRecoveryPath:`${directory}/original`,localStagingPath:content!==undefined?`${directory}/result`:undefined,createdAt:Date.now()};
        if (content!==undefined) { await this.atomicBytes(path.join(this.root,entry.localStagingPath!),content); }
        await this.putJournal(entry);
        try {
            await this.access.verify(source); await this.access.verify(destination); await this.assertWritable();
            await this.assertUserPath(sourcePath); await this.assertUserPath(relativePath);
            if (original!==undefined) {
                const capture=await this.access.check(entry.localRecoveryPath!,true);
                await fs.rename(source.path,capture.path);
                await this.syncDirectory(path.dirname(source.path)); await this.syncDirectory(path.dirname(capture.path));
                entry.localStage='captured';
                entry.backupObjectId=`${Date.now()}-${id}`;
                await this.atomicJson(path.join(this.backupsDir,`${entry.backupObjectId}.json`),{path:sourcePath,localPath:entry.localRecoveryPath,createdAt:Date.now()});
                await this.putJournal(entry);
                const captured=await this.access.read(entry.localRecoveryPath!,true);
                if (hash(captured)!==entry.localExpectedHash) { throw new LocalMutationConflictError(`Local file changed while preparing ${operation}`,entry); }
            }
            await this.access.verify(source); await this.access.verify(destination);
            await this.assertUserPath(sourcePath); await this.assertUserPath(relativePath);
            if (content!==undefined) {
                const staged=await this.access.check(entry.localStagingPath!,true);
                // link is an atomic no-replace installation. rename would clobber a concurrent save.
                await fs.link(staged.path,destination.path);
            } else if (await this.access.read(relativePath)!==undefined) {
                throw new LocalMutationConflictError('A file was recreated during deletion',entry);
            }
            await this.access.verify(destination); await this.syncDirectory(path.dirname(destination.path));
            if (sourcePath!==relativePath) { await this.syncDirectory(path.dirname(source.path)); }
            if (hash(await this.access.read(relativePath))!==hash(content)
                || (original!==undefined && hash(await this.access.read(entry.localRecoveryPath!,true))!==entry.localExpectedHash)) {
                throw new LocalMutationConflictError('Local content changed during installation; both versions were preserved',entry);
            }
            entry.localStage='installed'; entry.phase='local-applied'; await this.putJournal(entry); return entry;
        } catch (error:any) {
            entry.recoveryRequired=true;
            await this.putJournal(entry);
            await this.restoreCaptured(entry).catch(()=>undefined);
            throw new LocalMutationConflictError(`${error.message}. Recovery files were preserved.`,entry);
        }
    }

    private async verifyInstallCapability(directory:string,destination:string):Promise<void> {
        const probe=await this.access.check(`${directory}/link-probe`,true),linked=await this.access.check(`${directory}/link-probe-copy`,true);
        if ((await fs.stat(path.dirname(probe.path))).dev!==(await fs.stat(path.dirname(destination))).dev) { throw new Error('A local move across filesystems cannot be installed safely'); }
        await this.access.verify(probe); await fs.writeFile(probe.path,new Uint8Array(),{flag:'wx',mode:0o600});
        try { await this.access.verify(linked); await fs.link(probe.path,linked.path); }
        finally {
            await this.access.verify(probe);
            await fs.unlink(linked.path).catch((error:any)=>{ if (error.code!=='ENOENT') { throw error; } });
            await fs.unlink(probe.path);
        }
    }

    private async restoreCaptured(entry:JournalEntry):Promise<void> {
        if (!entry.localRecoveryPath) { return; }
        await this.assertUserPath(entry.path); if (entry.sourcePath) { await this.assertUserPath(entry.sourcePath); }
        const original=await this.access.read(entry.localRecoveryPath,true);
        if (original===undefined) { return; }
        const source=await this.access.check(entry.sourcePath??entry.path,false,true),captured=await this.access.check(entry.localRecoveryPath,true);
        await this.access.verify(source); await this.assertWritable();
        try { await fs.link(captured.path,source.path); await this.syncDirectory(path.dirname(source.path)); }
        catch (error:any) { if (error.code!=='EEXIST') { throw error; } }
    }

    async recoverLocalOperations(eligible:(path:string)=>Promise<boolean>=async path=>{ const decision=await this.mutationPolicy?.(path); return !decision || decision.type==='allowed'; }):Promise<Map<string,string>> {
        await this.assertWritable();
        const blocked=new Map<string,string>();
        for (const entry of await this.listJournal()) {
            if (!entry.localStage || !await eligible(entry.path) || (entry.sourcePath && !await eligible(entry.sourcePath))) { continue; }
            const captured=entry.localRecoveryPath?await this.access.read(entry.localRecoveryPath,true):undefined;
            const current=await this.access.read(entry.path);
            if (captured!==undefined && !entry.backupObjectId) {
                entry.backupObjectId=`${Date.now()}-${entry.id}`;
                await this.atomicJson(path.join(this.backupsDir,`${entry.backupObjectId}.json`),{path:entry.sourcePath??entry.path,localPath:entry.localRecoveryPath,createdAt:Date.now()});
                await this.putJournal(entry);
            }
            if (entry.recoveryRequired || (captured!==undefined && hash(captured)!==entry.localExpectedHash)) {
                await this.restoreCaptured(entry);
                const restored=await this.access.read(entry.sourcePath??entry.path);
                if (hash(restored)===hash(captured) && captured!==undefined) { await this.removeJournal(entry.id); continue; }
                blocked.set(entry.path,`Concurrent versions were preserved. Review ${entry.localRecoveryPath} and ${entry.path} before retrying.`);
                continue;
            }
            if (entry.localStage!=='installed' && (entry.targetHash===undefined || hash(current)!==entry.targetHash)) {
                await this.restoreCaptured(entry);
                // Restore first, then normal reconciliation may retry against the actual current content.
                if (entry.sourcePath && await this.access.read(entry.sourcePath)===undefined) {
                    blocked.set(entry.path,'An interrupted local move needs recovery'); continue;
                }
                await this.removeJournal(entry.id);
            }
        }
        return blocked;
    }

    async listLocalRecoveryReviews():Promise<LocalRecoveryReview[]> {
        const reviews:LocalRecoveryReview[]=[];
        for (const entry of await this.listJournal()) {
            if (!entry.localStage) { continue; }
            const target=await this.mutationPolicy?.(entry.path),source=entry.sourcePath?await this.mutationPolicy?.(entry.sourcePath):undefined;
            if ((target && target.type!=='allowed') || (source && source.type!=='allowed')) { continue; }
            reviews.push(await this.reviewLocalRecovery(entry));
        }
        return reviews;
    }
    private async reviewLocalRecovery(entry:JournalEntry):Promise<LocalRecoveryReview> {
        await this.assertUserPath(entry.path); if (entry.sourcePath) { await this.assertUserPath(entry.sourcePath); }
        const [current,source,captured,staged]=await Promise.all([
            this.access.read(entry.path),entry.sourcePath?this.access.read(entry.sourcePath):undefined,
            entry.localRecoveryPath?this.access.read(entry.localRecoveryPath,true):undefined,
            entry.localStagingPath?this.access.read(entry.localStagingPath,true):undefined,
        ]);
        return {entry,key:hash(Buffer.from(JSON.stringify({entry,current:hash(current),source:hash(source),captured:hash(captured),staged:hash(staged)})))!};
    }
    async acknowledgeLocalRecovery(review:LocalRecoveryReview):Promise<void> {
        await this.assertWritable();
        const entry=(await this.listJournal()).find(value=>value.id===review.entry.id);
        if (!entry || (await this.reviewLocalRecovery(entry)).key!==review.key) { throw new Error('Recovery files changed since review; inspect the current versions again'); }
        // Acknowledgment never installs a file. Preserve all reviewed versions before
        // allowing ordinary reconciliation to compare the user's current file again.
        const current=await this.access.read(entry.path);
        if (current) { await this.backup(entry.path,current); }
        const staged=entry.localStagingPath?await this.access.read(entry.localStagingPath,true):undefined;
        if (staged) { await this.backup(entry.path,staged); }
        const captured=entry.localRecoveryPath?await this.access.read(entry.localRecoveryPath,true):undefined;
        if (captured && !entry.backupObjectId) { await this.backup(entry.sourcePath??entry.path,captured); }
        if ((await this.reviewLocalRecovery(entry)).key!==review.key) { throw new Error('Recovery files changed while being backed up; review again'); }
        await this.removeJournal(entry.id);
    }

    resolveSafe(relativePath:string):string { return this.access.resolve(relativePath); }

    async writeMergeFile(relative:string,content:Uint8Array):Promise<void> {
        if (!/^\.overleaf\/sync\/merge\/[\w-]+\/[a-f0-9]{64}\/(base|local|remote|result)\/[^/]+$/.test(relative)) { throw new Error('Invalid merge session path'); }
        await this.assertWritable();
        const checked=await this.access.check(relative,true,true);
        let handle:fs.FileHandle;
        try { handle=await fs.open(checked.path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600); }
        catch (error:any) { if (error.code==='EEXIST') { return; } throw error; }
        try { await this.access.verify(checked); await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    }

    async collectGarbage(state:SyncStateV1,sessionPaths:string[]=[]):Promise<void> {
        if (await this.hasUncertainRecovery()) { return; }
        await this.serial(async()=>{
            const roots=new Set<string>(this.pins.keys());
            for (const record of Object.values(state.files)) { if (record.base) { roots.add(record.base.objectId); } }
            const conflicts=await this.listConflicts(),journal=await this.listJournal();
            for (const conflict of conflicts) {
                for (const id of [conflict.baseObjectId,conflict.localObjectId,conflict.remoteObjectId,conflict.draftObjectId]) { if (id) { roots.add(id); } }
            }
            for (const entry of journal) { for (const id of [entry.remoteBeforeObjectId,entry.targetHash,entry.backupObjectId]) { if (id) { roots.add(id); } } }
            await this.access.check('.overleaf/sync/objects/placeholder',true);
            for (const {name} of await this.access.list('.overleaf/sync/objects',true)) {
                if (/^[a-f0-9]{64}$/.test(name) && !roots.has(name)) { await fs.unlink((await this.access.check(`.overleaf/sync/objects/${name}`,true)).path); }
            }
            await this.access.check('.overleaf/sync/merge/placeholder',true);
            const ids=new Set(conflicts.map(conflict=>conflict.id));
            for (const {name} of await this.access.list('.overleaf/sync/merge',true)) {
                const relative=`.overleaf/sync/merge/${name}`;
                if (ids.has(name) || sessionPaths.some(value=>value===relative || value.startsWith(relative+'/'))) { continue; }
                // Validate every descendant before recursively deleting extension-owned session data.
                await this.removeOwnedTree(relative);
            }
        });
        await this.pruneBackups();
    }
    private async removeOwnedTree(relative:string):Promise<void> {
        const checked=await this.access.check(relative,true);
        const stat=await fs.lstat(checked.path);
        if (stat.isDirectory()) {
            for (const {name} of await this.access.list(relative,true)) { await this.removeOwnedTree(`${relative}/${name}`); }
            await this.access.verify(checked); await fs.rmdir(checked.path);
        } else { await this.access.verify(checked); await fs.unlink(checked.path); }
    }

    private async atomicJson(target:string,value:unknown):Promise<void> {
        await this.atomicBytes(target,Buffer.from(JSON.stringify(value,null,2)));
    }

    private async serial<T>(operation:()=>Promise<T>):Promise<T> {
        const result=this.writeQueue.catch(()=>undefined).then(async()=>{ await this.assertWritable(); return operation(); });
        this.writeQueue=result.catch(()=>undefined);
        return result;
    }

    private async atomicBytes(target:string,value:Uint8Array):Promise<void> {
        await this.assertWritable();
        const checked=await this.access.check(this.relative(target),true,true);
        const temporary=path.join(path.dirname(checked.path),`.overleaf-sync-${path.basename(target)}-${process.pid}-${randomUUID()}.tmp`);
        const handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
        try { await this.access.verify(checked); await handle.writeFile(value); await handle.sync(); }
        finally { await handle.close(); }
        await this.access.verify(checked);
        await fs.rename(temporary,checked.path); await this.syncDirectory(path.dirname(checked.path));
    }

    private async syncDirectory(directoryPath:string):Promise<void> {
        try { const directory=await fs.open(directoryPath,'r'); try { await directory.sync(); } finally { await directory.close(); } }
        catch { /* directory fsync is not supported on every platform */ }
    }


}

function hash(content:Uint8Array|undefined):string|undefined { return content===undefined?undefined:createHash('sha256').update(content).digest('hex'); }
