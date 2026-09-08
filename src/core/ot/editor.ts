import type * as VSCode from 'vscode';
import { OtSession } from './session';
import { textDiff, textOT } from './text';

/** Editor presentation is separate from the acknowledged and saved document layers. */
export class OtEditor implements VSCode.Disposable {
    private shown:string;
    private applying?:string;
    private projection:Promise<void>=Promise.resolve();
    private listener:VSCode.Disposable;
    private disposed=false;
    constructor(readonly document:VSCode.TextDocument,readonly session:OtSession,private readonly report:(error:Error)=>void,private readonly platform:typeof VSCode) {
        this.shown=document.getText();
        this.listener=this.platform.workspace.onDidChangeTextDocument(event=>{
            if (event.document!==document || !event.contentChanges.length) { return; }
            const next=document.getText();
            if (next===session.editing && !document.isDirty) { this.shown=next; return; }
            if (this.applying===next) { this.shown=next; this.applying=undefined; return; }
            // Incorporate changes made while a remote projection is awaiting applyEdit.
            const local=textDiff(this.shown,next),remote=textDiff(this.shown,session.editing);
            this.shown=next;
            try {
                const [rebased]=textOT.transformX(local,remote);
                void session.edit(textOT.apply(session.editing,rebased)).then(()=>this.refresh()).catch(report);
            } catch (error:any) { session.fail(error); report(error); }
        });
        void this.refresh().catch(report);
    }
    save(content:string):Promise<void> {
        const [change]=textOT.transformX(textDiff(this.shown,content),textDiff(this.shown,this.session.editing));
        return this.session.save(textOT.apply(this.session.editing,change));
    }
    refresh():Promise<void> {
        const task=this.projection.then(async()=>{
            if (this.disposed || this.document.isClosed) { return; }
            const target=this.session.editing;
            if (this.document.getText()===target) { this.shown=target; return; }
            // Clean buffers reload through their file provider/disk watcher. Applying an
            // editor edit here would manufacture a dirty document for a remote-only edit.
            if (!this.document.isDirty && this.session.editing===this.session.saved) { return; }
            const version=this.document.version;
            const op=textDiff(this.document.getText(),target);
            // Convert sequential OT coordinates into a single editor replacement.
            // applyEdit captures the open document version; VS Code rejects stale edits.
            const edit=new this.platform.WorkspaceEdit();
            edit.replace(this.document.uri,new this.platform.Range(this.document.positionAt(0),this.document.positionAt(this.document.getText().length)),target);
            if (!op.length || this.document.version!==version) { return; }
            this.applying=target;
            try {
                if (!await this.platform.workspace.applyEdit(edit)) { throw new Error('Editor changed during OT projection; local edits retained'); }
            } finally { this.applying=undefined; }
        });
        this.projection=task.catch(error=>{ this.session.fail(error); this.report(error); });
        return task;
    }
    dispose():void { this.disposed=true; this.listener.dispose(); }
}
