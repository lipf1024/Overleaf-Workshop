import * as path from 'path';
import Mocha = require('mocha');

export function run():Promise<void> {
    const mocha=new Mocha({ui:'tdd',color:true});
    mocha.addFile(path.resolve(__dirname,'extension.test.js'));
    mocha.addFile(path.resolve(__dirname,'conflictEditor.test.js'));
    return new Promise((resolve,reject)=>mocha.run(failures=>failures?reject(new Error(`${failures} VS Code integration test(s) failed`)):resolve()));
}
