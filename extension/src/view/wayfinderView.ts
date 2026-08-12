import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ExecutionMode } from '../core/executionState';
import { OwnedTaskService, OwnedTaskUpdate } from '../owned/taskService';
import { parseViewMessage } from './messages';

const VIEW_ID = 'wayfinder.taskView';

interface ViewState {
  readonly taskId?: string;
  readonly state: 'idle' | OwnedTaskUpdate['state'];
  readonly mode: ExecutionMode;
  readonly message: string;
  readonly response?: string;
  readonly modelTier?: 'fast' | 'deep';
}

/** Task-first sidebar surface for the WayFinder-owned runtime. */
export class WayFinderViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private state: ViewState = { state: 'idle', mode: 'auto', message: 'Describe a task for WayFinder to handle locally.' };
  private taskSequence = 0;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly tasks: OwnedTaskService,
    private readonly showDiagnostics: () => Thenable<unknown>,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml(view.webview);
    this.disposables.push(view.webview.onDidReceiveMessage((message: unknown) => this.receive(message)));
    this.postState();
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private receive(value: unknown): void {
    const message = parseViewMessage(value);
    if (!message) return;
    if (message.type === 'showDiagnostics') {
      void this.showDiagnostics();
      return;
    }
    if (message.type === 'reset') {
      if (this.state.taskId) this.tasks.cancel(this.state.taskId);
      this.state = { state: 'idle', mode: 'auto', message: 'Describe a task for WayFinder to handle locally.' };
      this.postState();
      return;
    }
    if (message.type === 'cancel') {
      this.tasks.cancel(message.taskId);
      return;
    }
    const taskId = `task-${++this.taskSequence}`;
    this.state = { taskId, state: 'preparing', mode: message.mode, message: 'Preparing a compact task context.' };
    this.postState();
    void this.tasks.run({ taskId, goal: message.goal, mode: message.mode }, (update) => this.applyUpdate(update));
  }

  private applyUpdate(update: OwnedTaskUpdate): void {
    if (update.taskId !== this.state.taskId) return;
    this.state = {
      ...this.state,
      state: update.state,
      message: update.message,
      ...(update.response ? { response: update.response } : {}),
      ...(update.modelTier ? { modelTier: update.modelTier } : {}),
    };
    this.postState();
  }

  private postState(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.state });
  }
}

function webviewHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const policy = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 0 12px; }
textarea, select { box-sizing: border-box; width: 100%; margin: 8px 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 7px; font: inherit; }
textarea { min-height: 88px; resize: vertical; } button { margin: 4px 4px 4px 0; padding: 5px 9px; } #status { margin: 12px 0 6px; } #response { white-space: pre-wrap; border-top: 1px solid var(--vscode-widget-border); margin-top: 10px; padding-top: 10px; } .muted { color: var(--vscode-descriptionForeground); } .tier { font-weight: 600; }
</style></head>
<body>
<h2>WayFinder</h2><p class="muted">Run a compact local task.</p>
<label for="goal">Task</label><textarea id="goal" placeholder="Describe the task..."></textarea>
<label for="mode">Model tier</label><select id="mode"><option value="auto">Auto</option><option value="fast">Fast</option><option value="deep">Deep</option></select>
<div><button id="run">Run task</button><button id="cancel">Cancel</button><button id="reset">Reset</button></div>
<div id="status" role="status"></div><div id="response"></div><button id="diagnostics">Show runtime diagnostics</button>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const goal = document.getElementById('goal'); const mode = document.getElementById('mode'); const run = document.getElementById('run'); const cancel = document.getElementById('cancel'); const reset = document.getElementById('reset'); const status = document.getElementById('status'); const response = document.getElementById('response'); let currentTaskId;
run.addEventListener('click', () => vscode.postMessage({ type: 'submit', goal: goal.value, mode: mode.value }));
cancel.addEventListener('click', () => { if (currentTaskId) vscode.postMessage({ type: 'cancel', taskId: currentTaskId }); });
reset.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
document.getElementById('diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'showDiagnostics' }));
window.addEventListener('message', (event) => { const data = event.data; if (data.type !== 'state') return; const state = data.state; currentTaskId = state.taskId; mode.value = state.mode; status.textContent = state.modelTier ? state.message + ' Tier: ' + state.modelTier + '.' : state.message; response.textContent = state.response || ''; const running = state.state === 'preparing' || state.state === 'running'; run.disabled = running; goal.disabled = running; mode.disabled = running; cancel.disabled = !running; });
</script></body></html>`;
}

export { VIEW_ID };
