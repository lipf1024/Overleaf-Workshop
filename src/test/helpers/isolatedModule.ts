import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';

/** Load the compiled production module without leaking mocked VS Code APIs into other suites. */
export function isolatedModule<T=any>(relative:string,mocks:Record<string,unknown>,timers:Record<string,unknown>={}):T {
    const filename=path.resolve(__dirname,'../..',relative+'.js');
    const nativeRequire=createRequire(filename),module={exports:{}};
    const factory=vm.runInThisContext('(function(require,module,exports,__filename,__dirname,setTimeout,clearTimeout){'+fs.readFileSync(filename,'utf8')+'\n})',{filename});
    factory((name:string)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:nativeRequire(name),module,module.exports,filename,path.dirname(filename),timers.setTimeout??setTimeout,timers.clearTimeout??clearTimeout);
    return module.exports as T;
}
