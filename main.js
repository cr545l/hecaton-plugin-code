#!/usr/bin/env node

/**
 * Code - Hecaton Plugin
 *
 * Focused file browser and editor inspired by the local explorer, note, and
 * git-client plugins. It intentionally omits Git, terminal, command palette,
 * and extension surfaces so the overlay stays centered on previewing and
 * editing files under one selected folder.
 */

const { state, init: initState, setStatus } = require('./state');
const { render } = require('./render');
const {
  normalizePath,
  dirName,
  baseName,
  statPath,
  refreshTree,
  setRoot,
} = require('./fs-ops');
const { openFile } = require('./editor');
const {
  handleKey,
  handleMouseData,
  handleHostMouseEvent,
  handleContextMenuRequest,
  handleContextMenuAction,
  handleDialogResult,
  cleanup,
} = require('./input');

let watcherTimer = null;
let watcherBusy = false;
let blinkTimer = null;

async function getInitialPath() {
  const params = hecaton.initialState && hecaton.initialState.params;
  if (params && params.path) return normalizePath(params.path);
  if (hecaton.initialState && hecaton.initialState.cwd) return normalizePath(hecaton.initialState.cwd);
  const cwd = await hecaton.terminal.get_cwd().catch(() => null);
  if (cwd && cwd.cwd) return normalizePath(cwd.cwd);
  return normalizePath(process.cwd());
}

async function loadInitialWorkspace() {
  let initialPath = await getInitialPath();
  let initialFile = '';
  let stat = await statPath(initialPath);

  if (!stat) {
    const cwd = await hecaton.terminal.get_cwd().catch(() => null);
    initialPath = normalizePath((cwd && cwd.cwd) || process.cwd());
    stat = await statPath(initialPath);
  }

  if (stat && !stat.is_dir) {
    initialFile = initialPath;
    initialPath = dirName(initialPath);
  }

  setRoot(initialPath);
  state.loading = false;
  await refreshTree(initialFile);

  if (initialFile) {
    const idx = state.treeEntries.findIndex(e => e.path === initialFile);
    if (idx >= 0) state.treeCursor = idx;
    await openFile(initialFile, { force: true, keepFocus: false });
  }

  hecaton.window.set_title({ title: baseName(state.root) || state.root }).catch(() => null);
}

function setupEvents() {
  hecaton.on('window_resized', params => {
    state.termCols = params.cols || state.termCols;
    state.termRows = params.rows || state.termRows;
    if (params.cell_width) state.cellW = Math.round(params.cell_width);
    if (params.cell_height) state.cellH = Math.round(params.cell_height);
    render();
  });
  hecaton.on('window_minimized', () => {
    state.minimized = true;
    render();
  });
  hecaton.on('window_restored', async () => {
    state.minimized = false;
    await refreshTree().catch(() => null);
    render();
  });
  hecaton.on('window_maximized', () => render());
  hecaton.on('mouse_event', params => {
    handleHostMouseEvent(params);
  });
  hecaton.on('menu_requested', params => {
    handleContextMenuRequest(params.col, params.row);
  });
  hecaton.on('menu_activated', params => {
    handleContextMenuAction(params.id || params.action_id).catch(() => null);
  });
  hecaton.on('dialog_resolved', params => {
    handleDialogResult(params).catch(() => null);
  });
}

function setupInput() {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch {
    // Not a TTY under some runners.
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async data => {
    if (state.loading) return;
    resetCursorBlink();
    const hadMouse = await handleMouseData(data);
    if (hadMouse) return;
    await handleKey(data);
  });
}

function resetCursorBlink() {
  state.cursorBlinkOn = true;
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    state.cursorBlinkOn = !state.cursorBlinkOn;
    render();
  }, 530);
}

function setupWatcher() {
  watcherTimer = setInterval(async () => {
    if (watcherBusy || state.loading || state.minimized || !state.root) return;
    watcherBusy = true;
    try {
      const selected = state.treeEntries[state.treeCursor] && state.treeEntries[state.treeCursor].path;
      await refreshTree(selected);

      if (state.openPath && !state.dirty && !state.readonly) {
        const st = await statPath(state.openPath);
        if (st && st.mtime_ms && state.fileMtimeMs && st.mtime_ms !== state.fileMtimeMs) {
          await openFile(state.openPath, { force: true, keepFocus: true });
          setStatus('Reloaded external changes: ' + state.openName, 'info', 2400);
        }
      }

      render();
    } catch {
      // Keep watcher best-effort.
    } finally {
      watcherBusy = false;
    }
  }, 3500);
}

function shutdown() {
  if (blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  cleanup();
}

async function main() {
  setupEvents();
  setupInput();
  await initState();

  const cell = await hecaton.window.get_cell_size().catch(() => null);
  if (cell && cell.cell_width && cell.cell_height) {
    state.cellW = Math.round(cell.cell_width);
    state.cellH = Math.round(cell.cell_height);
  }

  render();
  await loadInitialWorkspace();
  render();
  resetCursorBlink();
  setupWatcher();

  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.stdin.on('end', () => { shutdown(); process.exit(0); });
}

main().catch(err => {
  process.stderr.write('Code plugin error: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
