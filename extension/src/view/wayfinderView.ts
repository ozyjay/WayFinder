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
<html lang="en-AU">
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; }
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.45; margin: 0; padding: 16px 12px 24px; }
button, textarea, select { font: inherit; }
button { border: 1px solid transparent; border-radius: 4px; cursor: pointer; min-height: 30px; padding: 5px 10px; }
button:focus-visible, textarea:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button:disabled { cursor: default; opacity: .55; }
.eyebrow { color: var(--vscode-descriptionForeground); font-size: .78em; font-weight: 700; letter-spacing: .08em; margin: 0 0 4px; text-transform: uppercase; }
h1 { font-size: 1.45em; line-height: 1.2; margin: 0; }
.intro { color: var(--vscode-descriptionForeground); margin: 7px 0 18px; }
.card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; margin: 12px 0; padding: 12px; }
.field-label { display: flex; font-weight: 600; justify-content: space-between; margin-bottom: 6px; }
.hint, .field-label span { color: var(--vscode-descriptionForeground); font-size: .9em; font-weight: 400; }
textarea, select { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; color: var(--vscode-input-foreground); width: 100%; }
textarea { min-height: 104px; padding: 9px; resize: vertical; }
select { margin: 0; padding: 7px; }
.mode-copy { color: var(--vscode-descriptionForeground); font-size: .9em; margin: 6px 0 0; min-height: 2.8em; }
.actions { display: flex; gap: 8px; margin-top: 14px; }
.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); flex: 1; font-weight: 600; }
.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.status { align-items: flex-start; display: flex; gap: 9px; }
.status-mark { background: var(--vscode-badge-background); border-radius: 50%; flex: 0 0 8px; height: 8px; margin-top: 6px; width: 8px; }
.status[data-state="running"] .status-mark, .status[data-state="preparing"] .status-mark { animation: pulse 1.2s ease-in-out infinite; }
.status[data-state="completed"] .status-mark { background: var(--vscode-testing-iconPassed); }
.status[data-state="error"] .status-mark, .status[data-state="failed"] .status-mark { background: var(--vscode-testing-iconFailed); }
.status-title { font-weight: 600; margin: 0 0 2px; }.status-detail { color: var(--vscode-descriptionForeground); margin: 0; }
.result { border-left: 3px solid var(--vscode-focusBorder); display: none; white-space: pre-wrap; }.result.visible { display: block; }
.result h2 { font-size: 1em; margin: 0 0 8px; }.result p { margin: 0; }
.suggestions { margin: 16px 0 0; }.suggestions h2 { font-size: 1em; margin: 0 0 7px; }
.suggestion-list { display: flex; flex-wrap: wrap; gap: 6px; }.suggestion { background: transparent; border-color: var(--vscode-button-border, var(--vscode-widget-border)); color: var(--vscode-textLink-foreground); font-size: .9em; text-align: left; }
.suggestion:hover { background: var(--vscode-list-hoverBackground); }
.footer { align-items: center; display: flex; justify-content: space-between; margin-top: 16px; }.link-button { background: transparent; color: var(--vscode-textLink-foreground); padding-left: 0; }.key { background: var(--vscode-keybindingLabel-background); border: 1px solid var(--vscode-keybindingLabel-border); border-bottom-color: var(--vscode-keybindingLabel-bottomBorder); border-radius: 3px; color: var(--vscode-keybindingLabel-foreground); font-family: var(--vscode-editor-font-family); font-size: .8em; padding: 1px 4px; }
@keyframes pulse { 50% { opacity: .3; transform: scale(.75); } }
</style></head>
<body>
<p class="eyebrow">Local task runtime</p><h1>WayFinder</h1><p class="intro">Ask a focused workspace question. WayFinder can inspect direct entries, then read one bounded text file when needed.</p>
<section class="card" aria-label="Task setup">
<label class="field-label" for="goal">What would you like to know?<span id="character-count">0 characters</span></label>
<textarea id="goal" maxlength="4000" placeholder="For example: What does Readme.md in this project say?"></textarea>
<p class="hint">Keep it specific. WayFinder is read-only and works only with the open workspace.</p>
<label class="field-label" for="mode">Model tier</label>
<select id="mode"><option value="auto">Auto — starts fast, escalates only when needed</option><option value="fast">Fast — quickest local response</option><option value="deep">Deep — more capable local response</option></select>
<p class="mode-copy" id="mode-copy">Starts with the Fast tier and may move to Deep after deterministic validation repairs.</p>
<div class="actions"><button class="primary" id="run">Run task</button><button class="secondary" id="cancel">Cancel</button><button class="secondary" id="reset">Clear</button></div>
</section>
<section class="card status" id="status" data-state="idle" role="status" aria-live="polite"><span class="status-mark" aria-hidden="true"></span><div><p class="status-title" id="status-title">Ready</p><p class="status-detail" id="status-detail">Describe a task, then run it locally.</p></div></section>
<section class="card result" id="response" aria-live="polite"><h2>Response</h2><p id="response-text"></p></section>
<section class="suggestions" id="suggestions"><h2>Try a bounded workspace task</h2><div class="suggestion-list"><button class="suggestion" data-task="What does Readme.md in this project say?">Read Readme.md</button><button class="suggestion" data-task="List the top-level files in this workspace.">List top-level files</button></div></section>
<div class="footer"><button class="link-button" id="diagnostics">Show runtime diagnostics</button><span class="key">Ctrl/Cmd + Enter</span></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const goal = document.getElementById('goal'); const mode = document.getElementById('mode'); const run = document.getElementById('run'); const cancel = document.getElementById('cancel'); const reset = document.getElementById('reset'); const status = document.getElementById('status'); const statusTitle = document.getElementById('status-title'); const statusDetail = document.getElementById('status-detail'); const response = document.getElementById('response'); const responseText = document.getElementById('response-text'); const characterCount = document.getElementById('character-count'); const modeCopy = document.getElementById('mode-copy'); const suggestions = document.getElementById('suggestions'); let currentTaskId;
const modeDescriptions = { auto: 'Starts with the Fast tier and may move to Deep after deterministic validation repairs.', fast: 'Pins this task to the Fast tier for the quickest local response.', deep: 'Pins this task to the Deep tier for a more capable local response.' };
function updateTaskControls() { characterCount.textContent = goal.value.length + ' characters'; run.disabled = !goal.value.trim(); }
function submit() { if (!goal.value.trim() || run.disabled) return; vscode.postMessage({ type: 'submit', goal: goal.value, mode: mode.value }); }
goal.addEventListener('input', updateTaskControls);
goal.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(); } });
mode.addEventListener('change', () => { modeCopy.textContent = modeDescriptions[mode.value]; });
document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => { goal.value = button.dataset.task; updateTaskControls(); goal.focus(); }));
run.addEventListener('click', submit);
cancel.addEventListener('click', () => { if (currentTaskId) vscode.postMessage({ type: 'cancel', taskId: currentTaskId }); });
reset.addEventListener('click', () => { vscode.postMessage({ type: 'reset' }); goal.value = ''; updateTaskControls(); goal.focus(); });
document.getElementById('diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'showDiagnostics' }));
window.addEventListener('message', (event) => { const data = event.data; if (data.type !== 'state') return; const state = data.state; currentTaskId = state.taskId; mode.value = state.mode; modeCopy.textContent = modeDescriptions[state.mode]; status.dataset.state = state.state; statusTitle.textContent = state.state === 'idle' ? 'Ready' : state.state.replace('-', ' '); statusDetail.textContent = state.modelTier ? state.message + ' Tier: ' + state.modelTier + '.' : state.message; responseText.textContent = state.response || ''; response.classList.toggle('visible', Boolean(state.response)); const running = state.state === 'preparing' || state.state === 'running'; goal.disabled = running; mode.disabled = running; cancel.disabled = !running; suggestions.hidden = running; updateTaskControls(); if (running) run.disabled = true; });
updateTaskControls();
</script></body></html>`;
}

export { VIEW_ID };
