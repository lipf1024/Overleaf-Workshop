import * as vscode from 'vscode';
import { RemoteFileSystemProvider, parseUri } from '../core/remoteFileSystemProvider';
import { ROOT_NAME, ELEGANT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { LatexParser, ErrorSchema } from './compileLogParser';
import { EventBus } from '../utils/eventBus';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { NetworkRequestError } from '../api/network';
import { ProjectContext, projectKey, resolveProjectContext, sourceUriFor } from './projectContext';

// map string level to severity
const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

// Match the document class in the tex file
const documentClassRegex = new RegExp(/\\documentclass(?:\[[^\[\]\{\}]*\])?\{([^\[\]\{\}]+)\}/);

const pdfViewRecord: {
    [key: string]: {
        [key: string]: { doc: PdfDocument, webviewPanel: vscode.WebviewPanel }
    }
} = {};

class CompileDiagnosticProvider {
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(ROOT_NAME);
    private readonly projectDiagnostics=new Map<string,vscode.Uri[]>();
    constructor(private readonly vfsm: RemoteFileSystemProvider) {};

    clearProject(context:ProjectContext):void {
        for (const uri of this.projectDiagnostics.get(context.key)??[]) { this.diagnosticCollection.delete(uri); }
        this.projectDiagnostics.delete(context.key);
    }

    private async getRange(log: ErrorSchema, path: string, context:ProjectContext) {
        let textDoc: vscode.TextDocument;
        try {
            textDoc = (await vscode.workspace.openTextDocument(sourceUriFor(context,path)));
        }
        catch (error) {
            return null;
        }
        if (log.line !== null) {
            const _range = new vscode.Range(
                new vscode.Position(log.line - 1, 0),
                new vscode.Position(log.line, 0),
            );
            const lineContent = textDoc.getText(_range);
            const lineMatch = lineContent.match(/^\s*(.*?)\s*$/)?.[1] || '';
            const lineStart = lineContent.indexOf(lineMatch);
            const lineEnd = lineStart + lineMatch.length;
            return new vscode.Range(
                new vscode.Position(log.line - 1, lineStart),
                new vscode.Position(log.line - 1, lineEnd),
            );
        }
        else {
            return new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(1, 0),
            );
        }
    }
    private validatePath(path: string) {
        const outputRegex = new RegExp(/\.\/(output.(aux|bbl|toc|lof|lot|bbl|bst|ttt|fff))\b/);
        const match = outputRegex.exec(path);
        if (match) {
            return path.replace(match[0], `${OUTPUT_FOLDER_NAME}/${match[1]}`);
        }
        return path;
    }

    private async updateDiagnostics(input:vscode.Uri|ProjectContext) {
        const context='remoteRoot' in input?input:await resolveProjectContext(input);
        if (!context) { return false; }
        this.clearProject(context);
        const updated:vscode.Uri[]=[];
        const vfs = await this.vfsm.prefetch(context.remoteRoot);
        const logPath = `${OUTPUT_FOLDER_NAME}/output.log`;
        const _uri = vfs.pathToUri(logPath);
        let content ='';
        content = new TextDecoder().decode(await vfs.openFile(_uri));
        const logs = new LatexParser(content).parse();
        if (logs === undefined) {
            return content === ''? true :false;
        }
        let hasError = false;
        const diagnosticsRecorder: { [key: string]: vscode.Diagnostic[] } = {};
        for (const log of logs.all) {
            if (!log.file.startsWith('./')) { continue; }
            const path = this.validatePath(log.file);
            const range = await this.getRange(log, path, context);
            if (range === null) {
                continue;
            }
            if (!diagnosticsRecorder[path]) {
                diagnosticsRecorder[path] = [];
            }
            const diagnostic = new vscode.Diagnostic(range, log.message, severityMap[log.level]);
            diagnostic.source = vscode.l10n.t('Compile Checker');
            diagnosticsRecorder[path].push(diagnostic);

            if (log.level === 'error') {
                hasError = true;
            }
        }
        for (const file in diagnosticsRecorder) {
            const diagnostics = diagnosticsRecorder[file];
            const _uri = sourceUriFor(context,file);
            this.diagnosticCollection.set(_uri, diagnostics); updated.push(_uri);
        }
        this.projectDiagnostics.set(context.key,updated);
        return hasError;
    }

    get triggers() {
        return [
            this.diagnosticCollection,
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, async (uri) => {
                return await this.updateDiagnostics(uri);
            }),
        ];
    }
}

export class CompileManager {
    readonly status: vscode.StatusBarItem;
    public inCompiling: boolean = false;
    private diagnosticProvider: CompileDiagnosticProvider;
    private activeRun?:{cancelled:boolean;controller:AbortController;context?:ProjectContext;vfs?:import('../core/remoteFileSystemProvider').VirtualFileSystem};
    private queuedCompile?:{force:boolean;requestedUri?:vscode.Uri;sources:vscode.Uri[]};
    private readonly autoCompilePaused=new Set<string>();
    private pdfListener:vscode.Disposable;
    private compileAsDraft: boolean = false;
    private compileStopOnFirstError: boolean = false;
    private readonly previewStates=new Map<string,{busy:boolean;message:string}>();

    private previewState(context:ProjectContext|undefined,busy:boolean,message=''):void {
        if (!context) { return; }
        this.previewStates.set(context.key,{busy,message});
        for (const record of Object.values(pdfViewRecord[context.key]??{})) { record.doc.setCompileState(busy,message); }
    }

    constructor(
        private vfsm: RemoteFileSystemProvider,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        // listen pdf open event
        this.pdfListener=EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
            const {pathParts} = parseUri(uri);
            const identifier=projectKey(uri);
            const state=this.previewStates.get(identifier);
            if (state) { doc.setCompileState(state.busy,state.message); }
            const filePath = pathParts.join('/');
            if (pdfViewRecord[identifier]) {
                pdfViewRecord[identifier][filePath] = {doc, webviewPanel};
            } else {
                pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel}};
            }
            webviewPanel.onDidDispose(()=>{ if (pdfViewRecord[identifier]?.[filePath]?.doc===doc) { delete pdfViewRecord[identifier][filePath]; } });
        });
    }

    static async check(uri?:vscode.Uri):Promise<vscode.Uri|undefined> {
        const context=await resolveProjectContext(uri);
        return context?.remoteSource??context?.remoteRoot;
    }

    async update(status:'success'|'compiling'|'failed'|'alert',context?:ProjectContext):Promise<vscode.Uri|undefined> {
        context??=await resolveProjectContext();
        if (!context) { this.status.hide(); return; }
        let rootDocName='',compilerName='';
        try { const vfs=await this.vfsm.prefetch(context.remoteRoot); rootDocName=vfs.getRootDocName().slice(1); compilerName=vfs.getCompiler()?.name||''; } catch { /* render failure even if connection metadata is unavailable */ }
        const labels={success:'Compile Success',compiling:'Compiling',failed:'Compile Failed',alert:'Not Connected'};
        this.status.text=status==='compiling'?`${compilerName} $(sync~spin)`:status==='failed'?`${compilerName} $(x)`:status==='alert'?'$(alert)':compilerName;
        this.status.backgroundColor=status==='failed'?new vscode.ThemeColor('statusBarItem.errorBackground'):status==='alert'?new vscode.ThemeColor('statusBarItem.warningBackground'):undefined;
        this.status.tooltip=new vscode.MarkdownString(`\`${rootDocName}\` **${vscode.l10n.t(labels[status])}**`);
        this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage compile settings.')}*`);
        this.status.show(); return context.remoteRoot;
    }

    async compile(force=false,requestedUri?:vscode.Uri,additionalSources:readonly vscode.Uri[]=[]):Promise<void> {
        const source=requestedUri??vscode.window.activeTextEditor?.document.uri;
        if (this.inCompiling) {
            this.queuedCompile={force:force||this.queuedCompile?.force===true,requestedUri:source??this.queuedCompile?.requestedUri,
                sources:[...new Map([...(this.queuedCompile?.sources??[]),...additionalSources,...(source?[source]:[])].map(uri=>[uri.toString(),uri])).values()]};
            return;
        }
        this.inCompiling=true;
        const run:{cancelled:boolean;controller:AbortController;context?:ProjectContext;vfs?:import('../core/remoteFileSystemProvider').VirtualFileSystem}={cancelled:false,controller:new AbortController()};
        this.activeRun=run;
        let completionMessage='Compilation paused; keeping the previous PDF';
        try {
            const context=await resolveProjectContext(source); run.context=context;
            if (!context || run.cancelled) { return; }
            if (!force && this.autoCompilePaused.has(context.key)) {
                completionMessage='Automatic compilation is paused by the server; run a manual compile to resume';
                return;
            }
            // Recheck queued automatic work: its preview may have closed meanwhile.
            if (!force && !Object.keys(pdfViewRecord[context.key]??{}).length) { return; }
            this.previewState(context,true,'Syncing saved changes…');
            const syncingStarted=Date.now();
            const vfs=await this.vfsm.prefetch(context.remoteRoot); run.vfs=vfs;
            const savedUris:vscode.Uri[]=[];
            const remoteUris:vscode.Uri[]=[];
            const include=async(uri:vscode.Uri)=>{
                const owner=await resolveProjectContext(uri);
                if (owner?.key!==context.key || !owner.relativePath || owner.relativePath.startsWith(OUTPUT_FOLDER_NAME+'/')) { return; }
                if (owner.sourceUri) { savedUris.push(owner.sourceUri); }
                if (owner.remoteSource) { remoteUris.push(owner.remoteSource); }
            };
            for (const uri of [source,...additionalSources]) { if (uri) { await include(uri); } }
            // A compile launched from the PDF or project root still checks the main source.
            if (!savedUris.length) { await include(sourceUriFor(context,vfs.getRootDocName().replace(/^\//,''))); }
            const dirty=vscode.workspace.textDocuments.filter(document=>document.isDirty);
            for (const document of dirty) {
                const owner=await resolveProjectContext(document.uri);
                if (owner?.key===context.key) {
                    await include(document.uri);
                    if (!await document.save()) {
                        completionMessage='Compilation paused: a project file could not be saved; keeping the previous PDF';
                        void vscode.window.showWarningMessage(completionMessage); return;
                    }
                }
            }
            if (run.cancelled || !await LocalReplicaSCMProvider.prepareForCompile(context.localRoot??context.sourceUri,savedUris,
                message=>{completionMessage=message+' Keeping the previous PDF.';})) { return; }
            await vfs.waitForSavedText(remoteUris);
            vfs.logSyncStage('compile-wait',Date.now()-syncingStarted);
            await this.update('compiling',context);
            this.previewState(context,true,'Compiling PDF…');
            let rootDocId:string|undefined;
            if (context.remoteSource && context.relativePath && !context.relativePath.startsWith(OUTPUT_FOLDER_NAME+'/')) {
                const content=new TextDecoder().decode(await vfs.openFile(context.remoteSource));
                if (documentClassRegex.test(content)) { rootDocId=(await vfs._resolveUri(context.remoteSource)).fileId; }
            }
            if (run.cancelled) { return; }
            if (!force && !Object.keys(pdfViewRecord[context.key]??{}).length) { completionMessage=''; return; }
            const result=await vfs.compile(force,this.compileAsDraft,this.compileStopOnFirstError,rootDocId,run.controller.signal);
            if (run.cancelled || this.activeRun!==run) { return; }
            if (result!==undefined) { this.diagnosticProvider.clearProject(context); }
            if (result===true) {
                if (force) { this.autoCompilePaused.delete(context.key); }
                this.previewState(context,true,'Downloading PDF…');
                let hasError=false;
                try {
                    await Promise.all(Object.values(pdfViewRecord[context.key]??{}).map(record=>record.doc.refresh()));
                } finally {
                    // A PDF download failure must not hide this build's diagnostic output.
                    if (!run.cancelled && this.activeRun===run && vfs.lastCompileHasLog!==false) {
                        hasError=!!await vscode.commands.executeCommand<boolean>(`${ROOT_NAME}.compileManager.compileErrorCheck`,context);
                    }
                }
                if (run.cancelled || this.activeRun!==run) { return; }
                await this.update(hasError?'failed':'success',context);
                completionMessage=hasError?'Compilation has errors; see the Problems panel':'';
            } else {
                if (result===false && vfs.lastCompileHasLog) {
                    await vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`,context);
                }
                if (run.cancelled || this.activeRun!==run) { return; }
                const status=vfs.lastCompileStatus;
                if (status==='autocompile-backoff') { this.autoCompilePaused.add(context.key); }
                // Keys are server protocol status values.
                /* eslint-disable @typescript-eslint/naming-convention */
                const messages:Record<string,string>={
                    'stopped-on-first-error':'Compilation stopped at the first error; see the Problems panel',
                    'timedout':'Server compilation timed out',
                    'autocompile-backoff':'Automatic compilation paused by the server; run a manual compile to resume',
                    'too-recently-compiled':'The project was compiled too recently; retry shortly',
                    'compile-in-progress':'The server is already compiling this project',
                    'clsi-maintenance':'The compilation service is under maintenance',
                    'project-too-large':'The project exceeds the compilation size limit',
                    'rate-limited':'Compilation rate limit reached; retry later',
                    'terminated':'Compilation was terminated',
                    'validation-problems':'Check the main document and project compile settings',
                };
                /* eslint-enable @typescript-eslint/naming-convention */
                completionMessage=result===undefined?'':`${messages[status??'']??'Compilation failed'}; keeping the previous PDF`;
                if (status==='autocompile-backoff' || status==='too-recently-compiled') { this.queuedCompile=undefined; }
                await this.update(result===false?'failed':result===undefined?'success':'alert',context);
            }
        } catch (error) {
            completionMessage='Compilation or PDF download failed; keeping the previous PDF';
            if (error instanceof NetworkRequestError && error.kind==='unknown-outcome') {
                this.queuedCompile=undefined;
                completionMessage='Compile result unknown; the server may still be compiling. Check its status before retrying.';
            }
            if (!run.cancelled) {
                await this.update('failed',run.context).catch(()=>undefined);
                void vscode.window.showErrorMessage('Overleaf compilation failed: '+(error instanceof Error?error.message:String(error)));
            }
        } finally {
            if (this.activeRun===run) {
                this.previewState(run.context,false,completionMessage);
                this.activeRun=undefined; this.inCompiling=false;
                const queued=run.cancelled?undefined:this.queuedCompile;
                this.queuedCompile=undefined;
                if (queued) { await this.compile(queued.force,queued.requestedUri,queued.sources); }
            }
        }
    }

    async stopCompile():Promise<void> {
        this.queuedCompile=undefined;
        const run=this.activeRun; if (!run) { return; }
        run.cancelled=true; run.controller.abort();
        this.previewState(run.context,false,'Compilation stopped');
        try { if (run.vfs) { await run.vfs.stopCompile(); } }
        finally {
            if (this.activeRun===run) { this.activeRun=undefined; this.inCompiling=false; await this.update('failed',run.context); }
        }
    }

    private async openProjectPdf(context:ProjectContext):Promise<void> {
        const pdfUri=vscode.Uri.joinPath(context.remoteRoot,OUTPUT_FOLDER_NAME,'output.pdf');
        await vscode.commands.executeCommand('vscode.openWith',pdfUri,`${ROOT_NAME}.pdfViewer`,{preview:false,viewColumn:vscode.ViewColumn.Beside});
    }
    async openPdf():Promise<void> { const context=await resolveProjectContext(); if (context) { await this.openProjectPdf(context); } }

    async syncCode():Promise<void> {
        const editor=vscode.window.activeTextEditor;
        if (!editor) { return; }
        const start=editor.selection.start,source=editor.document.uri;
        const context=await resolveProjectContext(source);
        if (!context?.relativePath) { return; }
        const vfs=await this.vfsm.prefetch(context.remoteRoot);
        const result=await vfs.syncCode(context.relativePath,start.line+1,start.character);
        if (!result) { return; }
        const pdfPath=`${OUTPUT_FOLDER_NAME}/output.pdf`;
        if (!pdfViewRecord[context.key]?.[pdfPath]) { await this.openProjectPdf(context); }
        await pdfViewRecord[context.key]?.[pdfPath]?.webviewPanel.webview.postMessage({type:'syncCode',content:result});
    }

    private _revealSelectionInEditor(editor: vscode.TextEditor, targetLine: number, identifier: string) {
        const _identifier = identifier.replace(/\s+/g, '\\s+');
        // targetLine is 1-based from the syncTeX result
        const lineIndex = targetLine - 1;

        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
            console.warn(`${ELEGANT_NAME}: Invalid line number ${targetLine} for revealing in editor. Document has ${editor.document.lineCount} lines.`);
            // Optionally, just focus the editor if the line is invalid
            vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
            return;
        }

        const lineText = editor.document.lineAt(lineIndex).text;
        const match = lineText.match(_identifier);
        const matchIndex = match?.index ?? 0;

        let newSelections: vscode.Selection[];
        const newSelection = new vscode.Selection(lineIndex, matchIndex, lineIndex, matchIndex);
        if (editor.selections.length > 0) {
            newSelections = editor.selections.map((sel, index) =>
                index === 0 ? newSelection : sel
            );
        } else {
            newSelections = [newSelection];
        }
        editor.selections = newSelections;

        editor.revealRange(new vscode.Range(lineIndex, matchIndex, lineIndex, matchIndex), vscode.TextEditorRevealType.InCenter);
    }

    async syncPdf(r:{page:number;h:number;v:number;identifier:string;pdfUri?:string}):Promise<void> {
        try {
            const context=await resolveProjectContext(r.pdfUri?vscode.Uri.parse(r.pdfUri):undefined);
            if (!context) { return; }
            const vfs=await this.vfsm.prefetch(context.remoteRoot),result=await vfs.syncPdf(r.page,r.h,r.v);
            if (!result) { return; }
            const file=/^output\.[^.]+$/.test(result.file)?`${OUTPUT_FOLDER_NAME}/${result.file}`:result.file;
            const fileUri=sourceUriFor(context,file);
            const existing=vscode.window.visibleTextEditors.find(editor=>editor.document.uri.toString()===fileUri.toString());
            const editor=await vscode.window.showTextDocument(fileUri,{viewColumn:existing?.viewColumn??vscode.ViewColumn.Beside,preserveFocus:false});
            this._revealSelectionInEditor(editor,result.line,r.identifier??'');
        } catch (error) { console.error(`${ELEGANT_NAME}: PDF source navigation failed`,error); }
    }

    async setCompiler(requestedUri?:vscode.Uri) {
        const uri = await CompileManager.check(requestedUri);
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const compilers = vfs?.getAllCompilers();
        compilers && vscode.window.showQuickPick(compilers.map((item) => {
            return {
                label: item.name,
                description: item.code,
                picked: item.code === currentCompiler?.code,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Compiler'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ compiler: option.description }) && this.compile(true,uri);
        });
    }

    async setRootDoc(requestedUri?:vscode.Uri) {
        const uri = await CompileManager.check(requestedUri);
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentRootDoc = vfs?.getRootDocName();
        const rootDocs = vfs?.getValidMainDocs();
        rootDocs && vscode.window.showQuickPick(rootDocs.map((item) => {
            return {
                id: item.entity._id,
                label: item.path,
                picked: item.path === currentRootDoc,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Main Document'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ rootDocId: option.id }) && this.compile(true,uri);
        });
    }

    async compileSettings() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const currentRootDoc = vfs?.getRootDocName();

        const currentDraftMode = this.compileAsDraft ? vscode.l10n.t('Draft Mode') : vscode.l10n.t('Normal Mode');
        const currentStopOnError = this.compileStopOnFirstError ? vscode.l10n.t('Stop on first error') : vscode.l10n.t('Try to compile despite errors');
        const settingItems = [
            {label: vscode.l10n.t('Compile Mode'), description: currentDraftMode},
            {label: vscode.l10n.t('Compile Error Handling'), description: currentStopOnError},
            {label: '', kind: vscode.QuickPickItemKind.Separator},
            {label: vscode.l10n.t('Setting: Compiler'), description: currentCompiler?.name, },
            {label: vscode.l10n.t('Setting: Main Document'), description: currentRootDoc, },
        ];
        if (this.inCompiling) {
            settingItems.unshift({label: vscode.l10n.t('Stop compilation'), description: undefined});
        }

        const setting = await vscode.window.showQuickPick(settingItems);
        switch (setting?.label) {
            case vscode.l10n.t('Setting: Compiler'):
                await this.setCompiler(uri);
                break;
            case vscode.l10n.t('Setting: Main Document'):
                await this.setRootDoc(uri);
                break;
            case vscode.l10n.t('Stop compilation'):
                this.stopCompile();
                break;
            case vscode.l10n.t('Compile Mode'): {
                const mode=await vscode.window.showQuickPick([
                    {label:vscode.l10n.t('Normal Mode'),description:'Include images',draft:false},
                    {label:vscode.l10n.t('Draft Mode'),description:'Skip image processing for faster compilation',draft:true},
                ],{title:vscode.l10n.t('Compile Mode'),placeHolder:'Select a mode and recompile'});
                if (mode) {
                    this.compileAsDraft=mode.draft;
                    await this.compile(true,uri);
                }
                break;
            }
            case vscode.l10n.t('Compile Error Handling'):
                this.compileStopOnFirstError = !this.compileStopOnFirstError;
                await this.compileSettings();
                break;
            default:
                break;
        }
    }

    get triggers() {
        return [
            // register status bar
            this.status,this.pdfListener,new vscode.Disposable(()=>{
                this.queuedCompile=undefined;
                if (this.activeRun) { this.activeRun.cancelled=true; this.activeRun.controller.abort(); }
                this.previewState(this.activeRun?.context,false);
            }),
            // register compile commands
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compile`, (uri?:vscode.Uri) => this.compile(true,uri instanceof vscode.Uri?uri:undefined)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.viewPdf`, () =>  this.openPdf()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncCode`, () => this.syncCode()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncPdf`, (r) => this.syncPdf(r)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compilerManager.settings`, ()=> this.compileSettings()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setCompiler`, () => this.setCompiler()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setRootDoc`, () => this.setRootDoc()),
            // register compile conditions
            vscode.workspace.onDidSaveTextDocument(async (e) => {
                const context=await resolveProjectContext(e.uri);
                const compileCondition = vscode.workspace.getConfiguration(`${ROOT_NAME}.compileOnSave`).get('enabled', true);
                const postfixCondition = e.fileName.match(/\.tex$|\.sty$|\.cls$|\.bib$/i);
                if (!compileCondition || !postfixCondition || !context
                    || !Object.keys(pdfViewRecord[context.key]??{}).length) { return; }
                await this.compile(false,e.uri);
            }),
            EventBus.on('compilerUpdateEvent', ({uri}) => { void this.compile(true,uri); }),
            EventBus.on('rootDocUpdateEvent', ({uri}) => { void this.compile(true,uri); }),
            // register diagnostics triggers
            ...this.diagnosticProvider.triggers,
        ];
    }
}
