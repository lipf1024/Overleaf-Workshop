import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_IGNORE_PATTERNS, IGNORE_FILE, IgnoreFile, literalIgnorePattern } from '../../scm/localReplicaSync/ignoreFile';
import { LocalPathAccess, PathPolicy } from '../../scm/localReplicaSync/pathPolicy';

suite('Local replica ignore file',()=>{
    let root:string,access:LocalPathAccess,rules:IgnoreFile;
    setup(async()=>{ root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-ignore-')); access=new LocalPathAccess(root); rules=new IgnoreFile(access); });
    teardown(async()=>{ await fs.rm(root,{recursive:true,force:true}); });
    test('initializes defaults, excludes hidden descendants, and retains an existing file',async()=>{
        await rules.initialize(DEFAULT_IGNORE_PATTERNS,true);
        assert.ok(rules.isIgnored('.claude/settings.local.json'));
        assert.ok(rules.isIgnored('build/main.aux'));
        assert.ok(!rules.isIgnored('main.tex'));
        await fs.writeFile(path.join(root,IGNORE_FILE),'custom/\n');
        await rules.initialize(DEFAULT_IGNORE_PATTERNS,true);
        assert.ok(rules.isIgnored('custom/a.tex'));
        assert.ok(!rules.isIgnored('main.aux'));
        assert.strictEqual(await fs.readFile(path.join(root,IGNORE_FILE),'utf8'),'custom/\n');
    });
    test('supports comments, rooted patterns, directory rules and ordered exceptions',async()=>{
        await fs.writeFile(path.join(root,IGNORE_FILE),'# comment\n/root.tex\ncache/\n*.aux\n!keep.aux\n');
        await rules.initialize([],true);
        for (const name of ['root.tex','cache/a.tex','sub/cache/a.tex','sub/a.aux']) { assert.ok(rules.isIgnored(name),name); }
        for (const name of ['sub/root.tex','keep.aux','sub/keep.aux']) { assert.ok(!rules.isIgnored(name),name); }
        assert.ok(rules.isIgnored(IGNORE_FILE));
    });
    test('literal selections cannot accidentally match similarly named files',async()=>{
        const selected=['a[1] *.tex','folder with space','!special?.tex'];
        await fs.writeFile(path.join(root,IGNORE_FILE),selected.map(literalIgnorePattern).join('\n'));
        await rules.reload();
        for (const name of selected) { assert.ok(rules.isIgnored(name),name); }
        assert.ok(rules.isIgnored('folder with space/child.tex'));
        assert.ok(!rules.isIgnored('sub/a[1] *.tex'));
        assert.ok(!rules.isIgnored('a1 anything.tex'));
    });
    test('migration preserves custom exclusions; removing a rule allows reconciliation without deleting data',async()=>{
        await rules.initialize(['private/**'],true);
        await fs.mkdir(path.join(root,'private'));
        await fs.writeFile(path.join(root,'private/a.tex'),'retained');
        const policy=new PathPolicy(access,()=>[],value=>rules.isIgnored(value));
        assert.strictEqual((await policy.check('private/a.tex')).type,'ignored');
        await fs.writeFile(path.join(root,IGNORE_FILE),''); await rules.reload();
        assert.strictEqual((await policy.check('private/a.tex')).type,'allowed');
        assert.strictEqual(await fs.readFile(path.join(root,'private/a.tex'),'utf8'),'retained');
    });
    test('deletion retains last rules and recreation does not reset them to defaults',async()=>{
        await rules.initialize(['private/'],true);
        await fs.unlink(path.join(root,IGNORE_FILE)); await rules.reload();
        assert.ok(rules.isIgnored('private/key'));
        await rules.initialize(DEFAULT_IGNORE_PATTERNS,true);
        assert.ok(rules.isIgnored('private/key'));
    });
    test('never follows a symlink for initialization or reloading',async()=>{
        await fs.writeFile(path.join(root,'target'),'secret');
        await fs.symlink(path.join(root,'target'),path.join(root,IGNORE_FILE));
        await assert.rejects(()=>rules.initialize([],true));
        await assert.rejects(()=>rules.reload());
        assert.strictEqual(await fs.readFile(path.join(root,'target'),'utf8'),'secret');
    });
});
