import * as vscode from 'vscode';
import type { TodoGroup, TodoItem, TodoState } from './types';

declare function setInterval(handler: () => void, timeout?: number): unknown;
declare function clearInterval(handle: unknown): void;
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

const TODO_STATE_KEY = 'tiny-todo-list-state-v1';
const SETTINGS_SYNC_NOW_COMMAND = 'workbench.userDataSync.actions.syncNow';
const CONFIG_SECTION = 'tinyTodoList';
const CONFIG_AUTO_SYNC = 'autoSync';
const CONFIG_PERIODIC_PULL_SECONDS = 'periodicPullSeconds';
const DEFAULT_PERIODIC_PULL_SECONDS = 0;
const MIN_PERIODIC_PULL_SECONDS = 30;
// Event-driven push: after a syncable change (edit committed, item toggled,
// added, deleted, group changed…) wait this long, then push once. Bursts of
// changes within the window collapse into a single sync, like settings.json.
const SYNC_DEBOUNCE_MS = 1_000;
// Minimum gap between focus-triggered pulls, so rapid window switching doesn't
// hammer syncNow (and risk rate-limiting).
const FOCUS_SYNC_MIN_GAP_MS = 10_000;
// Lightweight "receive" poll: read globalState and refresh the UI when it
// changes. This does NOT trigger Settings Sync, so it never hits rate limits;
// it just surfaces whatever VS Code's own background sync (or our syncNow) has
// already pulled into globalState.
const RECEIVE_REFRESH_INTERVAL_MS = 500;
const DEFAULT_TODO_STATE: TodoState = {
  groups: [{ id: 'default', name: 'Default', collapsed: false }],
  items: [],
};

type WebviewMessage = {
  type?: string;
  requestId?: number;
  text?: string;
  state?: unknown;
  sync?: boolean;
};

type RawTodoState = {
  groups: unknown[];
  items: unknown[];
};

/**
 * WebviewView provider — renders the TODO app directly in the sidebar.
 */
class TodoWebviewViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private stateWriteQueue: Thenable<void> = Promise.resolve();
  private syncTimer: unknown;
  private refreshTimer: unknown;
  private pushDebounceTimer: unknown;
  private lastStateSnapshot = '';
  private canRunSettingsSyncCommand = true;
  private syncInFlight: Promise<boolean> | undefined;
  private lastFocusSyncAt = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_AUTO_SYNC}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_PERIODIC_PULL_SECONDS}`)
        ) {
          this.restartSyncTimer();
        }
      }),
      // Pull when the VS Code window regains focus (like settings.json). Throttled
      // so rapid alt-tabbing doesn't hammer syncNow.
      vscode.window.onDidChangeWindowState((windowState) => {
        if (!windowState.focused) {
          return;
        }
        if (!this.view || !this.isAutoSyncEnabled()) {
          return;
        }
        const now = Date.now();
        if (now - this.lastFocusSyncAt < FOCUS_SYNC_MIN_GAP_MS) {
          return;
        }
        this.lastFocusSyncAt = now;
        void this.syncAndRefreshState();
      })
    );
  }

  dispose(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = undefined;
    }
  }

  private isAutoSyncEnabled(): boolean {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(CONFIG_AUTO_SYNC, true);
  }

  /** Optional periodic full-sync (mainly to pull). 0 / unset = disabled. */
  private getPeriodicSyncIntervalMs(): number {
    const seconds = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<number>(CONFIG_PERIODIC_PULL_SECONDS, DEFAULT_PERIODIC_PULL_SECONDS);
    if (typeof seconds !== 'number' || seconds <= 0) {
      return 0;
    }
    return Math.max(seconds, MIN_PERIODIC_PULL_SECONDS) * 1000;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(webviewView.webview, message);
    });
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        return;
      }
      // Always pick up incoming changes; only trigger a push/pull when auto-sync is on.
      this.refreshFromGlobalState();
      if (this.isAutoSyncEnabled()) {
        void this.syncAndRefreshState();
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    this.ensureReceiveTimer();
    this.restartSyncTimer();
    this.refreshFromGlobalState();
    if (this.isAutoSyncEnabled()) {
      void this.syncAndRefreshState();
    }
  }

  private async handleMessage(
    webview: vscode.Webview,
    message: WebviewMessage
  ): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'requestState') {
      const savedState = this.context.globalState.get<unknown>(TODO_STATE_KEY);
      const normalizedSavedState = normalizeTodoState(savedState);
      const normalizedFallbackState = normalizeTodoState(message.state);
      const hasSavedState = isTodoStateLike(savedState);
      const shouldMigrateFallback =
        isTodoStateLike(message.state) &&
        hasMeaningfulTodoState(normalizedFallbackState) &&
        (!hasSavedState || !hasMeaningfulTodoState(normalizedSavedState));
      const state = shouldMigrateFallback ? normalizedFallbackState : normalizedSavedState;

      if (shouldMigrateFallback) {
        await this.saveTodoState(state);
      }

      this.lastStateSnapshot = serializeTodoState(state);
      await webview.postMessage({ type: 'state', state });
      return;
    }

    if (message.type === 'updateState') {
      await this.saveTodoState(normalizeTodoState(message.state));
      // A `sync: true` change is a completed edit / action — push it out
      // (debounced). Interim keystrokes never reach here.
      if (message.sync === true) {
        this.schedulePush();
      }
      return;
    }

    if (message.type === 'manualSync') {
      const ok = await this.syncAndRefreshState();
      await webview.postMessage({ type: 'syncComplete', ok });
      return;
    }

    if (message.type === 'writeClipboard' && typeof message.text === 'string') {
      await vscode.env.clipboard.writeText(message.text);
      return;
    }

    if (message.type === 'readClipboard') {
      const text = await vscode.env.clipboard.readText();
      await webview.postMessage({
        type: 'clipboardReadResult',
        requestId: message.requestId,
        text,
      });
    }
  }

  private saveTodoState(state: TodoState): Thenable<void> {
    this.lastStateSnapshot = serializeTodoState(state);
    this.stateWriteQueue = this.stateWriteQueue.then(
      () => this.context.globalState.update(TODO_STATE_KEY, state),
      () => this.context.globalState.update(TODO_STATE_KEY, state)
    );
    return this.stateWriteQueue;
  }

  /** Always-on lightweight poll that surfaces incoming changes (no syncNow). */
  private ensureReceiveTimer(): void {
    if (this.refreshTimer) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      this.refreshFromGlobalState();
    }, RECEIVE_REFRESH_INTERVAL_MS);
  }

  private restartSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    if (!this.isAutoSyncEnabled()) {
      return;
    }

    const intervalMs = this.getPeriodicSyncIntervalMs();
    if (intervalMs <= 0) {
      return;
    }

    this.syncTimer = setInterval(() => {
      void this.syncAndRefreshState();
    }, intervalMs);
  }

  /** Event-driven push: debounce a syncNow after a completed change. */
  private schedulePush(): void {
    if (!this.isAutoSyncEnabled()) {
      return;
    }

    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }

    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = undefined;
      void this.syncAndRefreshState();
    }, SYNC_DEBOUNCE_MS);
  }

  /** Receive path: refresh the UI from globalState if it changed. Cheap, no rate limit. */
  private refreshFromGlobalState(): void {
    const state = normalizeTodoState(this.context.globalState.get<unknown>(TODO_STATE_KEY));
    const snapshot = serializeTodoState(state);
    if (snapshot === this.lastStateSnapshot) {
      return;
    }

    this.lastStateSnapshot = snapshot;
    void this.view?.webview.postMessage({ type: 'state', state });
  }

  /** Trigger Settings Sync (push + pull), then refresh. Returns whether syncNow ran. */
  private async syncAndRefreshState(): Promise<boolean> {
    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    this.syncInFlight = this.doSyncAndRefreshState();
    try {
      return await this.syncInFlight;
    } finally {
      this.syncInFlight = undefined;
    }
  }

  private async doSyncAndRefreshState(): Promise<boolean> {
    const ok = await this.runSettingsSyncNow();
    this.refreshFromGlobalState();
    return ok;
  }

  private async runSettingsSyncNow(): Promise<boolean> {
    if (!this.canRunSettingsSyncCommand) {
      return false;
    }

    try {
      await vscode.commands.executeCommand(SETTINGS_SYNC_NOW_COMMAND);
      return true;
    } catch (error) {
      if (error instanceof Error && /command .* not found/i.test(error.message)) {
        this.canRunSettingsSyncCommand = false;
      }
      return false;
    }
  }

  /** Build the self-contained webview HTML */
  private buildHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg-primary: var(--vscode-sideBar-background, #252526);
      --bg-secondary: var(--vscode-editor-background, #1e1e1e);
      --bg-hover: var(--vscode-list-hoverBackground, #2a2d2e);
      --bg-selection: var(--vscode-list-activeSelectionBackground, #094771);
      --fg-primary: var(--vscode-sideBar-foreground, #d4d4d4);
      --fg-secondary: var(--vscode-descriptionForeground, #999);
      --border-color: var(--vscode-sideBar-border, #3c3c3c);
      --accent: var(--vscode-focusBorder, #007acc);
      --danger: #f44747;
    }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg-primary);
      background: var(--bg-primary);
      user-select: none;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Tabs ── */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }
    .tab {
      flex: 1;
      text-align: center;
      padding: 7px 0;
      cursor: pointer;
      color: var(--fg-secondary);
      border-bottom: 2px solid transparent;
      font-size: 12px;
      transition: color 0.15s;
    }
    .tab:hover { color: var(--fg-primary); }
    .tab.active {
      color: var(--fg-primary);
      border-bottom-color: var(--accent);
    }

    /* ── Manual sync button ── */
    .sync-btn {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 10px;
      cursor: pointer;
      color: var(--fg-secondary);
      border-bottom: 2px solid transparent;
      font-size: 13px;
      transition: color 0.15s;
    }
    .sync-btn:hover { color: var(--fg-primary); }
    .sync-btn.syncing {
      cursor: default;
      color: var(--accent);
    }
    .sync-btn.syncing .sync-icon {
      animation: sync-spin 0.8s linear infinite;
    }
    .sync-btn.success { color: var(--vscode-charts-green, #89d185); }
    .sync-btn.failed { color: var(--danger); }
    .sync-icon { display: inline-block; line-height: 1; }
    @keyframes sync-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* ── Clear button ── */
    .clear-bar {
      display: none;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }
    .clear-bar.visible { display: block; }
    .clear-btn {
      width: 100%;
      background: transparent;
      color: var(--danger);
      border: 1px solid var(--danger);
      padding: 4px 0;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }
    .clear-btn:hover { background: var(--danger); color: #fff; }

    /* ── Scrollable content ── */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 6px 0;
    }

    /* ── Group ── */
    .group {
      margin: 0 6px 6px 6px;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      overflow: hidden;
    }
    .group-header {
      display: flex;
      align-items: center;
      padding: 5px 8px;
      background: var(--bg-secondary);
      cursor: pointer;
      gap: 6px;
    }
    .group-header:hover { background: var(--bg-hover); }
    .group-arrow {
      font-size: 9px;
      transition: transform 0.15s;
      color: var(--fg-secondary);
    }
    .group-arrow.collapsed { transform: rotate(-90deg); }
    .group-name {
      font-weight: 600;
      font-size: 12px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .group-edit-input {
      flex: 1;
      min-width: 0;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #d4d4d4);
      border: 1px solid var(--accent);
      padding: 1px 4px;
      font-size: 12px;
      font-weight: 600;
      outline: none;
      border-radius: 2px;
      font-family: inherit;
    }
    .group-count {
      font-size: 10px;
      color: var(--fg-secondary);
      background: var(--bg-primary);
      padding: 1px 6px;
      border-radius: 8px;
    }
    .group-body.collapsed { display: none; }

    /* ── TODO item ── */
    .todo-item {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      gap: 6px;
      border-bottom: 1px solid var(--border-color);
      cursor: default;
    }
    .todo-item:last-child { border-bottom: none; }
    .todo-item.selected {
      background: var(--bg-selection);
      color: var(--vscode-list-activeSelectionForeground, #fff);
    }

    .todo-checkbox {
      width: 14px; height: 14px;
      border: 1px solid var(--vscode-checkbox-border, #6c6c6c);
      border-radius: 3px;
      background: var(--vscode-checkbox-background, #3c3c3c);
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    }
    .todo-checkbox:hover { border-color: var(--accent); }
    .todo-checkbox.checked {
      background: var(--accent);
      border-color: var(--accent);
    }
    .todo-checkbox.checked::after {
      content: '✓';
      color: #fff;
      font-size: 10px;
      font-weight: bold;
    }

    .todo-text {
      flex: 1;
      outline: none;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.4;
      min-height: 18px;
    }
    .todo-text:empty::after {
      content: '(empty)';
      color: var(--fg-secondary);
      font-style: italic;
    }
    .todo-text.completed-text {
      text-decoration: line-through;
      color: var(--fg-secondary);
    }

    .todo-delete-btn {
      background: none;
      border: none;
      color: var(--fg-secondary);
      cursor: pointer;
      font-size: 12px;
      padding: 0 3px;
      opacity: 0;
      transition: opacity 0.1s;
      flex-shrink: 0;
    }
    .todo-item:hover .todo-delete-btn { opacity: 0.5; }
    .todo-delete-btn:hover { opacity: 1 !important; color: var(--danger); }

    /* ── Create-new button (full-width) ── */
    .create-new-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 5px 0;
      margin: 4px 0;
      color: var(--fg-secondary);
      cursor: pointer;
      border: 1px dashed var(--fg-secondary);
      border-radius: 4px;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .create-new-btn:hover { color: var(--fg-primary); background: var(--bg-hover); border-color: var(--fg-primary); }
    .create-new-btn-icon { font-size: 16px; font-weight: bold; line-height: 1; }

    /* ── Add group button ── */
    .add-group-bar {
      margin: 8px 6px;
      text-align: center;
    }
    .add-group-btn {
      display: inline-block;
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 6px 20px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
    }
    .add-group-btn:hover { background: var(--vscode-button-hoverBackground, #1c97ea); }

    /* ── Group header delete button ── */
    .group-delete-btn {
      background: none;
      border: none;
      color: var(--fg-secondary);
      cursor: pointer;
      font-size: 12px;
      padding: 0 3px;
      opacity: 0;
      transition: opacity 0.1s;
      flex-shrink: 0;
    }
    .group-header:hover .group-delete-btn { opacity: 0.5; }
    .group-delete-btn:hover { opacity: 1 !important; color: var(--danger); }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 30px 12px;
      color: var(--fg-secondary);
      font-size: 12px;
    }

    /* ── Context menu ── */
    .context-menu {
      position: fixed;
      z-index: 1000;
      display: none;
      min-width: 150px;
      padding: 4px;
      background: var(--vscode-menu-background, var(--bg-secondary));
      color: var(--vscode-menu-foreground, var(--fg-primary));
      border: 1px solid var(--vscode-menu-border, var(--border-color));
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    }
    .context-menu.visible { display: block; }
    .context-menu-button {
      width: 100%;
      border: none;
      background: transparent;
      color: inherit;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .context-menu-button:hover {
      background: var(--vscode-menu-selectionBackground, var(--bg-hover));
      color: var(--vscode-menu-selectionForeground, var(--fg-primary));
    }
    .context-menu-button.danger { color: var(--danger); }

    /* ── Inline edit textarea ── */
    .todo-edit-input {
      flex: 1;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #d4d4d4);
      border: 1px solid var(--accent);
      padding: 2px 4px;
      font-size: 12px;
      outline: none;
      border-radius: 2px;
      font-family: inherit;
      line-height: 1.4;
      resize: none;
      overflow: hidden;
      min-height: 20px;
    }
  </style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" data-tab="todo">📋 TODO</div>
    <div class="tab" data-tab="finished">✅ Finished</div>
    <div class="sync-btn" id="syncBtn" title="Sync now (push + pull)"><span class="sync-icon">🔄</span></div>
  </div>
  <div class="clear-bar" id="clearBar">
    <button class="clear-btn" id="clearFinishedBtn">🗑 Clear All Finished</button>
  </div>
  <div class="content" id="content"></div>
  <div class="context-menu" id="contextMenu" role="menu"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ── State ──
    const defaultState = { groups: [{ id: 'default', name: 'Default', collapsed: false }], items: [] };
    const webviewStorageKey = '${TODO_STATE_KEY}';
    let state = readSavedWebviewState();
    let currentTab = 'todo';
    let selectedItemIds = new Set();
    let lastClickedIndex = -1;
    let contextMenuState = null;
    let clipboardRequestSeq = 1;
    let hasReceivedHostState = false;
    let isEditing = false;
    let pendingHostState = null;
    let editSession = 0;
    const pendingClipboardReads = {};

    // ── Persistence ──
    function cloneState(value) { return JSON.parse(JSON.stringify(value)); }
    function isStateLike(value) {
      return !!value && Array.isArray(value.groups) && Array.isArray(value.items);
    }
    function normalizeState(value) {
      if (!isStateLike(value)) {
        return cloneState(defaultState);
      }

      var groups = value.groups
        .filter(function(group) { return group && typeof group.id === 'string' && group.id.length > 0; })
        .map(function(group) {
          return {
            id: group.id,
            name: typeof group.name === 'string' && group.name.length > 0 ? group.name : 'Untitled',
            collapsed: !!group.collapsed,
          };
        });

      if (groups.length === 0) groups = cloneState(defaultState.groups);

      var groupIds = new Set(groups.map(function(group) { return group.id; }));
      var items = value.items
        .filter(function(item) { return item && typeof item.id === 'string' && item.id.length > 0; })
        .map(function(item) {
          return {
            id: item.id,
            text: typeof item.text === 'string' ? item.text : '',
            completed: !!item.completed,
            groupId: groupIds.has(item.groupId) ? item.groupId : groups[0].id,
            createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          };
        });

      return { groups: groups, items: items };
    }
    function readSavedWebviewState() {
      try {
        var savedState = vscode.getState();
        if (!isStateLike(savedState)) {
          var localState = localStorage.getItem(webviewStorageKey);
          savedState = localState ? JSON.parse(localState) : savedState;
        }
        return normalizeState(savedState);
      } catch (_) {
        return cloneState(defaultState);
      }
    }
    function persistWebviewState(syncToHost, triggerSync) {
      var snapshot = cloneState(state);
      vscode.setState(snapshot);
      localStorage.setItem(webviewStorageKey, JSON.stringify(snapshot));
      if (syncToHost !== false && hasReceivedHostState) {
        vscode.postMessage({ type: 'updateState', state: snapshot, sync: triggerSync !== false });
      }
    }

    // A completed change (edit committed, toggle, add, delete, group op…):
    // save locally + tell the host to auto-push it (debounced).
    function scheduleSave() {
      persistWebviewState(true, true);
    }
    // Interim save while typing: persist locally only, never push.
    function scheduleLocalSave() {
      persistWebviewState(false);
    }
    function flushSave() {
      persistWebviewState(true, true);
    }
    window.addEventListener('beforeunload', flushSave);
    function applyHostState(rawState) {
      state = normalizeState(rawState);
      persistWebviewState(false);
      selectedItemIds.clear();
      render();
    }

    window.addEventListener('message', function(event) {
      var message = event.data;
      if (!message) return;

      if (message.type === 'state') {
        hasReceivedHostState = true;
        // Don't blow away an in-progress edit: stash the latest state and
        // apply it once the user finishes editing (see endEditSession).
        if (isEditing) {
          pendingHostState = message.state;
          return;
        }
        applyHostState(message.state);
        return;
      }

      if (message.type === 'syncComplete') {
        setSyncState(message.ok ? 'success' : 'failed');
        return;
      }

      if (message.type !== 'clipboardReadResult') return;

      var resolver = pendingClipboardReads[message.requestId];
      if (resolver) {
        delete pendingClipboardReads[message.requestId];
        resolver(typeof message.text === 'string' ? message.text : '');
      }
    });

    // ── Helpers ──
    function getGroup(id) { return state.groups.find(function(g) { return g.id === id; }); }
    function getActiveItems(groupId) {
      return state.items.filter(function(i) { return i.groupId === groupId && !i.completed; });
    }
    function getCompletedItems() {
      return state.items.filter(function(i) { return i.completed; });
    }
    function genId() { return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9); }
    function esc(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    // ── Render ──
    var contentEl = document.getElementById('content');
    var clearBar = document.getElementById('clearBar');
    var contextMenuEl = document.getElementById('contextMenu');

    function render() {
      hideContextMenu();
      if (currentTab === 'todo') {
        renderTodoTab();
        clearBar.classList.remove('visible');
      } else {
        renderFinishedTab();
        clearBar.classList.add('visible');
      }
      bindEvents();
    }

    function renderTodoTab() {
      var html = '';
      for (var gi = 0; gi < state.groups.length; gi++) {
        var group = state.groups[gi];
        var items = getActiveItems(group.id);
        html += renderGroup(group, items);
      }
      html += '<div class="add-group-bar"><button class="add-group-btn" id="addGroupBtn">+ Add Group</button></div>';
      contentEl.innerHTML = html;
    }

    function renderGroup(group, items) {
      var arrowClass = group.collapsed ? 'collapsed' : '';
      var bodyClass = group.collapsed ? 'collapsed' : '';
      var incompleteCount = items.length;

      var html = '<div class="group" data-group-id="' + group.id + '">';
      html += '<div class="group-header" data-group-id="' + group.id + '">';
      html += '<span class="group-arrow ' + arrowClass + '">▼</span>';
      html += '<span class="group-name" data-group-id="' + group.id + '">' + esc(group.name) + '</span>';
      html += '<span class="group-count">' + incompleteCount + '</span>';
      html += '<button class="group-delete-btn" data-group-id="' + group.id + '" title="Delete group">✕</button>';
      html += '</div>';
      html += '<div class="group-body ' + bodyClass + '" data-group-id="' + group.id + '">';

      for (var i = 0; i < items.length; i++) {
        html += renderTodoItem(items[i], selectedItemIds.has(items[i].id));
      }

      html += '<div class="create-new-btn" data-group-id="' + group.id + '" title="Create New TODO">';
      html += '<span class="create-new-btn-icon">+</span></div>';
      html += '</div></div>';
      return html;
    }

    function renderTodoItem(item, isSelected) {
      var chk = item.completed ? 'checked' : '';
      var txc = item.completed ? 'completed-text' : '';
      var sel = isSelected ? 'selected' : '';
      return '<div class="todo-item ' + sel + '" data-id="' + item.id + '">'
        + '<div class="todo-checkbox ' + chk + '" data-id="' + item.id + '"></div>'
        + '<span class="todo-text ' + txc + '" data-id="' + item.id + '">' + esc(item.text || '') + '</span>'
        + '<button class="todo-delete-btn" data-id="' + item.id + '" title="Delete">✕</button>'
        + '</div>';
    }

    function renderFinishedTab() {
      var finished = getCompletedItems();
      if (finished.length === 0) {
        contentEl.innerHTML = '<div class="empty-state">No finished items yet.</div>';
        return;
      }
      var html = '';
      for (var gi = 0; gi < state.groups.length; gi++) {
        var group = state.groups[gi];
        var groupItems = finished.filter(function(i) { return i.groupId === group.id; });
        if (groupItems.length === 0) continue;
        html += '<div class="group">';
        html += '<div class="group-header" style="cursor:default">';
        html += '<span class="group-name" data-group-id="' + group.id + '">' + esc(group.name) + '</span>';
        html += '<span class="group-count">' + groupItems.length + ' done</span>';
        html += '</div><div class="group-body">';
        for (var i = 0; i < groupItems.length; i++) {
          var sel = selectedItemIds.has(groupItems[i].id) ? ' selected' : '';
          html += '<div class="todo-item' + sel + '" data-id="' + groupItems[i].id + '">'
            + '<div class="todo-checkbox checked" data-id="' + groupItems[i].id + '"></div>'
            + '<span class="todo-text completed-text">' + esc(groupItems[i].text) + '</span>'
            + '</div>';
        }
        html += '</div></div>';
      }
      contentEl.innerHTML = html;
    }

    // ── Event delegation ──
    var clickHandler = null;
    var dblclickHandler = null;

    function bindEvents() {
      if (clickHandler) contentEl.removeEventListener('click', clickHandler);
      if (dblclickHandler) contentEl.removeEventListener('dblclick', dblclickHandler);

      clickHandler = function(e) {
        hideContextMenu();
        var t = e.target;

        if (t.closest('.group-edit-input')) { e.stopPropagation(); return; }

        var cb = t.closest('.todo-checkbox');
        if (cb && cb.dataset.id) { e.stopPropagation(); toggleComplete(cb.dataset.id); return; }

        var del = t.closest('.todo-delete-btn');
        if (del && del.dataset.id) { e.stopPropagation(); deleteItem(del.dataset.id); return; }

        var cr = t.closest('.create-new-btn');
        if (cr && cr.dataset.groupId) { e.stopPropagation(); createTodo(cr.dataset.groupId); return; }

        var gdel = t.closest('.group-delete-btn');
        if (gdel && gdel.dataset.groupId) { e.stopPropagation(); deleteGroup(gdel.dataset.groupId); return; }

        var groupName = t.closest('.group-name');
        if (groupName && groupName.dataset.groupId && currentTab === 'todo') {
          e.stopPropagation(); return;
        }

        var gh = t.closest('.group-header');
        if (gh && gh.dataset.groupId && gh.style.cursor !== 'default') {
          e.stopPropagation(); toggleGroup(gh.dataset.groupId); return;
        }

        if (t.closest('#addGroupBtn')) { e.stopPropagation(); addGroup(); return; }

        var ti = t.closest('.todo-item');
        if (ti && ti.dataset.id && isSelectableTab()) {
          handleItemClick(ti.dataset.id, e); return;
        }
      };

      dblclickHandler = function(e) {
        var groupName = e.target.closest('.group-name');
        if (groupName && groupName.dataset.groupId && currentTab === 'todo') {
          e.stopPropagation();
          startEditingGroup(groupName.dataset.groupId);
          return;
        }

        var tt = e.target.closest('.todo-text');
        if (tt && tt.dataset.id) {
          e.stopPropagation();
          startEditing(tt.dataset.id, tt);
        }
      };

      contentEl.addEventListener('click', clickHandler);
      contentEl.addEventListener('dblclick', dblclickHandler);
    }

    // ── Context menu ──
    function handleContextMenu(e) {
      if (!isSelectableTab()) return;

      var t = e.target;
      var todo = t.closest('.todo-item');
      if (todo && todo.dataset.id) {
        e.preventDefault();
        e.stopPropagation();
        if (!selectedItemIds.has(todo.dataset.id)) {
          selectedItemIds.clear();
          selectedItemIds.add(todo.dataset.id);
          lastClickedIndex = getAllVisibleIds().indexOf(todo.dataset.id);
          updateSelectionDOM();
        }
        showItemsContextMenu(e.clientX, e.clientY);
        return;
      }

      var groupHeader = t.closest('.group-header');
      if (currentTab === 'todo' && groupHeader && groupHeader.dataset.groupId && groupHeader.style.cursor !== 'default') {
        e.preventDefault();
        e.stopPropagation();
        showGroupContextMenu(groupHeader.dataset.groupId, e.clientX, e.clientY);
      }
    }

    function showItemsContextMenu(x, y) {
      var ids = getSelectedVisibleIds();
      if (ids.length === 0) return;
      contextMenuState = { type: 'items', itemIds: ids };
      contextMenuEl.innerHTML =
        '<button class="context-menu-button" data-action="copy-items" role="menuitem">📋 复制</button>' +
        '<button class="context-menu-button danger" data-action="delete-items" role="menuitem">🗑 删除</button>';
      positionContextMenu(x, y);
    }

    function showGroupContextMenu(groupId, x, y) {
      contextMenuState = { type: 'group', groupId: groupId };
      contextMenuEl.innerHTML =
        '<button class="context-menu-button" data-action="import-clipboard" role="menuitem">🔄 从剪切板导入</button>';
      positionContextMenu(x, y);
    }

    function positionContextMenu(x, y) {
      contextMenuEl.classList.add('visible');
      contextMenuEl.style.left = x + 'px';
      contextMenuEl.style.top = y + 'px';

      var rect = contextMenuEl.getBoundingClientRect();
      var left = Math.min(x, window.innerWidth - rect.width - 4);
      var top = Math.min(y, window.innerHeight - rect.height - 4);
      contextMenuEl.style.left = Math.max(4, left) + 'px';
      contextMenuEl.style.top = Math.max(4, top) + 'px';
    }

    function hideContextMenu() {
      if (!contextMenuEl) return;
      contextMenuEl.classList.remove('visible');
      contextMenuState = null;
    }

    contextMenuEl.addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = e.target.closest('.context-menu-button');
      if (!btn) return;
      var action = btn.dataset.action;
      var menuState = contextMenuState;
      hideContextMenu();

      if (action === 'copy-items' && menuState && menuState.type === 'items') {
        copyItemsToClipboard(menuState.itemIds);
      } else if (action === 'delete-items' && menuState && menuState.type === 'items') {
        deleteItemsByIds(menuState.itemIds);
      } else if (action === 'import-clipboard' && menuState && menuState.type === 'group') {
        importClipboardToGroup(menuState.groupId);
      }
    });

    contentEl.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('click', hideContextMenu);
    window.addEventListener('blur', hideContextMenu);

    // ── Selection ──
    function isSelectableTab() {
      return currentTab === 'todo' || currentTab === 'finished';
    }

    function handleItemClick(id, event) {
      if (event.ctrlKey || event.metaKey) {
        if (selectedItemIds.has(id)) selectedItemIds.delete(id);
        else selectedItemIds.add(id);
      } else if (event.shiftKey && lastClickedIndex >= 0) {
        var allIds = getAllVisibleIds();
        var cur = allIds.indexOf(id);
        if (cur < 0) { lastClickedIndex = -1; render(); return; }
        var start = Math.min(lastClickedIndex, cur);
        var end = Math.max(lastClickedIndex, cur);
        if (!event.ctrlKey && !event.metaKey) selectedItemIds.clear();
        for (var i = start; i <= end; i++) selectedItemIds.add(allIds[i]);
      } else {
        selectedItemIds.clear();
        selectedItemIds.add(id);
      }
      lastClickedIndex = getAllVisibleIds().indexOf(id);
      // Update CSS classes directly instead of full re-render,
      // so double-click editing works (DOM is not destroyed).
      updateSelectionDOM();
    }

    function updateSelectionDOM() {
      var allItems = contentEl.querySelectorAll('.todo-item');
      for (var i = 0; i < allItems.length; i++) {
        var el = allItems[i];
        if (selectedItemIds.has(el.dataset.id)) {
          el.classList.add('selected');
        } else {
          el.classList.remove('selected');
        }
      }
    }

    function getAllVisibleIds() {
      var ids = [];
      for (var gi = 0; gi < state.groups.length; gi++) {
        var items = currentTab === 'finished'
          ? getCompletedItems().filter(function(i) { return i.groupId === state.groups[gi].id; })
          : getActiveItems(state.groups[gi].id);
        for (var i = 0; i < items.length; i++) ids.push(items[i].id);
      }
      return ids;
    }

    function getSelectedVisibleIds() {
      return getAllVisibleIds().filter(function(id) { return selectedItemIds.has(id); });
    }

    // ── Actions ──
    function toggleComplete(id) {
      var item = state.items.find(function(i) { return i.id === id; });
      if (item) { item.completed = !item.completed; scheduleSave(); render(); }
    }

    function deleteItem(id) {
      state.items = state.items.filter(function(i) { return i.id !== id; });
      selectedItemIds.delete(id);
      scheduleSave(); render();
    }

    function deleteSelectedItems() {
      if (selectedItemIds.size === 0) return;
      deleteItemsByIds(Array.from(selectedItemIds));
    }

    function deleteItemsByIds(ids) {
      var idSet = new Set(ids);
      if (idSet.size === 0) return;
      state.items = state.items.filter(function(i) { return !idSet.has(i.id); });
      selectedItemIds.clear();
      scheduleSave(); render();
    }

    async function copyItemsToClipboard(ids) {
      var idSet = new Set(ids);
      var text = getAllVisibleIds()
        .filter(function(id) { return idSet.has(id); })
        .map(function(id) {
          var item = state.items.find(function(i) { return i.id === id; });
          return item ? item.text : '';
        })
        .join('\\n');

      if (!text) return;
      await writeClipboardText(text);
    }

    async function importClipboardToGroup(groupId) {
      var text = await readClipboardText();
      if (!text) return;
      importTextToGroup(groupId, text);
    }

    function importTextToGroup(groupId, text) {
      var group = getGroup(groupId);
      if (!group) return;

      var lines = text
        .split(/\\r?\\n/)
        .map(function(line) { return line.trim(); })
        .filter(function(line) { return line.length > 0; });
      if (lines.length === 0) return;

      var now = Date.now();
      for (var i = 0; i < lines.length; i++) {
        state.items.push({ id: genId(), text: lines[i], completed: false, groupId: groupId, createdAt: now + i });
      }
      group.collapsed = false;
      selectedItemIds.clear();
      scheduleSave(); render();
    }

    async function writeClipboardText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
      } catch (err) {
        console.warn('Clipboard write failed, trying fallback.', err);
      }

      try {
        vscode.postMessage({ type: 'writeClipboard', text: text });
        return;
      } catch (err) {
        console.warn('Host clipboard write failed, trying DOM fallback.', err);
      }

      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(textarea); }
    }

    async function readClipboardText() {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          return await navigator.clipboard.readText();
        }
      } catch (err) {
        console.warn('Clipboard read failed.', err);
      }
      return await readClipboardTextFromHost();
    }

    function readClipboardTextFromHost() {
      return new Promise(function(resolve) {
        var requestId = clipboardRequestSeq++;
        var timeout = setTimeout(function() {
          delete pendingClipboardReads[requestId];
          resolve('');
        }, 3000);

        pendingClipboardReads[requestId] = function(text) {
          clearTimeout(timeout);
          resolve(text);
        };
        vscode.postMessage({ type: 'readClipboard', requestId: requestId });
      });
    }

    function createTodo(groupId) {
      var newItem = { id: genId(), text: '', completed: false, groupId: groupId, createdAt: Date.now() };
      var group = getGroup(groupId);
      if (group) group.collapsed = false;
      state.items.push(newItem);
      selectedItemIds.clear();
      selectedItemIds.add(newItem.id);
      scheduleSave(); render();
      focusTodoForEditing(newItem.id);
    }

    function addGroup() {
      var newGroup = { id: genId(), name: 'Group ' + (state.groups.length + 1), collapsed: false };
      state.groups.push(newGroup);
      scheduleSave(); render();
      setTimeout(function() {
        startEditingGroup(newGroup.id);
      }, 60);
    }

    function toggleGroup(groupId) {
      var group = getGroup(groupId);
      if (group) { group.collapsed = !group.collapsed; scheduleSave(); render(); }
    }

    function deleteGroup(groupId) {
      // Don't allow deleting the last remaining group
      if (state.groups.length <= 1) return;
      state.groups = state.groups.filter(function(g) { return g.id !== groupId; });
      state.items = state.items.filter(function(i) { return i.groupId !== groupId; });
      selectedItemIds.clear();
      scheduleSave(); render();
    }

    function clearAllFinished() {
      state.items = state.items.filter(function(i) { return !i.completed; });
      scheduleSave(); render();
    }

    // ── Inline editing ──
    // While an edit is active we defer any host/sync state update, then apply
    // the last pending one once editing truly ends. The session counter lets a
    // follow-up edit (e.g. Enter creating the next item) claim the session
    // before the deferred flush fires, so we don't yank the next textarea.
    function beginEditSession() {
      isEditing = true;
      editSession++;
    }
    function endEditSession() {
      var mySession = editSession;
      isEditing = false;
      setTimeout(function() {
        if (isEditing || editSession !== mySession) return;
        if (pendingHostState === null) return;
        var pending = pendingHostState;
        pendingHostState = null;
        applyHostState(pending);
      }, 100);
    }

    function focusTodoForEditing(id, attemptsLeft) {
      var attempts = typeof attemptsLeft === 'number' ? attemptsLeft : 6;
      setTimeout(function() {
        var span = contentEl.querySelector('.todo-text[data-id="' + id + '"]');
        if (span) {
          startEditing(id, span);
          return;
        }
        if (attempts > 0) {
          focusTodoForEditing(id, attempts - 1);
        }
      }, 30);
    }

    function startEditingGroup(groupId) {
      var group = getGroup(groupId);
      if (!group || currentTab !== 'todo') return;

      var span = contentEl.querySelector('.group-name[data-group-id="' + groupId + '"]');
      if (!span) return;

      var originalName = group.name;
      var editingDone = false;
      var input = document.createElement('input');
      input.type = 'text';
      input.value = group.name;
      input.className = 'group-edit-input';

      span.parentElement.replaceChild(input, span);
      beginEditSession();
      input.focus();
      input.select();

      input.addEventListener('click', function(e) { e.stopPropagation(); });
      input.addEventListener('dblclick', function(e) { e.stopPropagation(); });

      function commitAndRender() {
        if (editingDone) return;
        editingDone = true;
        group.name = input.value.trim() || 'Untitled';
        scheduleSave();
        render();
        endEditSession();
      }

      function cancelAndRender() {
        if (editingDone) return;
        editingDone = true;
        group.name = originalName;
        scheduleSave();
        render();
        endEditSession();
      }

      input.addEventListener('blur', commitAndRender);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitAndRender();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelAndRender();
        }
      });
    }

    function startEditing(id, _span) {
      var item = state.items.find(function(i) { return i.id === id; });
      if (!item || item.completed) return;
      var originalText = item.text;
      var editingDone = false;

      // Always query the span from the live DOM — the passed reference
      // may be stale if a render() destroyed the original element.
      var span = contentEl.querySelector('.todo-text[data-id="' + id + '"]');
      if (!span) return;

      var textarea = document.createElement('textarea');
      textarea.value = item.text;
      textarea.className = 'todo-edit-input';
      textarea.rows = 1;

      // Auto-resize textarea as content changes
      function autoResize() {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      }

      span.parentElement.replaceChild(textarea, span);
      beginEditSession();
      function focusTextarea() {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        autoResize();
      }
      focusTextarea();
      setTimeout(focusTextarea, 0);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(focusTextarea);
      }

      textarea.addEventListener('input', function() {
        item.text = textarea.value;
        autoResize();
        scheduleLocalSave();
      });

      function commitAndRender() {
        if (editingDone) return;
        editingDone = true;
        item.text = textarea.value.trim();
        scheduleSave();
        render();
        endEditSession();
      }

      function cancelAndRender() {
        if (editingDone) return;
        editingDone = true;
        item.text = originalText;
        scheduleSave();
        render();
        endEditSession();
      }

      // Commit on blur (click outside)
      textarea.addEventListener('blur', function() {
        commitAndRender();
      });

      textarea.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          // Enter without Shift → commit and create new item below
          e.preventDefault();
          commitAndRender();

          // Insert a new empty TODO right after this one
          var groupItems = getActiveItems(item.groupId);
          var idx = groupItems.indexOf(item);
          var newItem = { id: genId(), text: '', completed: false, groupId: item.groupId, createdAt: Date.now() };
          var allIdx = state.items.indexOf(item);
          if (allIdx >= 0 && idx >= 0) {
            state.items.splice(allIdx + 1, 0, newItem);
          } else {
            state.items.push(newItem);
          }
          selectedItemIds.clear();
          selectedItemIds.add(newItem.id);
          scheduleSave();
          render();

          focusTodoForEditing(newItem.id);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          // Cancel — restore original text and re-render
          cancelAndRender();
        }
        // Shift+Enter is allowed to insert a newline (default behaviour)
      });
    }

    // ── Global keyboard shortcuts ──
    document.addEventListener('keydown', function(e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.key === 'Backspace' || e.key === 'Delete') && isSelectableTab() && selectedItemIds.size > 0) {
        e.preventDefault();
        deleteSelectedItems();
      } else if (e.key === 'Escape') {
        hideContextMenu();
        selectedItemIds.clear();
        render();
      } else if (e.key === 'Enter' && selectedItemIds.size === 1 && currentTab === 'todo') {
        e.preventDefault();
        var id = Array.from(selectedItemIds)[0];
        var span = contentEl.querySelector('.todo-text[data-id="' + id + '"]');
        if (span) startEditing(id, span);
      }
    });

    // ── Tab switching ──
    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        selectedItemIds.clear();
        render();
      });
    });

    // ── Clear single-item selection when mouse leaves the list ──
    contentEl.addEventListener('mouseleave', function() {
      if (selectedItemIds.size === 1) {
        selectedItemIds.clear();
        updateSelectionDOM();
      }
    });

    document.getElementById('clearFinishedBtn').addEventListener('click', clearAllFinished);

    // ── Manual sync button ──
    var syncBtnEl = document.getElementById('syncBtn');
    var syncIconEl = syncBtnEl.querySelector('.sync-icon');
    var syncResetTimeout = null;
    function setSyncState(name) {
      if (syncResetTimeout) { clearTimeout(syncResetTimeout); syncResetTimeout = null; }
      syncBtnEl.classList.remove('syncing', 'success', 'failed');
      if (name === 'syncing') {
        syncBtnEl.classList.add('syncing');
        syncIconEl.textContent = '🔄';
        syncBtnEl.title = 'Syncing…';
        // Safety: revert to idle even if the host never replies.
        syncResetTimeout = setTimeout(function() { setSyncState('idle'); }, 8000);
      } else if (name === 'success') {
        syncBtnEl.classList.add('success');
        syncIconEl.textContent = '✓';
        syncBtnEl.title = 'Synced';
        syncResetTimeout = setTimeout(function() { setSyncState('idle'); }, 1500);
      } else if (name === 'failed') {
        syncBtnEl.classList.add('failed');
        syncIconEl.textContent = '✕';
        syncBtnEl.title = 'Sync failed — is Settings Sync turned on?';
        syncResetTimeout = setTimeout(function() { setSyncState('idle'); }, 2500);
      } else {
        syncIconEl.textContent = '🔄';
        syncBtnEl.title = 'Sync now (push + pull)';
      }
    }
    syncBtnEl.addEventListener('click', function() {
      if (syncBtnEl.classList.contains('syncing')) return;
      setSyncState('syncing');
      vscode.postMessage({ type: 'manualSync' });
    });

    vscode.postMessage({ type: 'requestState', state: cloneState(state) });
    render();
  </script>
</body>
</html>`;
  }
}

function isTodoStateLike(value: unknown): value is RawTodoState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeState = value as { groups?: unknown; items?: unknown };
  return Array.isArray(maybeState.groups) && Array.isArray(maybeState.items);
}

function cloneTodoState(value: TodoState): TodoState {
  return JSON.parse(JSON.stringify(value)) as TodoState;
}

function serializeTodoState(state: TodoState): string {
  return JSON.stringify(state);
}

function hasMeaningfulTodoState(state: TodoState): boolean {
  if (state.items.length > 0 || state.groups.length !== DEFAULT_TODO_STATE.groups.length) {
    return true;
  }

  const [group] = state.groups;
  const [defaultGroup] = DEFAULT_TODO_STATE.groups;
  return group.id !== defaultGroup.id || group.name !== defaultGroup.name || group.collapsed !== defaultGroup.collapsed;
}

function normalizeTodoState(value: unknown): TodoState {
  if (!isTodoStateLike(value)) {
    return cloneTodoState(DEFAULT_TODO_STATE);
  }

  let groups: TodoGroup[] = value.groups
    .filter((group): group is Record<string, unknown> => !!group && typeof group === 'object')
    .map((group) => ({
      id: typeof group.id === 'string' && group.id.length > 0 ? group.id : '',
      name: typeof group.name === 'string' && group.name.length > 0 ? group.name : 'Untitled',
      collapsed: !!group.collapsed,
    }))
    .filter((group) => group.id.length > 0);

  if (groups.length === 0) {
    groups = cloneTodoState(DEFAULT_TODO_STATE).groups;
  }

  const groupIds = new Set(groups.map((group) => group.id));
  const items: TodoItem[] = value.items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' && item.id.length > 0 ? item.id : '',
      text: typeof item.text === 'string' ? item.text : '',
      completed: !!item.completed,
      groupId: typeof item.groupId === 'string' && groupIds.has(item.groupId) ? item.groupId : groups[0].id,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    }))
    .filter((item) => item.id.length > 0);

  return { groups, items };
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function activate(context: vscode.ExtensionContext): void {
  context.globalState.setKeysForSync([TODO_STATE_KEY]);

  const provider = new TodoWebviewViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('tiny-todo-list-treeview', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

export function deactivate(): void {}
