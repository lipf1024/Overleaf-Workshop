import * as DiffMatchPatch from 'diff-match-patch';

export interface TextComponent {p:number;i?:string;d?:string}
export type TextOperation=TextComponent[];
interface TextType {
    apply(text:string,op:TextOperation):string;
    compose(a:TextOperation,b:TextOperation):TextOperation;
    transformX(a:TextOperation,b:TextOperation):[TextOperation,TextOperation];
}
const official:TextType=require('./vendor/text');
// Upstream mismatch errors include document text. Keep it out of diagnostics/logs.
function checked<T>(action:()=>T):T {
    try { return action(); }
    catch { throw new Error('Text OT operation does not match its base; recovery required'); }
}
export const textOT:TextType={
    apply:(text,op)=>checked(()=>{
        validateOperation(op);
        let length=text.length;
        for (const c of op) {
            if (c.p>length || c.p+(c.d?.length??0)>length) { throw new Error('Invalid position'); }
            length+=(c.i?.length??0)-(c.d?.length??0);
        }
        return official.apply(text,op);
    }),
    compose:(a,b)=>checked(()=>official.compose(a,b)),
    transformX:(a,b)=>checked(()=>official.transformX(a,b)),
};

export function validateOperation(op:unknown):asserts op is TextOperation {
    if (!Array.isArray(op) || op.some(c=>!c || !Number.isSafeInteger(c.p) || c.p<0
        || (typeof c.i==='string')===(typeof c.d==='string')
        || (c.i!==undefined && typeof c.i!=='string') || (c.d!==undefined && typeof c.d!=='string')
        || Object.keys(c).some(key=>!['p','i','d','u'].includes(key)))) {
        throw new Error('Unsupported or invalid text operation; synchronization paused');
    }
}

/** Positions use JavaScript UTF-16 indices, as in the official text OT type. */
export function textDiff(before:string,after:string):TextOperation {
    let position=0;
    const op:TextOperation=[];
    for (const [kind,value] of new DiffMatchPatch().diff_main(before,after)) {
        if (kind===-1) { op.push({p:position,d:value}); }
        else { if (kind===1) { op.push({p:position,i:value}); } position+=value.length; }
    }
    return op;
}
