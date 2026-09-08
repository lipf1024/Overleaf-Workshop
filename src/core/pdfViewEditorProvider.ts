import * as vscode from 'vscode';
import { ROOT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import type { RemoteFileSystemProvider } from './remoteFileSystemProvider';
import type { PdfByteSource, PdfSourceDescriptor } from '../api/pdfByteSource';

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    source?:PdfByteSource;
    sourceId=0;
    private displayedSourceId?:number;
    private readonly sources=new Map<number,PdfByteSource>();
    getSource(id:number):PdfByteSource|undefined { return this.sources.get(id); }
    sourceLoaded(id:number):void {
        if (id!==this.sourceId) { return; }
        this.displayedSourceId=id;
        this.releaseOldSources();
    }
    private releaseOldSources():void {
        for (const [id,source] of this.sources) {
            if (id!==this.sourceId && id!==this.displayedSourceId) { source.dispose();this.sources.delete(id); }
        }
    }
    private sourceKey?:string;
    private refreshTask?:Promise<Uint8Array>;
    private readonly lifetime=new AbortController();
    compileState={busy:false,message:''};
    private readonly _onStatus=new vscode.EventEmitter<void>();
    readonly onStatus=this._onStatus.event;
    setCompileState(busy:boolean,message=''):void {
        this.compileState={busy,message}; this._onStatus.fire();
    }

    private readonly _onDidChange = new vscode.EventEmitter<{}>();
    readonly onDidChange = this._onDidChange.event;

    constructor(readonly uri: vscode.Uri,private readonly describe?:()=>Promise<PdfSourceDescriptor>) {
        if (uri.scheme !== ROOT_NAME) {
            throw new Error(`Invalid uri scheme: ${uri}`);
        }
        this.uri = uri;
    }

    dispose() { this.lifetime.abort();for (const source of this.sources.values()) { source.dispose(); }this.sources.clear();this._onStatus.dispose();this._onDidChange.dispose(); }

    refresh():Promise<Uint8Array> {
        if (this.refreshTask) { return this.refreshTask; }
        const task=this.refreshImpl().finally(()=>{ if (this.refreshTask===task) { this.refreshTask=undefined; } });
        this.refreshTask=task;return task;
    }

    private async refreshImpl(): Promise<Uint8Array> {
        if (this.describe) {
            const descriptor=await this.describe();
            if (this.sourceKey===descriptor.key && this.source && !this.source.isDisposed) { return this.cache; }
            const source=await descriptor.open(this.lifetime.signal);
            if (this.lifetime.signal.aborted) { source.dispose();throw new Error('PDF preview closed'); }
            this.source=source;this.sourceKey=descriptor.key;this.sourceId++;
            this.sources.set(this.sourceId,source);
            this.releaseOldSources();
            this.cache=source.initialData;
            this._onDidChange.fire({});
        } else {
            const content=new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
            if (!content.length) { throw new Error('Downloaded PDF is empty'); }
            this.cache=content;
            this._onDidChange.fire({});
        }
        return this.cache;
    }

}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context:vscode.ExtensionContext,private readonly vfsm?:RemoteFileSystemProvider) {
        this.context = context;
    }

    public saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public revertCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public backupCustomDocument(document: PdfDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
        return Promise.resolve({id: '', delete: () => {}});
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
        const doc = new PdfDocument(uri,this.vfsm?async()=> (await this.vfsm!.prefetch(uri)).describePdf(uri):undefined);
        try {
            await doc.refresh();
        } catch (error) {
            // Restored previews can open before the first build creates the virtual output folder.
            const isCompileOutput=uri.path.endsWith(`/${OUTPUT_FOLDER_NAME}/output.pdf`);
            if (!isCompileOutput || !(error instanceof vscode.FileSystemError) || error.code!=='FileNotFound') {
                doc.dispose();
                throw error;
            }
            doc.setCompileState(true,'Waiting for compilation…');
        }
        return doc;
    }

    public async resolveCustomEditor(doc: PdfDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        EventBus.fire('pdfWillOpenEvent', {uri: doc.uri, doc, webviewPanel});

        const updateWebview = () => {
            if (doc.cache.buffer.byteLength !== 0) {
                webviewPanel.webview.postMessage({type:'update', content:doc.cache, sourceId:doc.sourceId, range:doc.source?.ranged?{length:doc.source.length,chunkSize:65536}:undefined});
            }
        };

        const docOnDidChangeListener = doc.onDidChange(() => {
            updateWebview();
        });
        const updateStatus=()=>webviewPanel.webview.postMessage({type:'compileState',...doc.compileState});
        const statusListener=doc.onStatus(updateStatus);

        webviewPanel.onDidDispose(() => {
            docOnDidChangeListener.dispose();
            statusListener.dispose();
        });

        webviewPanel.webview.options = {enableScripts:true};
        webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview);

        // register event listeners
        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
                EventBus.fire('fileWillOpenEvent', {uri: doc.uri});
            }
        });
        webviewPanel.webview.onDidReceiveMessage((e) => {
            switch (e.type) {
                case 'pdfLoaded': doc.sourceLoaded(e.sourceId); break;
                case 'pdfRange': {
                    const id=e.sourceId,source=doc.getSource(id);
                    if (!source) { break; }
                    void source.read(e.begin,e.end).then(content=>{
                        if (source===doc.getSource(id)) {
                            void webviewPanel.webview.postMessage({type:'pdfRange',sourceId:id,requestId:e.requestId,begin:e.begin,content});
                        }
                    }).catch(()=>{
                        if (source===doc.getSource(id)) {
                            void webviewPanel.webview.postMessage({type:'pdfRangeError',sourceId:id,requestId:e.requestId});
                        }
                    });
                    break;
                }
                case 'syncPdf':
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncPdf`, {...e.content,pdfUri:doc.uri.toString()});
                    break;
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), e.content);
                    break;
                case 'ready':
                    const state = GlobalStateManager.getPdfViewPersist(this.context, doc.uri.toString());
                    const config = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer');
                    const colorThemes = config.get('themes', undefined);
                    const defaults = {
                        scrollMode: config.get('defaultScrollMode', 'vertical'),
                        spreadMode: config.get('defaultSpreadMode', 'none'),
                    };
                    webviewPanel.webview.postMessage({type:'initState', content:state, colorThemes, defaults});
                    updateWebview();
                    updateStatus();
                    break;
                default:
                    break;
            }
        });
        // Register the preview first so the build can publish its PDF and failure state to it.
        if (!doc.cache.length) {
            void vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`,doc.uri);
        }
    }

    public get triggers(): vscode.Disposable[] {
        return [
            vscode.window.registerCustomEditorProvider(`${ROOT_NAME}.pdfViewer`, this, {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }),
        ];
    }

    private patchViewerHtml(webview: vscode.Webview, html: string): string {
        const patchPath = (...path:string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer', ...path)).toString();

        // adjust original path
        html = html.replace('../build/pdf.js', patchPath('vendor','build','pdf.js'));
        html = html.replace('viewer.css', patchPath('vendor','web','viewer.css'));
        html = html.replace('viewer.js',  patchPath('vendor','web','viewer.js'));

        // patch custom files
        const workerScript = `<script src="${patchPath('vendor','build','pdf.worker.js')}"></script>`;
        const customScript = `<script src="${patchPath('index.js')}"></script>`;
        const customStyle = `<link rel="stylesheet" href="${patchPath('index.css')}" />`;
        html = html.replace(/\<\/head\>/, `${workerScript}\n${customScript}\n${customStyle}\n</head>`);

        return html;
    }

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/viewer.html');
        let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
        return this.patchViewerHtml(webview, html);
    }

}
