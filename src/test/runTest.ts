import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main():Promise<void> {
    try {
        const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'overleaf-vscode-test-'));
        await runTests({
            vscodeExecutablePath:process.env.VSCODE_EXECUTABLE_PATH,
            version:process.env.VSCODE_TEST_VERSION,
            extensionDevelopmentPath:path.resolve(__dirname,'../..'),
            extensionTestsPath:path.resolve(__dirname,'suite/index'),
            launchArgs:[
                '--disable-extensions',
                '--enable-proposed-api=lipf1024.overleaf-workshop',
                '--user-data-dir='+path.join(sandbox,'user-data'),
                '--extensions-dir='+path.join(sandbox,'extensions'),
                '--skip-welcome',
                '--skip-release-notes',
                '--disable-workspace-trust',
            ],
        });
    } catch (error) {
        console.error('VS Code integration tests failed',error);
        process.exitCode=1;
    }
}

void main();
