/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { isolatedModule } from '../helpers/isolatedModule';

suite('Project opening window choice',()=>{
    for (const local of [false,true]) {
        for (const choice of [undefined,false,true]) {
            test(`${local?'local':'remote'} opening respects window choice ${choice}`,async()=>{
                const calls:any[][]=[];
                const uri={scheme:'overleaf-workshop',toString:()=> 'remote-project'};
                const localUri={scheme:'file',fsPath:'/replica'};
                const vscode={TreeItem:class {},
                    Uri:{parse:()=>uri,file:()=>localUri},
                    window:{showQuickPick:async()=>choice===undefined?undefined:{newWindow:choice}},
                    workspace:{workspaceFolders:[]},
                    commands:{executeCommand:async(...args:any[])=>{calls.push(args);}},
                };
                const {ProjectManagerProvider}=isolatedModule('core/projectManagerProvider',{
                    vscode,'../consts':{ROOT_NAME:'overleaf-workshop'},
                    '../utils/globalStateManager':{GlobalStateManager:{getServerProjectSCMPersists:()=>({one:{label:'Local Replica',baseUri:'/replica'}})}},
                    './remoteFileSystemProvider':{parseUri:()=>({serverName:'server',projectId:'p'})},
                    '../scm/localReplicaSCM':{LocalReplicaSCMProvider:{label:'Local Replica',parsePersistedBaseUri:()=>localUri}},
                });
                const provider=Object.create(ProjectManagerProvider.prototype);
                provider.resolveProjectItem=async()=>({uri:'remote-project',label:'project'});
                if (local) { await provider.openProjectLocalReplica(); } else { await provider.openProjectRemotely(); }
                if (choice===undefined) { assert.deepStrictEqual(calls,[]); }
                else {
                    const open=calls.find(call=>call[0]==='vscode.openFolder');
                    assert.ok(open); assert.strictEqual(open[1],local?localUri:uri); assert.strictEqual(open[2],choice);
                }
            });
        }
    }
});
