import * as assert from 'assert';
import { reconcile } from '../../scm/localReplicaSync/reconciler';

const b=(value:string)=>new TextEncoder().encode(value);

suite('Local replica reconciler',()=>{
    test('establishes a base when both sides match',()=>assert.strictEqual(reconcile({local:b('x'),remote:b('x'),kind:'text',mode:'safeAuto',cause:'bootstrap'}).action,'establish-base'));
    test('never auto uploads local-only content during bootstrap',()=>assert.strictEqual(reconcile({local:b('x'),kind:'text',mode:'safeAuto',cause:'bootstrap'}).action,'pending-upload'));
    test('uploads only local changes',()=>assert.strictEqual(reconcile({base:b('a'),local:b('b'),remote:b('a'),kind:'text',mode:'safeAuto',cause:'local'}).action,'upload'));
    test('downloads only remote changes',()=>assert.strictEqual(reconcile({base:b('a'),local:b('a'),remote:b('b'),kind:'text',mode:'safeAuto',cause:'remote'}).action,'download'));
    test('freezes delete-modify conflict',()=>assert.strictEqual(reconcile({base:b('a'),local:undefined,remote:b('b'),kind:'text',mode:'safeAuto',cause:'local'}).action,'conflict'));
    test('manual mode only records pending work',()=>{
        assert.strictEqual(reconcile({base:b('a'),local:b('b'),remote:b('a'),kind:'text',mode:'manual',cause:'local'}).action,'pending-upload');
        assert.strictEqual(reconcile({base:b('a'),local:b('a'),remote:b('b'),kind:'text',mode:'manual',cause:'remote'}).action,'pending-download');
    });
    test('binary concurrent changes freeze',()=>assert.strictEqual(reconcile({base:b('a'),local:b('b'),remote:b('c'),kind:'binary',mode:'safeAuto',cause:'remote'}).action,'conflict'));
    test('synchronizes an uncontested local deletion',()=>assert.strictEqual(reconcile({base:b('a'),local:undefined,remote:b('a'),kind:'text',mode:'safeAuto',cause:'local'}).action,'delete-remote'));
    test('synchronizes an uncontested remote deletion',()=>assert.strictEqual(reconcile({base:b('a'),local:b('a'),remote:undefined,kind:'text',mode:'safeAuto',cause:'remote'}).action,'delete-local'));
    test('accepts both sides deleted',()=>assert.strictEqual(reconcile({base:b('a'),local:undefined,remote:undefined,kind:'text',mode:'safeAuto',cause:'remote'}).action,'none'));
    test('freezes first association with different same-name content',()=>assert.strictEqual(reconcile({local:b('a'),remote:b('b'),kind:'text',mode:'safeAuto',cause:'bootstrap'}).action,'conflict'));
});
