/** Merge a same-server Cookie header with all Set-Cookie values. Attributes never
 * belong in the request header. This is not a cross-domain browser cookie jar. */
export function mergeCookies(current:string,updates:string[],now=Date.now()):string {
    const values=new Map<string,string>();
    const pair=(text:string):[string,string]|undefined=>{
        const index=text.indexOf('=');
        if (index<=0 || /[\r\n]/.test(text)) { return; }
        return [text.slice(0,index).trim(),text.slice(index+1).trim()];
    };
    for (const part of current.split(';')) {
        const item=pair(part.trim()); if (item) { values.set(...item); }
    }
    for (const cookie of updates) {
        const [head,...attributes]=cookie.split(';'),item=pair(head.trim());
        if (!item) { continue; }
        const attrs=new Map(attributes.map(part=>pair(part.trim())).filter((p):p is [string,string]=>!!p).map(([k,v])=>[k.toLowerCase(),v]));
        const maxAge=attrs.get('max-age');
        const expired=maxAge!==undefined && /^-?\d+$/.test(maxAge)
            ? Number(maxAge)<=0 : Date.parse(attrs.get('expires')??'')<=now;
        if (expired) { values.delete(item[0]); } else { values.set(...item); }
    }
    return [...values].map(([name,value])=>`${name}=${value}`).join('; ');
}
