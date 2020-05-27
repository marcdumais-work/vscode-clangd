import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient';

import * as config from './config';
import * as fileStatus from './file-status';
import * as install from './install';
import * as semanticHighlighting from './semantic-highlighting';
import * as switchSourceHeader from './switch-source-header';

import {
  LanguageClient, LanguageClientOptions, TransportKind
} from 'vscode-languageclient';
import * as path from 'path';
import {
  workspace as Workspace, window as Window, ExtensionContext, TextDocument, OutputChannel, WorkspaceFolder, Uri
} from 'vscode';

let defaultClient: LanguageClient;
let clients: Map<string, LanguageClient> = new Map();

let _sortedWorkspaceFolders: string[] | undefined;

let serverOptions: vscodelc.ServerOptions;

let clientOptions: vscodelc.LanguageClientOptions;

let clientCount = 0;

class ClangdLanguageClient extends vscodelc.LanguageClient {
  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.
  // logFailedRequest(rpcReply: vscodelc.RPCMessageType, error: any) {
  //   if (error instanceof vscodelc.ResponseError &&
  //     rpcReply.method === 'workspace/executeCommand')
  //     vscode.window.showErrorMessage(error.message);
  //   // Call default implementation.
  //   super.logFailedRequest(rpcReply, error);
  // }
}

class EnableEditsNearCursorFeature implements vscodelc.StaticFeature {
  initialize() { }
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities): void {
    const extendedCompletionCapabilities: any =
      capabilities.textDocument.completion;
    extendedCompletionCapabilities.editsNearCursor = true;
  }
}

/**
 *  This method is called when the extension is activated. The extension is
 *  activated the very first time a command is executed.
 */
export async function activate(context: vscode.ExtensionContext) {
  const clangdPath = await install.activate(context);
  if (!clangdPath)
    return;

  const clangd: vscodelc.Executable = {
    command: clangdPath,
    args: config.get<string[]>('arguments')
  };
  const traceFile = config.get<string>('trace');
  if (!!traceFile) {
    const trace = { CLANGD_TRACE: traceFile };
    clangd.options = { env: { ...process.env, ...trace } };
  }
  serverOptions = clangd;

  function didOpenTextDocument(document: TextDocument): void {
    // We are only interested in language mode text
    if (document.languageId !== 'cpp' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
      return;
    }

    let uri = document.uri;

    let folder = Workspace.getWorkspaceFolder(uri);
    // Files outside a folder can't be handled. This might depend on the language.
    // Single file languages like JSON might handle files outside the workspace folders.
    if (!folder) {
      return;
    }
    // If we have nested workspace folders we only start a server on the outer most workspace folder.
    folder = getOuterMostWorkspaceFolder(folder);

    if (!clients.has(folder.uri.toString())) {
      let client = spawnClient(context, serverOptions, getClientOptions(folder));
      // client.start();
      clients.set(folder.uri.toString(), client);
    }
  }

  Workspace.onDidOpenTextDocument(didOpenTextDocument);
  Workspace.textDocuments.forEach(didOpenTextDocument);
  Workspace.onDidChangeWorkspaceFolders((event) => {
    for (let folder of event.removed) {
      let client = clients.get(folder.uri.toString());
      if (client) {
        clients.delete(folder.uri.toString());
        client.stop();
      }
    }
  });


}

// use "pattern" to restrict a LC to a single given workspace root
function getClientOptions(folder: WorkspaceFolder): vscodelc.LanguageClientOptions {
return clientOptions = {
    // Register the server for c-family and cuda files.
    documentSelector: [
      { scheme: 'file', language: 'c', pattern: `${folder.uri.fsPath}/**/*` },
      { scheme: 'file', language: 'cpp', pattern: `${folder.uri.fsPath}/**/*` },
      // CUDA is not supported by vscode, but our extension does supports it.
      { scheme: 'file', language: 'cuda', pattern: `${folder.uri.fsPath}/**/*` },
      { scheme: 'file', language: 'objective-c', pattern: `${folder.uri.fsPath}/**/*` },
      { scheme: 'file', language: 'objective-cpp', pattern: `${folder.uri.fsPath}/**/*` },
    ],
    initializationOptions: {
      clangdFileStatus: true,
      fallbackFlags: config.get<string[]>('fallbackFlags')
    },
    // Do not switch to output window when clangd returns output.
    revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,

    // We hack up the completion items a bit to prevent VSCode from re-ranking
    // and throwing away all our delicious signals like type information.
    //
    // VSCode sorts by (fuzzymatch(prefix, item.filterText), item.sortText)
    // By adding the prefix to the beginning of the filterText, we get a perfect
    // fuzzymatch score for every item.
    // The sortText (which reflects clangd ranking) breaks the tie.
    // This also prevents VSCode from filtering out any results due to the
    // differences in how fuzzy filtering is applies, e.g. enable dot-to-arrow
    // fixes in completion.
    //
    // We also mark the list as incomplete to force retrieving new rankings.
    // See https://github.com/microsoft/language-server-protocol/issues/898
    middleware: {
      provideCompletionItem:
        async (document, position, context, token, next) => {
          let list = await next(document, position, context, token);
          let items = (Array.isArray(list) ? list : list.items).map(item => {
            // Gets the prefix used by VSCode when doing fuzzymatch.
            let prefix =
              document.getText(new vscode.Range(item.range.start, position))
            if (prefix)
              item.filterText = prefix + '_' + item.filterText;
            return item;
          })
          return new vscode.CompletionList(items, /*isIncomplete=*/ true);
        }
    },
  };
}

function spawnClient(context: vscode.ExtensionContext, sOptions: vscodelc.ServerOptions, cOptions: vscodelc.LanguageClientOptions): LanguageClient {
  const client = new ClangdLanguageClient(`Clang Language Server ${clientCount++}`, serverOptions, clientOptions);
  // const client2 = new ClangdLanguageClient('Clang Language Server2', serverOptions, clientOptions);
  // const client = new vscodelc.LanguageClient('Clang Language Server', serverOptions, clientOptions);
  // if (config.get<boolean>('semanticHighlighting'))
  //   semanticHighlighting.activate(client, context);
  // client.registerFeature(new EnableEditsNearCursorFeature);
  context.subscriptions.push(client.start());
  console.log('Clang Language Server is now active!');
  // fileStatus.activate(client, context);
  // switchSourceHeader.activate(client, context);
  // An empty place holder for the activate command, otherwise we'll get an
  // "command is not registered" error.
  // context.subscriptions.push(
  //   vscode.commands.registerCommand('clangd.activate', async () => { }));

  return client;
}

export function deactivate(): Thenable<void> {
  let promises: Thenable<void>[] = [];
  if (defaultClient) {
    promises.push(defaultClient.stop());
  }
  for (let client of clients.values()) {
    promises.push(client.stop());
  }
  return Promise.all(promises).then(() => undefined);
}

function sortedWorkspaceFolders(): string[] {
  if (_sortedWorkspaceFolders === void 0) {
    _sortedWorkspaceFolders = Workspace.workspaceFolders ? Workspace.workspaceFolders.map(folder => {
      let result = folder.uri.toString();
      if (result.charAt(result.length - 1) !== '/') {
        result = result + '/';
      }
      return result;
    }).sort(
      (a, b) => {
        return a.length - b.length;
      }
    ) : [];
  }
  return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
  let sorted = sortedWorkspaceFolders();
  for (let element of sorted) {
    let uri = folder.uri.toString();
    if (uri.charAt(uri.length - 1) !== '/') {
      uri = uri + '/';
    }
    if (uri.startsWith(element)) {
      return Workspace.getWorkspaceFolder(Uri.parse(element))!;
    }
  }
  return folder;
}
