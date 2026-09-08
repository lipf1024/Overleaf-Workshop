import * as assert from 'assert';
import * as vscode from 'vscode';

suite('extension integration',()=>{
    test('extension manifest is discoverable',()=>{
        assert.ok(vscode.extensions.getExtension('lipf1024.overleaf-workshop'));
    });
});
