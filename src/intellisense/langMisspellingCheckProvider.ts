import * as vscode from 'vscode';
import { IntellisenseProvider } from '.';
import { ROOT_NAME } from '../consts';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { DebouncedTasks } from '../utils/debouncedTasks';

function* sRange(start:number, end:number) {
    for (let i = start; i <= end; i++) {
        yield i;
    }
}

export class MisspellingCheckProvider extends IntellisenseProvider implements vscode.CodeActionProvider {
    private checkQueue:Promise<void>=Promise.resolve();
    private checkGeneration=0;
    private readonly scheduledChecks=new DebouncedTasks();
    private learnedWords?: Set<string>;
    private suggestionCache: Map<string, string[]> = new Map();
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(ROOT_NAME);
    protected readonly contextPrefix = [];

    private splitText(text: string) {
        return text.split(/([\P{L}\p{N}]*\\[a-zA-Z]*|[\P{L}\p{N}]+)/gu);
    }

    private check(uri:vscode.Uri,changedText:string,document?:vscode.TextDocument):Promise<void> {
        const generation=this.checkGeneration,version=document?.version;
        const current=()=>generation===this.checkGeneration && (!document || (!document.isClosed && document.version===version));
        const task=this.checkQueue.then(async()=>{
            if (!current()) { return; }
            await this.checkWords(uri,document?document.getText():changedText);
            if (document && current()) { await this.updateDiagnostics(uri); }
        });
        this.checkQueue=task.catch(()=>undefined);
        return task;
    }

    private async checkWords(uri:vscode.Uri, changedText: string) {
        const generation=this.checkGeneration;
        // init learned words
        if (this.learnedWords===undefined) {
            const vfs = await this.vfsm.prefetch(uri);
            if (generation!==this.checkGeneration) { return; }
            const words = vfs.getDictionary();
            this.learnedWords = new Set(words);
        }

        // extract words
        const splits = this.splitText(changedText);
        const words = splits.filter((x, i) => i%2===0 && x.length>1)
                            .filter(x => !this.suggestionCache.has(x))
                            .filter(x => !this.learnedWords?.has(x));
        if (words.length === 0) { return; }
        const uniqueWords = new Set(words);
        const uniqueWordsArray = [...uniqueWords];

        // update suggestion cache and learned words
        const vfs = await this.vfsm.prefetch(uri);
        if (generation!==this.checkGeneration) { return; }
        const misspellings = await vfs.spellCheck(uri, uniqueWordsArray);
        if (!Array.isArray(misspellings) || generation!==this.checkGeneration) { return; }
        if (!misspellings.every(item=>Number.isInteger(item.index) && item.index>=0 && item.index<uniqueWordsArray.length && Array.isArray(item.suggestions))) { return; }
        if (misspellings) {
            misspellings.forEach(misspelling => {
                uniqueWords.delete(uniqueWordsArray[misspelling.index]);
                this.suggestionCache.set(uniqueWordsArray[misspelling.index], misspelling.suggestions);
            });
        }
        uniqueWords.forEach(x => this.learnedWords?.add(x));

        // restrict cache size
        if (this.suggestionCache.size > 1000) {
            const keys = [...this.suggestionCache.keys()];
            keys.slice(0, 100).forEach(key => this.suggestionCache.delete(key));
        }
    }

    private async updateDiagnostics(uri:vscode.Uri, range?: vscode.Range) {
        // remove affected diagnostics
        let diagnostics = this.diagnosticCollection.get(uri) || [];
        if (range===undefined) {
            diagnostics = [];
        } else {
            diagnostics = diagnostics.filter(x => !x.range.intersection(range));
        }

        // update diagnostics
        const newDiagnostics:vscode.Diagnostic[] = [];
        const document = await vscode.workspace.openTextDocument(uri);
        const startLine = range ? range.start.line : 0;
        const endLine = range ? range.end.line : document.lineCount-1;
        for (const i of sRange(startLine, endLine)) {
            const cumsum = (sum => (value: number) => sum += value)(0);
            const splits = this.splitText( document.lineAt(i).text );
            const splitStart = splits.map(x => cumsum(x.length));
            const words = splits.filter((_, i) => i%2===0);
            const wordEnds = splitStart.filter((_, i) => i%2===0);
            //
            words.forEach((word, j) => {
                if (this.suggestionCache.has(word)) {
                    const range = new vscode.Range(
                        new vscode.Position(i, wordEnds[j] - word.length),
                        new vscode.Position(i, wordEnds[j])
                    );
                    const message = vscode.l10n.t('{word}: Unknown word.', {word});
                    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Information);
                    diagnostic.source = vscode.l10n.t('Spell Checker');
                    diagnostic.code = word;
                    newDiagnostics.push(diagnostic);
                }
            });
        }
        // update diagnostics collection
        diagnostics = [...diagnostics, ...newDiagnostics];
        this.diagnosticCollection.set(uri, diagnostics);
    }

    // Official SpellChecker.scheduleSpellCheck uses a 1000 ms trailing debounce.
    // Read the latest document after the queue drains; never send queued typing prefixes.
    private scheduleCheck(document:vscode.TextDocument,delay=1000):void {
        const key=document.uri.toString();
        this.scheduledChecks.schedule(key,delay,()=>{
            void this.check(document.uri,'',document).catch(error=>console.warn('Spell check failed',error));
        });
    }

    private resetDiagnosticCollection() {
        this.scheduledChecks.dispose();
        this.diagnosticCollection.clear();
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme===ROOT_NAME) { this.scheduleCheck(doc,0); }
        }
    }

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction[]> {
        if (context.diagnostics.length === 0) {
            return [];
        }

        const diagnostic = context.diagnostics[0];
        const actions = this.suggestionCache.get(diagnostic.code as string)
                        ?.slice(0,8).map(suggestion => {
                            const action = new vscode.CodeAction(suggestion, vscode.CodeActionKind.QuickFix);
                            action.diagnostics = [diagnostic];
                            action.edit = new vscode.WorkspaceEdit();
                            action.edit.replace(document.uri, diagnostic.range, suggestion);
                            return action;
                        });
        //
        const learnAction = new vscode.CodeAction(vscode.l10n.t('Add to Dictionary'), vscode.CodeActionKind.QuickFix);
        learnAction.diagnostics = [diagnostic];
        learnAction.command = {
            title: vscode.l10n.t('Add to Dictionary'),
            command: 'langIntellisense.learnSpelling',
            arguments: [document.uri, diagnostic.code as string],
        };
        actions?.push(learnAction);
        //
        return actions;
    }

    learnSpelling(uri:vscode.Uri, word: string) {
        this.vfsm.prefetch(uri).then(vfs => vfs.spellLearn(word));
        this.learnedWords?.add(word);
        this.suggestionCache.delete(word);
        this.updateDiagnostics(uri);
    }

    async dictionarySettings(vfs:VirtualFileSystem, dictionary?:string[]) {
        vscode.window.showQuickPick(dictionary||[], {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select a word to unlearn'),
        }).then(async (word) => {
            if (word) {
                vfs.spellUnlearn(word);
                this.learnedWords?.delete(word);
                this.suggestionCache.delete(word);
                dictionary = dictionary?.filter(x => x!==word);
                this.dictionarySettings(vfs, dictionary);
            } else {
                // reset diagnostic collection is dictionary changed
                if ( !vfs.getDictionary()?.every(x => dictionary?.includes(x)) ) {
                    this.resetDiagnosticCollection();
                }
            }
        });
    }

    async spellCheckSettings() {
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        const vfs = uri && await this.vfsm.prefetch(uri);
        const languages = vfs?.getAllSpellCheckLanguages();
        const currentLanguage = vfs?.getSpellCheckLanguage();

        const items = [];
        items.push({
            id: "dictionary",
            label: vscode.l10n.t('Manage Dictionary'),
            iconPath: new vscode.ThemeIcon('book'),
        });
        items.push({label:'',kind:vscode.QuickPickItemKind.Separator});
        for (const item of languages||[]) {
            items.push({
                label: item.name,
                description: item.code,
                picked: item.code===currentLanguage?.code,
            });
        }

        vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Select spell check language'),
            canPickMany: false,
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        }).then(async (option) => {
            if (option?.id==='dictionary') {
                vfs && this.dictionarySettings(vfs, vfs.getDictionary());
            } else {
                option && vfs?.updateSettings({spellCheckLanguage:option.description});
            }
        });
    }

    get triggers () {
        return [
            // the diagnostic collection
            this.diagnosticCollection,
            new vscode.Disposable(()=>{ this.checkGeneration++; this.scheduledChecks.dispose(); }),
            vscode.workspace.onDidCloseTextDocument(doc=>{
                this.scheduledChecks.cancel(doc.uri.toString());
                this.diagnosticCollection.delete(doc.uri);
            }),
            // the code action provider
            vscode.languages.registerCodeActionsProvider(this.selector, this),
            // register learn spelling command
            vscode.commands.registerCommand('langIntellisense.learnSpelling', (uri: vscode.Uri, word: string) => {
                this.learnSpelling(uri, word);
            }),
            vscode.commands.registerCommand('langIntellisense.settings', () => {
                this.spellCheckSettings();
            }),
            // reset diagnostics when spell check languages changed
            EventBus.on('spellCheckLanguageUpdateEvent', async () => {
                this.checkGeneration++;
                this.learnedWords=undefined;
                this.suggestionCache.clear();
                this.resetDiagnosticCollection();
            }),
            // Initial open is immediate; typing is coalesced until one second idle.
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (doc.uri.scheme===ROOT_NAME) { this.scheduleCheck(doc,0); }
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.scheme===ROOT_NAME && e.contentChanges.length) {
                    this.scheduleCheck(e.document);
                }
            }),
        ];
    }
}
