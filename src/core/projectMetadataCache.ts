import type { MetadataResponseScheme } from '../api/base';

type ProjectMeta=MetadataResponseScheme['projectMeta'];
export type DocMeta={docId:string;meta:ProjectMeta[string]};

/** One project read per connection, then document responses / broadcastDocMeta updates. */
export class ProjectMetadataCache {
    private value?:ProjectMeta;
    private pending?:Promise<ProjectMeta|undefined>;
    private generation=0;
    private updates:Record<string,ProjectMeta[string]|null>={};

    reset():void { this.generation++; this.value=undefined; this.pending=undefined; this.updates={}; }
    update({docId,meta}:DocMeta):void {
        if (!docId || !meta || !Array.isArray(meta.labels) || !meta.packages) { return; }
        this.updates[docId]=meta;
        if (this.value) { this.value={...this.value,[docId]:meta}; }
    }
    remove(docId:string):void {
        this.updates[docId]=null;
        if (this.value) { this.value={...this.value}; delete this.value[docId]; }
    }
    get(load:()=>Promise<ProjectMeta|undefined>):Promise<ProjectMeta|undefined> {
        if (this.value) { return Promise.resolve(this.value); }
        if (this.pending) { return this.pending; }
        const generation=this.generation;
        const task=load().then(value=>{
            if (generation!==this.generation || !value) { return undefined; }
            this.value={...value};
            for (const [id,meta] of Object.entries(this.updates)) {
                if (meta) { this.value[id]=meta; } else { delete this.value[id]; }
            }
            return this.value;
        }).finally(()=>{ if (this.pending===task) { this.pending=undefined; } });
        this.pending=task;
        return task;
    }
}
