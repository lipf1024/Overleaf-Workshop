import * as vscode from 'vscode';
import { ROOT_NAME, ELEGANT_NAME } from './consts';

import { RemoteFileSystemProvider, VirtualFileSystem } from './core/remoteFileSystemProvider';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { CompileManager } from './compile/compileManager';
import { LangIntellisenseProvider } from './intellisense';
import { LocalReplicaSCMProvider } from './scm/localReplicaSCM';
import { localCompilePreviewSetting } from './compile/projectContext';

export function activate(context: vscode.ExtensionContext) {
    // Commands and title-bar actions must exist even while the remote project is
    // still connecting. The provider becomes available once initialization ends.
    context.subscriptions.push(LocalReplicaSCMProvider.acquireCommands());

    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context,remoteFileSystemProvider);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    const folders=()=>vscode.workspace.workspaceFolders??[];
    const refreshLocalCompileContext=async()=>{
        const entries=await Promise.all(folders().map(async folder=>({folder,setting:await LocalReplicaSCMProvider.readSettings(folder.uri)})));
        const enabled=entries.some(({folder,setting})=>!!setting?.uri && localCompilePreviewSetting(folder.uri,setting.enableCompileNPreview).enabled);
        await vscode.commands.executeCommand('setContext',`${ROOT_NAME}.activateCompile`,enabled);
    };
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{
        if (event.affectsConfiguration(`${ROOT_NAME}.localReplica.enableCompileNPreview`)) {
            void refreshLocalCompileContext().catch(error=>console.error('Overleaf local compile setting refresh failed',error));
        }
    }));

    // activate vfs for local replica
    void (async()=>{
        const entries=await Promise.all(folders().map(async folder=>({folder,setting:await LocalReplicaSCMProvider.readSettings(folder.uri)})));
        for (const {folder,setting} of entries) {
            if (!setting?.uri || typeof setting.enableCompileNPreview!=='boolean') { continue; }
            const resolved=localCompilePreviewSetting(folder.uri,setting.enableCompileNPreview);
            if (!resolved.explicit) {
                try {
                    await vscode.workspace.getConfiguration(`${ROOT_NAME}.localReplica`,folder.uri)
                        .update('enableCompileNPreview',setting.enableCompileNPreview,vscode.ConfigurationTarget.WorkspaceFolder);
                } catch (error) { console.warn('Could not migrate the legacy local compile setting',error); }
            }
        }
        const settings=entries.map(entry=>entry.setting);
        await vscode.commands.executeCommand('setContext',`${ROOT_NAME}.localReplicaWorkspace`,settings.some(setting=>!!setting?.uri));
        await Promise.all(settings.filter(setting=>setting?.uri).map(async setting=>{
            const uri=vscode.Uri.parse(setting.uri);
            if (uri.scheme!==ROOT_NAME) { return; }
            const vfs=await vscode.commands.executeCommand<VirtualFileSystem>('remoteFileSystem.prefetch',uri);
            await vfs?.init();
            await vscode.commands.executeCommand('setContext',`${ROOT_NAME}.activate`,true);
        }));
        await refreshLocalCompileContext();
    })().catch(error=>console.error('Overleaf local replica activation failed',error));
}

export async function deactivate() {
    await LocalReplicaSCMProvider.shutdownAll();
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.localReplicaWorkspace`, false);
}
