import ignore = require('ignore');
import { LocalPathAccess } from './pathPolicy';
import * as fs from 'fs/promises';
import { constants } from 'fs';

export const IGNORE_FILE = '.overleafignore';
export const DEFAULT_IGNORE_PATTERNS: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

export function ignoreFileContents(patterns:readonly string[]):string {
    return '# Overleaf Local Replica sync exclusions (gitignore syntax).\n# This file stays local to Overleaf sync; it may be committed to Git.\n# Remove a rule to resume normal reconciliation; ignoring never deletes files.\n'+patterns.join('\n')+'\n';
}

/** Anchor and escape a literal selection, including glob characters and spaces. */
export function literalIgnorePattern(relative:string):string {
    if (!relative || relative.split('/').some(part=>!part || part==='.' || part==='..') || /[\r\n\\]/.test(relative)) {
        throw new Error('This path cannot be represented safely in .overleafignore');
    }
    return '/'+relative.replace(/([*?\[\]#! ])/g,'\\$1');
}

export class IgnoreFile {
    private matcher=ignore({ignorecase:false});
    private text?:string;
    constructor(private readonly access:LocalPathAccess) {}
    async initialize(patterns:readonly string[],create:boolean):Promise<void> {
        if (this.text===undefined) { this.matcher=ignore({ignorecase:false}).add(patterns); }
        if (create) {
            const checked=await this.access.check(IGNORE_FILE);
            try {
                const handle=await fs.open(checked.path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
                try { await this.access.verify(checked); await handle.writeFile(this.text??ignoreFileContents(patterns)); }
                finally { await handle.close(); }
            } catch (error:any) { if (error.code!=='EEXIST') { throw error; } }
        }
        await this.reload();
    }
    async reload():Promise<boolean> {
        const bytes=await this.access.read(IGNORE_FILE);
        // An accidental deletion must not suddenly publish previously ignored files.
        if (!bytes) { return false; }
        const text=Buffer.from(bytes).toString('utf8');
        if (text===this.text) { return false; }
        // node-ignore treats escaped question marks as wildcards; preserve gitignore literal semantics.
        this.matcher=ignore({ignorecase:false}).add(text.replace(/\\\?/g,'[\\x3f]')); this.text=text; return true;
    }
    isIgnored(value:string):boolean {
        if (value===IGNORE_FILE || value.startsWith(IGNORE_FILE+'/')) { return true; }
        return ignore.isPathValid(value) && this.matcher.ignores(value);
    }
}
