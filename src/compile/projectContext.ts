import * as vscode from 'vscode';
import * as path from 'path';
import { ROOT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { parseUri } from '../core/remoteFileSystemProvider';
import { LocalPathAccess } from '../scm/localReplicaSync/pathPolicy';
import { isInternalReplicaPath, validateReplicaPath } from '../scm/localReplicaSync/pathSafety';

export interface ProjectContext {
    key:string;
    remoteRoot:vscode.Uri;
    remoteSource?:vscode.Uri;
    localRoot?:vscode.Uri;
    sourceUri?:vscode.Uri;
    relativePath?:string;
}
export function localCompilePreviewSetting(root:vscode.Uri,legacyValue?:boolean):{enabled:boolean;explicit:boolean} {
    const configuration=vscode.workspace.getConfiguration('overleaf-workshop.localReplica',root);
    const inspected=configuration.inspect?.<boolean>('enableCompileNPreview');
    const explicit=inspected!==undefined && [inspected.globalValue,inspected.workspaceValue,inspected.workspaceFolderValue].some(value=>value!==undefined);
    return {enabled:explicit?configuration.get<boolean>('enableCompileNPreview',false):legacyValue===true,explicit};
}
export function projectKey(uri:vscode.Uri):string {
    const value=parseUri(uri);
    return `${value.serverName}\0${value.userId}\0${value.projectId}`;
}
export function sourceUriFor(context:ProjectContext,relative:string):vscode.Uri {
    const value=relative.replace(/\\/g,'/').replace(/^(\.\/)+/,'');
    if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some(part=>!part || part==='.' || part==='..' || /[\0-\x1f]/.test(part))) {
        throw new Error('Invalid project source path: '+relative);
    }
    const generated=value===OUTPUT_FOLDER_NAME || value.startsWith(OUTPUT_FOLDER_NAME+'/');
    return vscode.Uri.joinPath(generated?context.remoteRoot:(context.localRoot??context.remoteRoot),value);
}

export async function resolveProjectContext(requested?:vscode.Uri):Promise<ProjectContext|undefined> {
    const uri=requested??vscode.window.activeTextEditor?.document.uri??vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!uri) { return; }
    const folders=(vscode.workspace.workspaceFolders??[]).filter(folder=>folder.uri.scheme==='file');
    const localSettings:Array<{root:vscode.Uri;remote:vscode.Uri}>=[];
    for (const folder of folders) {
        try {
            const bytes=await new LocalPathAccess(folder.uri.fsPath).read('.overleaf/settings.json',true);
            if (!bytes) { continue; }
            const settings=JSON.parse(Buffer.from(bytes).toString('utf8'));
            if (!settings.uri || !localCompilePreviewSetting(folder.uri,settings.enableCompileNPreview).enabled) { continue; }
            const remote=vscode.Uri.parse(settings.uri);
            if (remote.scheme===ROOT_NAME) { localSettings.push({root:folder.uri,remote}); }
        } catch { /* unrelated workspace folder */ }
    }
    if (uri.scheme==='file') {
        const candidates=localSettings.filter(item=>uri.fsPath===item.root.fsPath || uri.fsPath.startsWith(item.root.fsPath+path.sep)).sort((a,b)=>b.root.fsPath.length-a.root.fsPath.length);
        const local=candidates[0]; if (!local) { return; }
        const relative=path.relative(local.root.fsPath,uri.fsPath).split(path.sep).join('/');
        if (relative && (isInternalReplicaPath(relative) || validateReplicaPath(relative))) { return; }
        const remoteRoot=local.remote.with({path:'/'+parseUri(local.remote).projectName});
        return {key:projectKey(remoteRoot),remoteRoot,localRoot:local.root,sourceUri:relative?uri:undefined,relativePath:relative||undefined,
            remoteSource:relative?vscode.Uri.joinPath(remoteRoot,relative):undefined};
    }
    if (uri.scheme!==ROOT_NAME) { return; }
    const parsed=parseUri(uri),remoteRoot=uri.with({path:'/'+parsed.projectName}),key=projectKey(uri);
    const local=localSettings.find(item=>projectKey(item.remote)===key);
    const relative=parsed.pathParts.join('/');
    return {key,remoteRoot,localRoot:local?.root,relativePath:relative||undefined,remoteSource:relative?uri:undefined,
        sourceUri:relative?(local?vscode.Uri.joinPath(local.root,relative):uri):undefined};
}
