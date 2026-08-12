import * as vscode from 'vscode';
import { join } from 'node:path';
import { JsonlTrace } from './core/trace';
import { JsonlRuntimeDiagnostics } from './core/diagnostics';
import { BackendId, VirtualModelId } from './core/types';
import { WayFinderLanguageModelProvider } from './compatibility/wayfinderProvider';
import { createConfiguredTaskService } from './owned/configuredTaskService';
import { VIEW_ID, WayFinderViewProvider } from './view/wayfinderView';

export function activate(context: vscode.ExtensionContext): void {
  const trace = new JsonlTrace(join(context.globalStorageUri.fsPath, 'gate-0.jsonl'));
  const runtimeDiagnostics = new JsonlRuntimeDiagnostics(join(context.globalStorageUri.fsPath, 'runtime.jsonl'));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'wayfinder.showTrace';
  status.text = 'WayFinder: Gate 0 ready';
  status.tooltip = 'WayFinder Gate 0 routing trace';
  status.show();

  const provider = new WayFinderLanguageModelProvider(
    trace,
    vscode.workspace.getConfiguration('wayfinder'),
    (backend: BackendId, virtualModel: VirtualModelId) => {
      status.text = `WayFinder: ${virtualModel.replace('wayfinder-', '')} → ${backend}`;
    },
  );
  const taskView = new WayFinderViewProvider(
    createConfiguredTaskService(context, vscode.workspace.getConfiguration('wayfinder')),
    () => vscode.commands.executeCommand('wayfinder.showRuntimeDiagnostics'),
  );

  context.subscriptions.push(
    status,
    taskView,
    vscode.lm.registerLanguageModelChatProvider('wayfinder', provider),
    vscode.window.registerWebviewViewProvider(VIEW_ID, taskView),
    vscode.commands.registerCommand('wayfinder.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.wayfinder');
    }),
    vscode.commands.registerCommand('wayfinder.showTrace', async () => {
      const entries = await trace.read();
      const document = await vscode.workspace.openTextDocument({
        language: 'jsonl',
        content: entries.map((entry) => JSON.stringify(entry)).join('\n') || '# No Gate 0 inferences recorded yet.\n',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand('wayfinder.clearTrace', async () => {
      await trace.clear();
      status.text = 'WayFinder: Gate 0 trace cleared';
      void vscode.window.showInformationMessage('WayFinder Gate 0 trace cleared.');
    }),
    vscode.commands.registerCommand('wayfinder.showRuntimeDiagnostics', async () => {
      const entries = await runtimeDiagnostics.read();
      const document = await vscode.workspace.openTextDocument({
        language: 'jsonl',
        content: entries.map((entry) => JSON.stringify(entry)).join('\n') || '# No owned-runtime inferences recorded yet.\n',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand('wayfinder.configureModelDeck', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'wayfinder.modelDeck');
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions during extension shutdown.
}
