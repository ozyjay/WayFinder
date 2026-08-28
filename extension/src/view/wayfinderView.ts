import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ExecutionMode } from '../core/executionState';
import { OwnedTaskService, OwnedTaskUpdate } from '../owned/taskService';
import { parseViewMessage } from './messages';

const VIEW_ID = 'wayfinder.taskView';

interface ConversationTurn {
  readonly taskId: string;
  readonly goal: string;
  readonly mode: ExecutionMode;
  readonly state: OwnedTaskUpdate['state'];
  readonly message: string;
  readonly response?: string;
  readonly modelTier?: 'fast' | 'deep';
}

interface ViewState {
  readonly mode: ExecutionMode;
  readonly turns: readonly ConversationTurn[];
}

/** Chat-style sidebar surface for independent WayFinder-owned runtime tasks. */
export class WayFinderViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private state: ViewState = { mode: 'auto', turns: [] };
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
      const active = this.activeTurn();
      if (active) this.tasks.cancel(active.taskId);
      this.state = { mode: 'auto', turns: [] };
      this.postState();
      return;
    }
    if (message.type === 'cancel') {
      this.tasks.cancel(message.taskId);
      return;
    }

    const taskId = `task-${++this.taskSequence}`;
    const turn: ConversationTurn = {
      taskId,
      goal: message.goal,
      mode: message.mode,
      state: 'preparing',
      message: 'Preparing a compact task context.',
    };
    this.state = { mode: message.mode, turns: [...this.state.turns, turn] };
    this.postState();
    void this.tasks.run({ taskId, goal: message.goal, mode: message.mode }, (update) => this.applyUpdate(update));
  }

  private applyUpdate(update: OwnedTaskUpdate): void {
    if (!this.state.turns.some((turn) => turn.taskId === update.taskId)) return;
    this.state = {
      ...this.state,
      turns: this.state.turns.map((turn): ConversationTurn => turn.taskId === update.taskId ? {
        ...turn,
        state: update.state,
        message: update.message,
        ...(update.response !== undefined ? { response: update.response } : {}),
        ...(update.modelTier ? { modelTier: update.modelTier } : {}),
      } : turn),
    };
    this.postState();
  }

  private activeTurn(): ConversationTurn | undefined {
    return [...this.state.turns].reverse().find((turn) => turn.state === 'preparing' || turn.state === 'running');
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
html, body { height: 100%; }
body { color: var(--vscode-foreground); display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.45; margin: 0; overflow: hidden; }
button, textarea, select { font: inherit; }
button { cursor: pointer; }
button:focus-visible, textarea:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button:disabled, textarea:disabled, select:disabled { cursor: default; opacity: .55; }
.header { align-items: center; border-bottom: 1px solid var(--vscode-widget-border); display: flex; gap: 10px; justify-content: space-between; padding: 10px 12px; }
.brand { font-size: 1em; font-weight: 650; margin: 0; }
.header-actions { display: flex; gap: 2px; }
.icon-button { background: transparent; border: 0; border-radius: 4px; color: var(--vscode-descriptionForeground); min-height: 28px; padding: 3px 7px; }
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
.transcript { flex: 1; overflow-y: auto; padding: 14px 12px 18px; }
.empty { display: flex; flex-direction: column; justify-content: center; margin: auto; max-width: 420px; min-height: 100%; text-align: center; }
.empty-mark { align-items: center; align-self: center; background: var(--vscode-badge-background); border-radius: 12px; color: var(--vscode-badge-foreground); display: flex; font-size: 1.2em; font-weight: 700; height: 42px; justify-content: center; margin-bottom: 12px; width: 42px; }
.empty h2 { font-size: 1.15em; margin: 0 0 6px; }
.empty p { color: var(--vscode-descriptionForeground); margin: 0 auto 16px; }
.suggestions { display: flex; flex-direction: column; gap: 7px; }
.suggestion { background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; color: var(--vscode-button-secondaryForeground); padding: 8px 10px; text-align: left; }
.suggestion:hover { background: var(--vscode-button-secondaryHoverBackground); }
.turn { display: flex; flex-direction: column; gap: 10px; margin: 0 auto 20px; max-width: 680px; }
.message { max-width: 92%; min-width: 0; }
.message-label { color: var(--vscode-descriptionForeground); font-size: .82em; margin: 0 0 4px 2px; }
.bubble { border-radius: 9px; padding: 9px 11px; white-space: pre-wrap; word-break: break-word; }
.user { align-self: flex-end; }
.user .message-label { text-align: right; }
.user .bubble { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.assistant { align-self: flex-start; }
.assistant .bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); }
.assistant[data-state="error"] .bubble, .assistant[data-state="failed"] .bubble { border-color: var(--vscode-inputValidation-errorBorder); }
.status-line { align-items: flex-start; color: var(--vscode-descriptionForeground); display: flex; font-size: .9em; gap: 8px; }
.status-mark { background: var(--vscode-badge-background); border-radius: 50%; flex: 0 0 7px; height: 7px; margin-top: 6px; width: 7px; }
.assistant[data-state="preparing"] .status-mark, .assistant[data-state="running"] .status-mark { animation: pulse 1.2s ease-in-out infinite; }
.assistant[data-state="completed"] .status-mark { background: var(--vscode-testing-iconPassed); }
.assistant[data-state="error"] .status-mark, .assistant[data-state="failed"] .status-mark { background: var(--vscode-testing-iconFailed); }
.answer + .status-line { border-top: 1px solid var(--vscode-widget-border); margin-top: 9px; padding-top: 7px; }
.composer-wrap { background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-widget-border); padding: 9px 10px 10px; }
.composer { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 8px; overflow: hidden; }
textarea { background: transparent; border: 0; color: var(--vscode-input-foreground); display: block; max-height: 140px; min-height: 48px; padding: 9px 10px 5px; resize: none; width: 100%; }
textarea:focus { outline: 0; }
.composer-controls { align-items: center; display: flex; gap: 7px; justify-content: space-between; padding: 5px 6px 6px 9px; }
.mode-control { align-items: center; display: flex; min-width: 0; }
.mode-control label { color: var(--vscode-descriptionForeground); font-size: .84em; margin-right: 5px; }
select { background: transparent; border: 0; color: var(--vscode-foreground); font-size: .86em; min-width: 0; padding: 3px 18px 3px 2px; }
.actions { display: flex; gap: 5px; }
.send, .cancel { border: 1px solid transparent; border-radius: 5px; min-height: 28px; padding: 3px 10px; }
.send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
.send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.composer-hint { color: var(--vscode-descriptionForeground); font-size: .78em; margin: 5px 2px 0; text-align: right; }
@keyframes pulse { 50% { opacity: .3; transform: scale(.75); } }
</style></head>
<body>
<header class="header"><h1 class="brand">WayFinder</h1><div class="header-actions"><button class="icon-button" id="diagnostics" title="Show runtime diagnostics">Diagnostics</button><button class="icon-button" id="reset" title="Start a new chat">New chat</button></div></header>
<main class="transcript" id="transcript" aria-live="polite"></main>
<footer class="composer-wrap">
  <div class="composer">
    <textarea id="goal" maxlength="4000" rows="2" aria-label="Message WayFinder" placeholder="Ask about the open workspace…"></textarea>
    <div class="composer-controls">
      <div class="mode-control"><label for="mode">Model</label><select id="mode" title="Model tier"><option value="auto">Auto</option><option value="fast">Fast</option><option value="deep">Deep</option></select></div>
      <div class="actions"><button class="cancel" id="cancel" hidden>Cancel</button><button class="send" id="send">Send</button></div>
    </div>
  </div>
  <p class="composer-hint">Enter to send · Shift+Enter for a new line · each request is independent</p>
</footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const transcript = document.getElementById('transcript'); const goal = document.getElementById('goal'); const mode = document.getElementById('mode'); const send = document.getElementById('send'); const cancel = document.getElementById('cancel'); let currentTaskId;
const terminalStates = new Set(['completed', 'awaiting-approval', 'cancelled', 'stopped', 'failed', 'error']);
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function addSuggestions(container) { const suggestions = element('div', 'suggestions'); [['What does Readme.md in this project say?', 'Read Readme.md'], ['List the top-level files in this workspace.', 'List top-level files']].forEach(([task, label]) => { const button = element('button', 'suggestion', label); button.addEventListener('click', () => { goal.value = task; updateControls(); goal.focus(); }); suggestions.appendChild(button); }); container.appendChild(suggestions); }
function renderEmpty() { const empty = element('section', 'empty'); empty.appendChild(element('div', 'empty-mark', 'W')); empty.appendChild(element('h2', '', 'Ask WayFinder')); empty.appendChild(element('p', '', 'Explore the open workspace with bounded, read-only local tools.')); addSuggestions(empty); transcript.appendChild(empty); }
function renderTurn(turn) { const section = element('section', 'turn'); const user = element('div', 'message user'); user.appendChild(element('p', 'message-label', 'You')); user.appendChild(element('div', 'bubble', turn.goal)); section.appendChild(user); const assistant = element('div', 'message assistant'); assistant.dataset.state = turn.state; assistant.appendChild(element('p', 'message-label', 'WayFinder')); const bubble = element('div', 'bubble'); if (turn.response) bubble.appendChild(element('div', 'answer', turn.response)); const statusLine = element('div', 'status-line'); statusLine.appendChild(element('span', 'status-mark')); statusLine.appendChild(element('span', '', turn.message)); bubble.appendChild(statusLine); assistant.appendChild(bubble); section.appendChild(assistant); transcript.appendChild(section); }
function render(state) { transcript.replaceChildren(); if (!state.turns.length) renderEmpty(); else state.turns.forEach(renderTurn); const active = [...state.turns].reverse().find((turn) => !terminalStates.has(turn.state)); currentTaskId = active?.taskId; const running = Boolean(active); goal.disabled = running; mode.disabled = running; cancel.hidden = !running; send.hidden = running; mode.value = state.mode; updateControls(); requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; }); }
function updateControls() { send.disabled = !goal.value.trim(); goal.style.height = 'auto'; goal.style.height = Math.min(goal.scrollHeight, 140) + 'px'; }
function submit() { const text = goal.value.trim(); if (!text || send.disabled) return; vscode.postMessage({ type: 'submit', goal: text, mode: mode.value }); goal.value = ''; updateControls(); }
goal.addEventListener('input', updateControls);
goal.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } });
send.addEventListener('click', submit);
cancel.addEventListener('click', () => { if (currentTaskId) vscode.postMessage({ type: 'cancel', taskId: currentTaskId }); });
document.getElementById('reset').addEventListener('click', () => { vscode.postMessage({ type: 'reset' }); goal.value = ''; updateControls(); goal.focus(); });
document.getElementById('diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'showDiagnostics' }));
window.addEventListener('message', (event) => { if (event.data.type === 'state') render(event.data.state); });
updateControls();
</script></body></html>`;
}

export { VIEW_ID };
