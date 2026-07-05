declare module "vscode" {
  export type Disposable = { dispose(): unknown };
  export type ExtensionContext = {
    subscriptions: Disposable[];
    globalState: { get<T>(key: string, defaultValue?: T): T | undefined; update(key: string, value: unknown): Thenable<void> };
  };
  export type Uri = { fsPath: string; scheme: string; toString(): string };
  export const Uri: { parse(value: string): Uri };
  export type WorkspaceFolder = { uri: Uri; name: string };
  export type TextDocument = { uri: Uri; languageId: string; fileName: string; isUntitled: boolean; getText(range?: unknown): string };
  export type Selection = unknown;
  export type TextEditor = { document: TextDocument; selection: Selection };
  export type StatusBarItem = Disposable & { text: string; tooltip?: string; command?: string; show(): void };
  export enum StatusBarAlignment { Left = 1, Right = 2 }
  export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
  export const commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  };
  export const workspace: {
    isTrusted: boolean;
    workspaceFolders?: readonly WorkspaceFolder[];
    getConfiguration(section?: string): { get<T>(key: string, defaultValue?: T): T | undefined; update(key: string, value: unknown, target?: ConfigurationTarget): Thenable<void> };
    onDidSaveTextDocument(listener: (document: TextDocument) => unknown): Disposable;
    onDidChangeWorkspaceFolders(listener: (...args: unknown[]) => unknown): Disposable;
  };
  export const window: {
    activeTextEditor?: TextEditor;
    createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    onDidChangeActiveTextEditor(listener: (editor: TextEditor | undefined) => unknown): Disposable;
    onDidOpenTerminal(listener: (terminal: { name: string; processId?: Thenable<number | undefined> }) => unknown): Disposable;
  };
  export const tasks: {
    onDidStartTask(listener: (event: { execution: { task: { name: string; source: string; definition?: unknown } } }) => unknown): Disposable;
    onDidEndTaskProcess(listener: (event: { execution: { task: { name: string; source: string } }; exitCode: number | undefined }) => unknown): Disposable;
  };
}
