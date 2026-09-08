import type * as VSCode from 'vscode';
import type { VirtualFileSystem } from '../../core/remoteFileSystemProvider';
import { OtSession } from '../../core/ot/session';
import { textDiff, textOT, TextOperation } from '../../core/ot/text';
import { RemoteSnapshot } from './model';
import { SyncStateStore } from './stateStore';
import { contentHash } from './hash';

/** The disk cursor is independent of both the server cursor and the dirty editor. */
export class ReplicaOtBridge implements VSCode.Disposable {
    private bindings=new Map<string,{id:string;disk:string;session:OtSession;remote:TextOperation[];skipLocal:boolean}>();
    private listener:VSCode.Disposable;
    private changes:VSCode.Disposable;
    constructor(private readonly root:VSCode.Uri,private readonly vfs:VirtualFileSystem,private readonly store:SyncStateStore,private readonly platform:typeof VSCode) {
        this.changes=vfs.onOtChange((id,op)=>{
            if (!op) { return; }
            for (const binding of this.bindings.values()) {
                if (binding.id!==id) { continue; }
                if (binding.skipLocal) { binding.skipLocal=false; continue; }
                binding.remote.push(op);
            }
        });
        this.listener=this.platform.workspace.onDidOpenTextDocument(document=>{
            for (const [path,binding] of this.bindings) {
                if (document.uri.toString()===this.platform.Uri.joinPath(root,path).toString()) { vfs.bindOtEditor(document,binding.session); }
            }
        });
    }
    async establish(path:string,snapshot:RemoteSnapshot):Promise<void> {
        if (snapshot.revision.kind!=='document' || this.bindings.has(path)) { return; }
        await this.store.assertWritable();
        const session=await this.vfs.textSession(this.vfs.pathToUri('/'+path));
        if (!session?.ready || session.version!==snapshot.revision.documentVersion || contentHash(Buffer.from(session.confirmed))!==snapshot.hash) { return; }
        const disk=await this.store.access.read(path);
        if (contentHash(disk)!==snapshot.hash) { return; }
        this.bindings.set(path,{id:snapshot.entityId,disk:Buffer.from(disk!).toString('utf8'),session,remote:[],skipLocal:false});
        const document=this.platform.workspace.textDocuments.find(doc=>doc.uri.toString()===this.platform.Uri.joinPath(this.root,path).toString());
        if (document) {
            if (document.isDirty) { await session.edit(document.getText()); }
            this.vfs.bindOtEditor(document,session);
        }
    }
    async sync(path:string):Promise<{snapshot:RemoteSnapshot;local:Uint8Array}|undefined> {
        const binding=this.bindings.get(path);
        if (!binding) { return; }
        await this.store.assertWritable();
        const remoteUri=this.vfs.pathToUri('/'+path);
        const session=await this.vfs.textSession(remoteUri);
        if (!session || !session.ready) { throw new Error('Online OT session is unavailable; local changes retained'); }
        if (session!==binding.session) {
            // Recovered sessions may include operations absent from the disk cursor.
            if (textOT.apply(binding.disk,binding.remote.reduce((a,b)=>textOT.compose(a,b),[]))!==session.saved) {
                this.bindings.delete(path); return; // No contiguous history: use snapshot recovery.
            }
            binding.session=session;
        }
        const bytes=await this.store.access.read(path);
        if (!bytes) { this.bindings.delete(path); return; } // Deletion uses structural recovery.
        const local=new TextDecoder('utf8',{fatal:true}).decode(bytes);
        if (local!==binding.disk) {
            const localOp=textDiff(binding.disk,local);
            const [op]=textOT.transformX(localOp,binding.remote.reduce((a,b)=>textOT.compose(a,b),[]));
            const target=textOT.apply(session.saved,op);
            await session.save(target,()=>{
                const [,remaining]=textOT.transformX(localOp,binding.remote.reduce((a,b)=>textOT.compose(a,b),[]));
                binding.remote=[remaining];
                binding.disk=local; binding.skipLocal=true;
            });
        } else { await session.barrier(); }
        const saved=Buffer.from(session.saved);
        const confirmed=Buffer.from(session.confirmed),hash=contentHash(confirmed)!;
        const snapshot:RemoteSnapshot={path:remoteUri.path,entityId:binding.id,kind:'text',content:confirmed,hash,
            revision:{kind:'document',documentVersion:session.version,contentHash:hash},connectionEpoch:this.vfs.connectionEpoch};
        const projectedEvents=binding.remote.length;
        if (contentHash(await this.store.access.read(path))!==contentHash(bytes)) {
            throw new Error('File was saved again while OT was pending; newer disk content retained');
        }
        if (contentHash(saved)!==contentHash(bytes)) {
            const journal=await this.store.atomicLocalWrite(path,saved,'download',undefined,contentHash(bytes),true);
            await this.store.removeJournal(journal.id);
        }
        binding.disk=saved.toString();
        binding.remote.splice(0,projectedEvents);
        const document=this.platform.workspace.textDocuments.find(doc=>doc.uri.toString()===this.platform.Uri.joinPath(this.root,path).toString());
        if (document) { this.vfs.bindOtEditor(document,session); }
        return {snapshot,local:saved};
    }
    dispose():void { this.listener.dispose(); this.changes.dispose(); this.bindings.clear(); }
}
