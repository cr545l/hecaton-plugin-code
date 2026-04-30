const { CSI, ESC, ansi } = require('./ansi');
const { state, setStatus } = require('./state');
const {
  trimTrailingSlash,
  joinPath,
  dirName,
  resolvePath,
  refreshTree,
  statPath,
  pickFolder,
  setRoot,
  createFile,
  createFolder,
} = require('./fs-ops');
const {
  insertText,
  deleteBackward,
  deleteForward,
  moveCursor,
  moveVertical,
  moveHorizontal,
  moveWord,
  selectAll,
  selectedText,
  deleteSelectionOnly,
  snapshot,
  markDirty,
  undo,
  redo,
  openFile,
  saveFile,
  closeFile,
} = require('./editor');
const { render } = require('./render');
const { screenColToCharIdx } = require('./text');

let currentMouseShape = 'default';
let cursorApiWarningShown = false;
function setMouseShape(shape) {
  shape = shape || 'default';
  if (shape === currentMouseShape) return;
  currentMouseShape = shape;
  state.cursorShape = shape;

  const api = globalThis.hecaton;
  const setCursor = api && api.window && api.window.set_cursor;
  if (typeof setCursor !== 'function') {
    showCursorApiWarning('window.set_cursor is not available');
    return;
  }

  try {
    const result = setCursor({ cursor: shape });
    if (result && typeof result.catch === 'function') {
      result.catch(err => {
        currentMouseShape = '';
        showCursorApiWarning('window.set_cursor failed: ' + errorMessage(err));
      });
    }
  } catch (err) {
    currentMouseShape = '';
    showCursorApiWarning('window.set_cursor failed: ' + errorMessage(err));
  }
}

function showCursorApiWarning(message) {
  if (cursorApiWarningShown) return;
  cursorApiWarningShown = true;
  setStatus(message, 'error', 4000);
  render();
}

function errorMessage(err) {
  if (!err) return 'unknown error';
  if (err.message) return err.message;
  return String(err);
}

function selectedEntry() {
  return state.treeEntries[state.treeCursor] || null;
}

function selectedContextDir() {
  const entry = selectedEntry();
  if (!entry) return state.root;
  return entry.isDir ? entry.path : dirName(entry.path);
}

async function openSelectedEntry() {
  const entry = selectedEntry();
  if (!entry) return;
  if (entry.isDir) {
    toggleDir(entry);
    await refreshTree(entry.path);
    render();
    return;
  }
  await openFile(entry.path);
  render();
}

function toggleDir(entry) {
  const path = trimTrailingSlash(entry.path);
  if (state.expandedDirs.has(path)) state.expandedDirs.delete(path);
  else state.expandedDirs.add(path);
}

async function collapseOrParent() {
  const entry = selectedEntry();
  if (!entry) return;
  if (entry.isDir && state.expandedDirs.has(trimTrailingSlash(entry.path))) {
    state.expandedDirs.delete(trimTrailingSlash(entry.path));
    await refreshTree(entry.path);
    render();
    return;
  }
  const parent = dirName(entry.path);
  const idx = state.treeEntries.findIndex(e => e.path === parent);
  if (idx >= 0) state.treeCursor = idx;
  render();
}

async function expandOrOpen() {
  const entry = selectedEntry();
  if (!entry) return;
  if (entry.isDir) {
    state.expandedDirs.add(trimTrailingSlash(entry.path));
    await refreshTree(entry.path);
    render();
    return;
  }
  await openFile(entry.path);
  render();
}

function moveTree(delta) {
  const max = Math.max(0, state.treeEntries.length - 1);
  state.treeCursor = Math.max(0, Math.min(max, state.treeCursor + delta));
  render();
}

async function changeFolder(folderPath, force) {
  if (!folderPath) return;
  folderPath = resolvePath(folderPath, state.root);
  const st = await statPath(folderPath);
  if (!st || !st.is_dir) {
    setStatus('Folder not found: ' + folderPath, 'error', 4000);
    render();
    return;
  }

  if (state.dirty && !force) {
    state.pendingFolder = folderPath;
    state.pendingDialog = { type: 'dirty-folder' };
    await hecaton.dialog.show({
      type: 'message',
      title: 'Unsaved Changes',
      message: 'Save changes to "' + state.openName + '" before changing folder?',
      buttons: [
        { id: 'save', label: 'Save' },
        { id: 'discard', label: 'Discard' },
        { id: 'cancel', label: 'Cancel', default: true },
      ],
    }).catch(() => { state.pendingDialog = null; state.pendingFolder = ''; });
    return;
  }

  await closeFile(true);
  setRoot(folderPath);
  await refreshTree();
  hecaton.window.set_title({ title: 'Code - ' + (folderPath.split('/').filter(Boolean).pop() || folderPath) }).catch(() => null);
  render();
}

async function chooseFolder() {
  if (!(hecaton.picker && typeof hecaton.picker.folder === 'function')) {
    state.pendingDialog = { type: 'open-folder-input' };
    hecaton.dialog.show({
      type: 'input',
      title: 'Open Folder',
      message: 'Folder path:',
      defaultValue: state.root || '',
      buttons: [
        { id: 'open_folder', label: 'Open', default: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    }).catch(() => { state.pendingDialog = null; });
    return;
  }
  const picked = await pickFolder();
  if (picked) {
    await changeFolder(picked);
    return;
  }
  render();
}

async function pasteFromClipboard() {
  if (state.readonly || !state.openPath) return;
  const result = await hecaton.clipboard.read({}).catch(() => null);
  const text = result && typeof result.text === 'string' ? result.text : '';
  if (text) {
    insertText(text.replace(/\r/g, ''), 'paste');
    render();
  }
}

function copySelection(cut) {
  const text = selectedText();
  if (!text) return;
  hecaton.clipboard.write({ text }).catch(() => null);
  if (cut && !state.readonly) {
    snapshot('delete');
    deleteSelectionOnly();
    markDirty();
  }
}

function toggleTreePanel() {
  state.treeCollapsed = !state.treeCollapsed;
  if (state.treeCollapsed && state.editorCollapsed) state.editorCollapsed = false;
  if (state.treeCollapsed && state.focus === 'tree') state.focus = 'editor';
  if (!state.treeCollapsed && !state.openPath) state.focus = 'tree';
  setStatus(state.treeCollapsed ? 'Explorer hidden' : 'Explorer shown', 'info', 1600);
  render();
}

function toggleEditorPanel() {
  state.editorCollapsed = !state.editorCollapsed;
  if (state.editorCollapsed && state.treeCollapsed) state.treeCollapsed = false;
  if (state.editorCollapsed && state.focus === 'editor') state.focus = 'tree';
  if (!state.editorCollapsed && state.openPath) state.focus = 'editor';
  setStatus(state.editorCollapsed ? 'Editor hidden' : 'Editor shown', 'info', 1600);
  render();
}

function focusNextPanel() {
  if (!state.treeCollapsed && !state.editorCollapsed) {
    state.focus = state.focus === 'tree' ? 'editor' : 'tree';
  } else if (!state.treeCollapsed) {
    state.focus = 'tree';
  } else {
    state.focus = 'editor';
  }
  render();
}

async function handleTreeKey(key) {
  if (key === 'q' || key === 'Q') {
    hecaton.window.close().catch(() => null);
    return;
  }
  if (key === '\x02') {
    toggleTreePanel();
    return;
  }
  if (key === '\t') {
    focusNextPanel();
    return;
  }
  if (key === '\x13') { await saveFile(); render(); return; }
  if (key === '\x0f') { await chooseFolder(); return; }
  if (key === CSI + 'A' || key === 'k') { moveTree(-1); return; }
  if (key === CSI + 'B' || key === 'j') { moveTree(1); return; }
  if (key === CSI + '5~') { moveTree(-Math.max(1, state.layout.bodyH - 2)); return; }
  if (key === CSI + '6~') { moveTree(Math.max(1, state.layout.bodyH - 2)); return; }
  if (key === CSI + 'C') { await expandOrOpen(); return; }
  if (key === CSI + 'D') { await collapseOrParent(); return; }
  if (key === '\r' || key === '\n' || key === ' ') { await openSelectedEntry(); return; }
  if (key === 'r' || key === 'R') { await refreshTree(); render(); return; }
  if (key === 'h' || key === 'H') {
    state.showHidden = !state.showHidden;
    await refreshTree();
    render();
    return;
  }
  if (key === 'o' || key === 'O') { await chooseFolder(); return; }
  if (key === 'n' || key === 'N') { await promptNewFile(); return; }
}

async function handleEditorKey(key) {
  if (key === '\x02') {
    toggleTreePanel();
    return;
  }
  if (key === CSI + 'Z') {
    if (!state.treeCollapsed) state.focus = 'tree';
    render();
    return;
  }
  if (key === '\x13') { await saveFile(); render(); return; }
  if (key === '\x17') { await closeFile(false); render(); return; }
  if (key === '\x0f') { await chooseFolder(); return; }
  if (key === '\x01') { selectAll(); render(); return; }
  if (key === '\x03') { copySelection(false); render(); return; }
  if (key === '\x18') { copySelection(true); render(); return; }
  if (key === '\x16') { await pasteFromClipboard(); return; }
  if (key === '\x1a') { undo(); render(); return; }
  if (key === '\x19') { redo(); render(); return; }

  if (key === CSI + 'A') { moveVertical(-1, false); render(); return; }
  if (key === CSI + 'B') { moveVertical(1, false); render(); return; }
  if (key === CSI + 'C') { moveHorizontal(1, false); render(); return; }
  if (key === CSI + 'D') { moveHorizontal(-1, false); render(); return; }
  if (key === CSI + '1;2A') { moveVertical(-1, true); render(); return; }
  if (key === CSI + '1;2B') { moveVertical(1, true); render(); return; }
  if (key === CSI + '1;2C') { moveHorizontal(1, true); render(); return; }
  if (key === CSI + '1;2D') { moveHorizontal(-1, true); render(); return; }
  if (key === CSI + '1;5C') { moveWord(1, false); render(); return; }
  if (key === CSI + '1;5D') { moveWord(-1, false); render(); return; }
  if (key === CSI + '1;6C') { moveWord(1, true); render(); return; }
  if (key === CSI + '1;6D') { moveWord(-1, true); render(); return; }
  if (key === CSI + 'H' || key === CSI + '1~') { moveCursor(state.cursorRow, 0, false); render(); return; }
  if (key === CSI + 'F' || key === CSI + '4~') { moveCursor(state.cursorRow, state.editLines[state.cursorRow].length, false); render(); return; }
  if (key === CSI + '1;2H') { moveCursor(state.cursorRow, 0, true); render(); return; }
  if (key === CSI + '1;2F') { moveCursor(state.cursorRow, state.editLines[state.cursorRow].length, true); render(); return; }
  if (key === CSI + '5~') { moveVertical(-Math.max(1, state.layout.bodyH - 2), false); render(); return; }
  if (key === CSI + '6~') { moveVertical(Math.max(1, state.layout.bodyH - 2), false); render(); return; }
  if (key === CSI + '3~') { deleteForward(); render(); return; }
  if (key === '\x7f' || key === '\b') { deleteBackward(); render(); return; }
  if (key === '\r' || key === '\n') { insertText('\n', 'newline'); render(); return; }
  if (key === '\t') { insertText('  ', 'insert'); render(); return; }

  if (key.length > 1 && key[0] !== ESC) {
    const text = key.replace(/\r/g, '\n');
    if ([...text].some(ch => ch === '\n' || ch === '\t' || ch.charCodeAt(0) >= 0x20)) {
      insertText(text, 'paste');
      render();
      return;
    }
  }

  if (isPlainText(key)) {
    insertText(key, 'insert');
    render();
  }
}

function isPlainText(key) {
  if (!key) return false;
  if (key[0] === ESC) return false;
  for (const ch of key) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 && ch !== '\n' && ch !== '\t') return false;
  }
  return true;
}

async function handleKey(data) {
  const key = data.toString();
  if (state.loading) return;
  if (state.focus === 'tree') await handleTreeKey(key);
  else await handleEditorKey(key);
}

async function handleMouseData(data) {
  const str = data.toString();
  const match = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return false;
  const cb = parseInt(match[1], 10);
  const cx = parseInt(match[2], 10);
  const cy = parseInt(match[3], 10);
  const pressed = match[4] === 'M';
  const btn = cb & 3;
  const motion = !!(cb & 32);
  const wheel = !!(cb & 64);

  updateCursorForCell(cx, cy);

  if (wheel && pressed) {
    const delta = btn === 0 ? -3 : 3;
    if (cx <= state.layout.treeW) {
      state.focus = 'tree';
      state.treeCursor = Math.max(0, Math.min(Math.max(0, state.treeEntries.length - 1), state.treeCursor + delta));
    } else {
      state.focus = 'editor';
      if (state.openPath) moveVertical(delta, false);
    }
    render();
    return true;
  }

  if (!pressed) {
    state.mouseDown = false;
    state.dragging = null;
    updateCursorForCell(cx, cy);
    return true;
  }

  if (motion && state.dragging) {
    if (state.dragging === 'divider') setDividerFromMouse(cx);
    else setScrollFromMouse(state.dragging, cy);
    render();
    return true;
  }

  if (motion && state.mouseDown && state.focus === 'editor') {
    setEditorCursorFromMouse(cx, cy, true);
    render();
    return true;
  }

  if (btn === 0) {
    if (!motion && cy === 1) {
      const zone = findTitleZone(cx);
      if (zone) {
        if (zone.action === 'toggle-tree') toggleTreePanel();
        if (zone.action === 'toggle-editor') toggleEditorPanel();
        return true;
      }
    }

    if (state.layout.dividerVisible && cx === state.layout.dividerCol &&
        cy >= 2 && cy <= state.layout.bottomSepRow) {
      state.dragging = 'divider';
      setDividerFromMouse(cx);
      render();
      return true;
    }

    if (cy >= state.layout.bodyTop && cy < state.layout.bodyTop + state.layout.bodyH) {
      if (cx === state.layout.treeScrollCol) {
        state.focus = 'tree';
        state.dragging = 'tree-scrollbar';
        setScrollFromMouse(state.dragging, cy);
        render();
      } else if (cx === state.layout.editorScrollCol) {
        state.focus = 'editor';
        state.dragging = 'editor-scrollbar';
        setScrollFromMouse(state.dragging, cy);
        render();
      } else if (cx <= state.layout.treeW) {
        await clickTree(cy);
      } else if (cx > state.layout.dividerCol) {
        clickEditor(cx, cy);
      }
    } else if (cy === 2) {
      state.focus = cx <= state.layout.treeW ? 'tree' : 'editor';
      render();
    }
    return true;
  }

  return true;
}

function handleHostMouseEvent(params) {
  if (!params || state.minimized) return;
  const col = Number.isFinite(params.cell_x) ? Math.floor(params.cell_x) + 1 : 1;
  const row = Number.isFinite(params.cell_y) ? Math.floor(params.cell_y) + 1 : 1;
  updateCursorForCell(col, row);
}

function updateCursorForCell(col, row) {
  setHostCursor(cursorForCell(col, row));
}

function cursorForCell(col, row) {
  if (state.dragging === 'divider') return 'ew-resize';
  if (state.dragging === 'tree-scrollbar' || state.dragging === 'editor-scrollbar') return 'ns-resize';

  if (row === 1 && findTitleZone(col)) return 'pointer';

  if (state.layout.dividerVisible && col === state.layout.dividerCol &&
      row >= 2 && row <= state.layout.bottomSepRow) {
    return 'ew-resize';
  }

  const inBody = row >= state.layout.bodyTop && row < state.layout.bodyTop + state.layout.bodyH;
  if (inBody) {
    if (!state.treeCollapsed && col === state.layout.treeScrollCol) return 'ns-resize';
    if (!state.editorCollapsed && col === state.layout.editorScrollCol) return 'ns-resize';
    if (!state.treeCollapsed && col <= state.layout.treeW) return 'pointer';
    if (!state.editorCollapsed && col >= state.layout.editorCol && col < state.layout.editorScrollCol) {
      return state.openPath ? 'text' : 'default';
    }
  }

  if (row === 2) return 'pointer';
  return 'default';
}

function setHostCursor(cursor) {
  setMouseShape(cursor);
}

function findTitleZone(cx) {
  const zones = state.layout.titleZones || [];
  return zones.find(z => cx >= z.colStart && cx <= z.colEnd) || null;
}

function setDividerFromMouse(cx) {
  const cols = Math.max(40, state.termCols || 80);
  const minTree = Math.min(18, Math.max(8, cols - 24));
  const minEditor = Math.min(24, Math.max(12, cols - minTree - 1));
  const maxTree = Math.max(minTree, cols - minEditor - 1);
  const treeW = Math.max(minTree, Math.min(maxTree, cx - 1));
  state.dividerRatio = treeW / cols;
  state.treeCollapsed = false;
  state.editorCollapsed = false;
}

function setScrollFromMouse(target, cy) {
  const row = Math.max(0, Math.min(state.layout.bodyH - 1, cy - state.layout.bodyTop));
  const denom = Math.max(1, state.layout.bodyH - 1);
  if (target === 'tree-scrollbar') {
    const maxScroll = Math.max(0, state.treeEntries.length - state.layout.bodyH);
    if (maxScroll <= 0) return;
    state.treeScroll = Math.round((row / denom) * maxScroll);
    state.treeCursor = Math.max(0, Math.min(state.treeEntries.length - 1, state.treeScroll));
    return;
  }
  if (target === 'editor-scrollbar') {
    const maxScroll = Math.max(0, state.editLines.length - state.layout.bodyH);
    if (maxScroll <= 0) return;
    state.scrollY = Math.round((row / denom) * maxScroll);
    state.cursorRow = Math.max(0, Math.min(state.editLines.length - 1, state.scrollY));
    state.cursorCol = Math.max(0, Math.min(state.cursorCol, (state.editLines[state.cursorRow] || '').length));
  }
}

async function clickTree(cy) {
  const row = cy - state.layout.bodyTop;
  const idx = state.treeScroll + row;
  if (idx < 0 || idx >= state.treeEntries.length) return;
  const now = Date.now();
  const doubleClick = state.lastClickPane === 'tree' && state.lastClickIndex === idx && now - state.lastClickTime < 420;
  state.lastClickPane = 'tree';
  state.lastClickIndex = idx;
  state.lastClickTime = now;
  state.focus = 'tree';
  state.treeCursor = idx;
  if (doubleClick) await openSelectedEntry();
  else render();
}

function clickEditor(cx, cy) {
  state.focus = 'editor';
  state.mouseDown = true;
  setEditorCursorFromMouse(cx, cy, false);
  render();
}

function setEditorCursorFromMouse(cx, cy, selecting) {
  if (!state.openPath) return;
  const row = state.scrollY + (cy - state.layout.bodyTop);
  const clampedRow = Math.max(0, Math.min(row, state.editLines.length - 1));
  const contentStart = state.layout.editorCol + state.layout.gutterW + 2;
  const screenCol = Math.max(0, Math.min(cx, state.layout.editorScrollCol - 1) - contentStart);
  const actualCol = state.scrollX + screenCol;
  const col = screenColToCharIdx(state.editLines[clampedRow] || '', actualCol);
  moveCursor(clampedRow, col, selecting);
}

async function promptNewFile() {
  state.pendingDialog = { type: 'new-file', targetDir: selectedContextDir() };
  await hecaton.dialog.show({
    type: 'input',
    title: 'New File',
    message: 'File name:',
    defaultValue: '',
    buttons: [
      { id: 'create', label: 'Create', default: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

async function promptNewFolder() {
  state.pendingDialog = { type: 'new-folder', targetDir: selectedContextDir() };
  await hecaton.dialog.show({
    type: 'input',
    title: 'New Folder',
    message: 'Folder name:',
    defaultValue: '',
    buttons: [
      { id: 'create', label: 'Create', default: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

function handleContextMenuRequest(col, row) {
  if (!state.treeCollapsed && row >= state.layout.bodyTop && row < state.layout.bodyTop + state.layout.bodyH && col <= state.layout.treeW) {
    const idx = state.treeScroll + (row - state.layout.bodyTop);
    if (idx >= 0 && idx < state.treeEntries.length) state.treeCursor = idx;
    state.focus = 'tree';
    hecaton.menu.show({ items: getTreeMenuItems() }).catch(() => null);
    render();
    return;
  }
  if (!state.editorCollapsed && col >= state.layout.editorCol) {
    state.focus = 'editor';
    hecaton.menu.show({ items: getEditorMenuItems() }).catch(() => null);
    render();
  }
}

function getTreeMenuItems() {
  const entry = selectedEntry();
  const items = [];
  if (entry) {
    items.push({ id: 'open', label: entry.isDir ? 'Expand/Collapse' : 'Open', icon: entry.isDir ? 'folder-opened' : 'file' });
    items.push({ id: 'copy_path', label: 'Copy Path', icon: 'copy' });
    items.push({ type: 'separator' });
  }
  items.push(
    { id: 'new_file', label: 'New File...', icon: 'new-file' },
    { id: 'new_folder', label: 'New Folder...', icon: 'new-folder' },
    { type: 'separator' },
    { id: 'toggle_tree_panel', label: state.treeCollapsed ? 'Show Explorer' : 'Hide Explorer', icon: 'layout-sidebar-left' },
    { id: 'toggle_editor_panel', label: state.editorCollapsed ? 'Show Editor' : 'Hide Editor', icon: 'layout' },
    { type: 'separator' },
    { id: 'open_folder', label: 'Open Folder...', icon: 'folder-opened' },
    { id: 'refresh', label: 'Refresh', icon: 'refresh' },
    { id: 'toggle_hidden', label: state.showHidden ? 'Hide Dotfiles' : 'Show Dotfiles', icon: 'eye' },
  );
  return items;
}

function getEditorMenuItems() {
  const hasOpen = !!state.openPath;
  const hasSel = !!selectedText();
  return [
    { id: 'save', label: 'Save', shortcut: 'Ctrl+S', icon: 'save', enabled: hasOpen && state.dirty && !state.readonly },
    { id: 'close_file', label: 'Close File', shortcut: 'Ctrl+W', icon: 'close', enabled: hasOpen },
    { type: 'separator' },
    { id: 'toggle_tree_panel', label: state.treeCollapsed ? 'Show Explorer' : 'Hide Explorer', shortcut: 'Ctrl+B', icon: 'layout-sidebar-left' },
    { id: 'toggle_editor_panel', label: state.editorCollapsed ? 'Show Editor' : 'Hide Editor', icon: 'layout' },
    { type: 'separator' },
    { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X', icon: 'cut', enabled: hasSel && !state.readonly },
    { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', enabled: hasSel },
    { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', enabled: hasOpen && !state.readonly },
    { id: 'select_all', label: 'Select All', shortcut: 'Ctrl+A', icon: 'selection', enabled: hasOpen },
    { type: 'separator' },
    { id: 'copy_file_path', label: 'Copy File Path', icon: 'copy', enabled: hasOpen },
  ];
}

async function handleContextMenuAction(actionId) {
  const entry = selectedEntry();
  switch (actionId) {
    case 'open':
      await openSelectedEntry();
      return;
    case 'copy_path':
      if (entry) hecaton.clipboard.write({ text: entry.path }).catch(() => null);
      return;
    case 'new_file':
      await promptNewFile();
      return;
    case 'new_folder':
      await promptNewFolder();
      return;
    case 'open_folder':
      await chooseFolder();
      return;
    case 'refresh':
      await refreshTree();
      render();
      return;
    case 'toggle_hidden':
      state.showHidden = !state.showHidden;
      await refreshTree();
      render();
      return;
    case 'toggle_tree_panel':
      toggleTreePanel();
      return;
    case 'toggle_editor_panel':
      toggleEditorPanel();
      return;
    case 'save':
      await saveFile();
      render();
      return;
    case 'close_file':
      await closeFile(false);
      render();
      return;
    case 'cut':
      copySelection(true);
      render();
      return;
    case 'copy':
      copySelection(false);
      render();
      return;
    case 'paste':
      await pasteFromClipboard();
      return;
    case 'select_all':
      selectAll();
      render();
      return;
    case 'copy_file_path':
      if (state.openPath) hecaton.clipboard.write({ text: state.openPath }).catch(() => null);
      return;
  }
}

async function handleDialogResult(params) {
  const pending = state.pendingDialog;
  if (!pending) return;
  const button = params.button_id || params.id || '';
  const value = params.value || '';
  state.pendingDialog = null;

  if (button === 'cancel') {
    state.pendingOpenPath = '';
    state.pendingFolder = '';
    render();
    return;
  }

  if (pending.type === 'dirty-open') {
    const target = state.pendingOpenPath;
    state.pendingOpenPath = '';
    if (button === 'save') {
      const ok = await saveFile();
      if (ok && target) await openFile(target, { force: true });
    } else if (button === 'discard' && target) {
      await openFile(target, { force: true });
    }
    render();
    return;
  }

  if (pending.type === 'dirty-close') {
    if (button === 'save') {
      const ok = await saveFile();
      if (ok) await closeFile(true);
    } else if (button === 'discard') {
      await closeFile(true);
    }
    render();
    return;
  }

  if (pending.type === 'dirty-folder') {
    const target = state.pendingFolder;
    state.pendingFolder = '';
    if (button === 'save') {
      const ok = await saveFile();
      if (ok) await changeFolder(target, true);
    } else if (button === 'discard') {
      await changeFolder(target, true);
    }
    render();
    return;
  }

  if (pending.type === 'open-folder-input') {
    if (button === 'open_folder' && value) await changeFolder(value);
    else render();
    return;
  }

  if (pending.type === 'new-file' || pending.type === 'new-folder') {
    if (button !== 'create' || !value.trim()) {
      render();
      return;
    }
    const target = resolvePath(value.trim(), pending.targetDir);
    const result = pending.type === 'new-file' ? await createFile(target) : await createFolder(target);
    if (!result.ok) {
      setStatus(result.error || 'Create failed', 'error', 4000);
    } else {
      await refreshTree(target);
      if (pending.type === 'new-file') await openFile(target, { force: true });
      setStatus('Created ' + target, 'success', 2500);
    }
    render();
  }
}

function cleanup() {
  setMouseShape('default');
  process.stdout.write(ansi.showCursor + ansi.reset + ansi.clear);
}

module.exports = {
  handleKey,
  handleMouseData,
  handleHostMouseEvent,
  handleContextMenuRequest,
  handleContextMenuAction,
  handleDialogResult,
  cleanup,
  chooseFolder,
  changeFolder,
};
