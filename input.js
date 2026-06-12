const { CSI, ESC, ansi } = require('./ansi');
const { state, setStatus } = require('./state');
const {
  trimTrailingSlash,
  joinPath,
  baseName,
  dirName,
  resolvePath,
  refreshTree,
  statPath,
  pickFolder,
  setRoot,
  createFile,
  createFolder,
  renamePath,
  copyPath,
  deletePath,
  uniqueCopyPath,
} = require('./fs-ops');
const {
  insertText,
  insertNewline,
  indentUnit,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  deleteToLineStart,
  deleteToLineEnd,
  deleteLine,
  indentLines,
  outdentLines,
  duplicateLines,
  moveLines,
  toggleLineComment,
  moveCursor,
  moveVertical,
  moveHorizontal,
  moveWord,
  moveHome,
  moveLineEnd,
  moveDocumentStart,
  moveDocumentEnd,
  selectAll,
  selectLine,
  selectNextOccurrence,
  addCursor,
  addCursorVertical,
  hasSelection,
  selectedText,
  currentLineText,
  deleteSelection,
  tryInsertPair,
  trySkipClosingPair,
  tryDeletePairBackward,
  findNext,
  replaceNext,
  replaceAllMatches,
  gotoLine,
  canUndo,
  canRedo,
  undo,
  redo,
  openFile,
  saveFile,
  saveFileAs,
  remapOpenPath,
  closeFile,
} = require('./editor');
const { render } = require('./render');
const { screenColToCharIdx, stringWidth, wordBoundsAt } = require('./text');
const { visualRowCount, segmentAt, maxLineDisplayWidth } = require('./wrap');
const { syncSelectionsFromLegacy } = require('./cursor-state');

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
  hecaton.window.set_title({ title: baseName(folderPath) || folderPath }).catch(() => null);
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
  let text = selectedText();
  if (!text && state.openPath) text = currentLineText();
  if (!text) return;
  hecaton.clipboard.write({ text }).catch(() => null);
  if (cut && !state.readonly) {
    if (selectedText()) deleteSelection('cut');
    else deleteLine();
  }
}

function toggleTreePanel() {
  state.treeCollapsed = !state.treeCollapsed;
  if (state.treeCollapsed && state.editorCollapsed) state.editorCollapsed = false;
  if (state.treeCollapsed && state.focus === 'tree') state.focus = 'editor';
  if (!state.treeCollapsed && !state.openPath) state.focus = 'tree';
  setStatus(state.treeCollapsed ? 'Files hidden' : 'Files shown', 'info', 1600);
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

function toggleWordWrap() {
  state.wordWrap = !state.wordWrap;
  state.scrollX = 0;
  state.scrollY = 0;
  state.scrollFreed = false;
  setStatus(state.wordWrap ? 'Word wrap on' : 'Word wrap off', 'info', 1600);
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
  if (key === 'd' || key === 'D') { await duplicateEntry(); return; }
  if (key === ESC + 'OQ' || key === CSI + '12~') { await promptRename(); return; }
  if (key === CSI + '3~') { await promptDelete(); return; }
}

async function handleEditorKey(key) {
  state.scrollFreed = false;
  if (key === '\x02') {
    toggleTreePanel();
    return;
  }
  if (key === '\x13') { await saveFile(); render(); return; }
  if (key === CSI + '83;6u' || key === CSI + '115;6u') { await promptSaveAs(); return; }
  if (key === '\x17') { await closeFile(false); render(); return; }
  if (key === '\x0f') { await chooseFolder(); return; }
  if (key === '\x06') { await promptFind(); return; }
  if (key === '\x12' || key === CSI + '104;5u' || key === CSI + '72;5u') { await promptReplace(); return; }
  if (key === '\x07') { await promptGotoLine(); return; }
  if (key === '\x01') { selectAll(); render(); return; }
  if (key === '\x04') { selectNextOccurrence(); render(); return; }
  if (key === '\x0c') { selectLine(); render(); return; }
  if (key === '\x03') { copySelection(false); render(); return; }
  if (key === '\x18') { copySelection(true); render(); return; }
  if (key === '\x16') { await pasteFromClipboard(); return; }
  if (key === '\x1a') { undo(); render(); return; }
  if (key === '\x19') { redo(); render(); return; }
  if (key === '\x15') { deleteToLineStart(); render(); return; }
  if (key === '\x0b') { deleteToLineEnd(); render(); return; }
  if (key === '\x1f') { toggleLineComment(); render(); return; }
  if (key === ESC + 'z' || key === ESC + 'Z') { toggleWordWrap(); return; }

  if (key === CSI + 'A') { moveVertical(-1, false); render(); return; }
  if (key === CSI + 'B') { moveVertical(1, false); render(); return; }
  if (key === CSI + 'C') { moveHorizontal(1, false); render(); return; }
  if (key === CSI + 'D') { moveHorizontal(-1, false); render(); return; }
  if (key === CSI + '1;3A') { moveLines(-1); render(); return; }
  if (key === CSI + '1;3B') { moveLines(1); render(); return; }
  if (key === CSI + '1;7A') { addCursorVertical(-1); render(); return; }
  if (key === CSI + '1;7B') { addCursorVertical(1); render(); return; }
  if (key === CSI + '1;4A' || key === CSI + '1;4B') { duplicateLines(); render(); return; }
  if (key === CSI + '1;2A') { moveVertical(-1, true); render(); return; }
  if (key === CSI + '1;2B') { moveVertical(1, true); render(); return; }
  if (key === CSI + '1;2C') { moveHorizontal(1, true); render(); return; }
  if (key === CSI + '1;2D') { moveHorizontal(-1, true); render(); return; }
  if (key === CSI + '1;5C') { moveWord(1, false); render(); return; }
  if (key === CSI + '1;5D') { moveWord(-1, false); render(); return; }
  if (key === CSI + '1;6C') { moveWord(1, true); render(); return; }
  if (key === CSI + '1;6D') { moveWord(-1, true); render(); return; }
  if (key === CSI + 'H' || key === CSI + '1~') { moveHome(false); render(); return; }
  if (key === CSI + 'F' || key === CSI + '4~') { moveLineEnd(false); render(); return; }
  if (key === CSI + '1;2H') { moveHome(true); render(); return; }
  if (key === CSI + '1;2F') { moveLineEnd(true); render(); return; }
  if (key === CSI + '1;5H' || key === CSI + '1;5~') { moveDocumentStart(false); render(); return; }
  if (key === CSI + '1;5F' || key === CSI + '4;5~') { moveDocumentEnd(false); render(); return; }
  if (key === CSI + '1;6H') { moveDocumentStart(true); render(); return; }
  if (key === CSI + '1;6F') { moveDocumentEnd(true); render(); return; }
  if (key === CSI + '5~') { moveVertical(-Math.max(1, state.layout.bodyH), false); render(); return; }
  if (key === CSI + '6~') { moveVertical(Math.max(1, state.layout.bodyH), false); render(); return; }
  if (key === CSI + '13~') { findNext(null, false); render(); return; }
  if (key === CSI + '25~' || key === CSI + '1;2R') { findNext(null, true); render(); return; }
  if (key === CSI + '3;5~') { deleteWordForward(); render(); return; }
  if (key === CSI + '127;5u' || key === CSI + '8;5u' || key === ESC + '\x7f') { deleteWordBackward(); render(); return; }
  if (key === CSI + '75;5u' || key === CSI + '75;6u') { deleteLine(); render(); return; }
  if (key === CSI + '3~') { deleteForward(); render(); return; }
  if (key === '\x7f' || key === '\b') {
    if (!tryDeletePairBackward()) deleteBackward();
    render();
    return;
  }
  if (key === '\r' || key === '\n') { insertNewline(); render(); return; }
  if (key === CSI + 'Z') {
    if (state.openPath) outdentLines();
    else if (!state.treeCollapsed) state.focus = 'tree';
    render();
    return;
  }
  if (key === '\t') {
    if (hasSelection()) indentLines();
    else insertText(indentUnit(), 'insert');
    render();
    return;
  }

  if (key.length > 1 && key[0] !== ESC) {
    const text = key.replace(/\r/g, '\n');
    if ([...text].some(ch => ch === '\n' || ch === '\t' || ch.charCodeAt(0) >= 0x20)) {
      insertText(text, 'paste');
      render();
      return;
    }
  }

  if (isPlainText(key)) {
    if (key.length === 1 && (trySkipClosingPair(key) || tryInsertPair(key))) {
      render();
      return;
    }
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
  const addCursorModifier = !!(cb & 8) || !!(cb & 16);

  const hoverChanged = updateHoverForCell(cx, cy);
  updateCursorForCell(cx, cy);
  if (hoverChanged && motion && !wheel && !state.dragging && !state.mouseDown) render();

  if (!pressed && !wheel) {
    const wasDragging = state.dragging;
    state.mouseDown = false;
    state.dragging = null;
    state.panDragStart = null;
    if (wasDragging === 'editor-scrollbar' || wasDragging === 'editor-hscrollbar' || wasDragging === 'pan') {
      state.scrollFreed = true;
      render();
    }
    updateCursorForCell(cx, cy);
    return true;
  }

  if (motion && state.dragging === 'pan' && state.panDragStart) {
    const deltaY = cy - state.panDragStart.y;
    const deltaX = cx - state.panDragStart.x;
    state.scrollY = Math.max(0, Math.min(getMaxEditorScroll(), state.panDragStart.scrollY - deltaY));
    state.scrollX = Math.max(0, Math.min(getMaxEditorScrollX(), state.panDragStart.scrollX - deltaX));
    render();
    return true;
  }

  if (btn === 1 && pressed && !motion && !wheel && state.openPath && isEditorCell(cx, cy)) {
    state.focus = 'editor';
    state.dragging = 'pan';
    state.panDragStart = {
      x: cx,
      y: cy,
      scrollY: state.scrollY,
      scrollX: state.scrollX,
    };
    return true;
  }

  if (wheel && pressed) {
    const wheelStep = (cb & 1) !== 0 ? 3 : -3;
    const wheelBtn = cb & 3;
    const isHorizontalWheel = wheelBtn === 2 || wheelBtn === 3;
    const isShiftWheel = (cb & 4) !== 0;
    const inBody = cy >= state.layout.bodyTop && cy < state.layout.bodyTop + state.layout.bodyH;
    const inEditorCols = !state.editorCollapsed &&
      cx >= state.layout.editorCol &&
      cx <= state.layout.editorScrollCol;
    const inEditorWheelArea = inEditorCols && (inBody || cy === state.layout.editorHScrollRow);

    if ((isHorizontalWheel || isShiftWheel) && state.openPath && inEditorWheelArea) {
      state.focus = 'editor';
      state.scrollFreed = true;
      const prev = state.scrollX;
      state.scrollX = Math.max(0, Math.min(getMaxEditorScrollX(), state.scrollX + wheelStep));
      if (state.scrollX !== prev) render();
      return true;
    }

    if (isHorizontalWheel) return true;

    const delta = wheelStep;
    if (isTreeCell(cx)) {
      state.focus = 'tree';
      state.treeCursor = Math.max(0, Math.min(Math.max(0, state.treeEntries.length - 1), state.treeCursor + delta));
    } else if (isEditorColumn(cx)) {
      state.focus = 'editor';
      if (state.openPath) {
        state.scrollFreed = true;
        state.scrollY = Math.max(0, Math.min(getMaxEditorScroll(), state.scrollY + delta));
      }
    }
    render();
    return true;
  }

  if (motion && state.dragging) {
    if (state.dragging === 'divider') setDividerFromMouse(cx);
    else setScrollFromMouse(state.dragging, cx, cy);
    render();
    return true;
  }

  if (motion && state.mouseDown && state.focus === 'editor') {
    dragEditorCursorFromMouse(cx, cy);
    render();
    return true;
  }

  if (btn === 0) {
    if (!motion) {
      const activityZone = findActivityZone(cx, cy);
      if (activityZone) {
        if (activityZone.enabled !== false) await handleToolbarAction(activityZone.action);
        return true;
      }
    }

    if (!motion && cy === 1) {
      const zone = findTitleZone(cx);
      if (zone) {
        if (zone.enabled !== false) await handleToolbarAction(zone.action);
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

    if (isEditorHScrollCell(cx, cy)) {
      state.focus = 'editor';
      state.dragging = 'editor-hscrollbar';
      setScrollFromMouse(state.dragging, cx, cy);
      render();
      return true;
    }

    if (cy >= state.layout.bodyTop && cy < state.layout.bodyTop + state.layout.bodyH) {
      if (cx === state.layout.treeScrollCol) {
        state.focus = 'tree';
        state.dragging = 'tree-scrollbar';
        setScrollFromMouse(state.dragging, cx, cy);
        render();
      } else if (cx === state.layout.editorScrollCol) {
        state.focus = 'editor';
        state.dragging = 'editor-scrollbar';
        setScrollFromMouse(state.dragging, cx, cy);
        render();
      } else if (isTreeCell(cx)) {
        await clickTree(cy);
      } else if (isEditorColumn(cx)) {
        clickEditor(cx, cy, addCursorModifier);
      }
    } else if (cy === 2) {
      state.focus = isTreeCell(cx) ? 'tree' : 'editor';
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
  const hoverChanged = updateHoverForCell(col, row);
  updateCursorForCell(col, row);
  if (hoverChanged) render();
}

function updateCursorForCell(col, row) {
  setHostCursor(cursorForCell(col, row));
}

function cursorForCell(col, row) {
  if (state.dragging === 'divider') return 'ew-resize';
  if (state.dragging === 'tree-scrollbar' || state.dragging === 'editor-scrollbar') return 'ns-resize';
  if (state.dragging === 'editor-hscrollbar') return 'ew-resize';

  const activityZone = findActivityZone(col, row);
  if (activityZone && activityZone.enabled !== false) return 'pointer';
  const titleZone = row === 1 ? findTitleZone(col) : null;
  if (titleZone && titleZone.enabled !== false) return 'pointer';

  if (state.layout.dividerVisible && col === state.layout.dividerCol &&
      row >= 2 && row <= state.layout.bottomSepRow) {
    return 'ew-resize';
  }

  const inBody = row >= state.layout.bodyTop && row < state.layout.bodyTop + state.layout.bodyH;
  if (inBody) {
    if (!state.treeCollapsed && col === state.layout.treeScrollCol) return 'ns-resize';
    if (!state.editorCollapsed && col === state.layout.editorScrollCol) return 'ns-resize';
    if (isTreeCell(col)) return 'pointer';
    if (!state.editorCollapsed && col >= state.layout.editorCol && col < state.layout.editorScrollCol) {
      return state.openPath ? 'text' : 'default';
    }
  }

  if (isEditorHScrollCell(col, row)) return 'ew-resize';
  return 'default';
}

function setHostCursor(cursor) {
  setMouseShape(cursor);
}

function findTitleZone(cx) {
  const zones = state.layout.titleZones || [];
  return zones.find(z => cx >= z.colStart && cx <= z.colEnd) || null;
}

function findActivityZone(cx, cy) {
  const zones = state.layout.activityZones || [];
  return zones.find(z => cy === z.row && cx >= z.colStart && cx <= z.colEnd) || null;
}

function updateHoverForCell(cx, cy) {
  const zone = findHoverZone(cx, cy);
  const hoveredAction = zone ? (zone.action || '') : '';
  const hoverStatus = zone ? (zone.label || '') : '';
  if (state.hoveredAction === hoveredAction && state.hoverStatus === hoverStatus) return false;
  state.hoveredAction = hoveredAction;
  state.hoverStatus = hoverStatus;
  return true;
}

function findHoverZone(cx, cy) {
  const activityZone = findActivityZone(cx, cy);
  if (activityZone) return activityZone;
  if (cy === 1) return findTitleZone(cx);
  return null;
}

async function handleToolbarAction(action) {
  if (action === 'toggle-tree') {
    toggleTreePanel();
    return;
  }
  if (action === 'toggle-editor') {
    toggleEditorPanel();
    return;
  }
  await handleContextMenuAction(action);
}

function setDividerFromMouse(cx) {
  const cols = Math.max(40, state.termCols || 80);
  const activityW = state.layout.activityW || 0;
  const contentCols = Math.max(1, cols - activityW);
  const minTree = Math.min(18, Math.max(8, contentCols - 24));
  const minEditor = Math.min(24, Math.max(12, contentCols - minTree - 1));
  const maxTree = Math.max(minTree, contentCols - minEditor - 1);
  const treeW = Math.max(minTree, Math.min(maxTree, cx - activityW - 1));
  state.dividerRatio = treeW / contentCols;
  state.treeCollapsed = false;
  state.editorCollapsed = false;
}

function getMaxEditorScroll() {
  if (state.wordWrap && state.openPath) return Math.max(0, visualRowCount() - state.layout.bodyH);
  return Math.max(0, state.editLines.length - state.layout.bodyH);
}

function getEditorContentWidth() {
  return Math.max(1, state.layout.editorW - state.layout.gutterW - 3);
}

function getMaxEditorScrollX() {
  if (state.wordWrap) return 0;
  return Math.max(0, maxLineDisplayWidth() - getEditorContentWidth());
}

function isEditorCell(cx, cy) {
  return !state.editorCollapsed &&
    cy >= state.layout.bodyTop &&
    cy < state.layout.bodyTop + state.layout.bodyH &&
    cx >= state.layout.editorCol &&
    cx < state.layout.editorScrollCol;
}

function isTreeCell(cx) {
  return !state.treeCollapsed &&
    cx >= state.layout.treeCol &&
    cx <= state.layout.treeScrollCol;
}

function isEditorColumn(cx) {
  return !state.editorCollapsed &&
    cx >= state.layout.editorCol &&
    cx <= state.layout.editorScrollCol;
}

function isEditorHScrollCell(cx, cy) {
  const trackCols = getEditorHScrollbarTrackCols();
  return !state.editorCollapsed &&
    state.openPath &&
    getMaxEditorScrollX() > 0 &&
    cy === state.layout.editorHScrollRow &&
    cx >= state.layout.editorCol &&
    cx < state.layout.editorCol + trackCols;
}

function setScrollFromMouse(target, cx, cy) {
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
    const maxScroll = getMaxEditorScroll();
    if (maxScroll <= 0) return;
    state.scrollY = Math.round((row / denom) * maxScroll);
    state.scrollFreed = true;
  }
  if (target === 'editor-hscrollbar') {
    const maxScrollX = getMaxEditorScrollX();
    if (maxScrollX <= 0) return;
    const width = getEditorHScrollbarTrackCols();
    const col = Math.max(0, Math.min(width - 1, cx - state.layout.editorCol));
    const denomX = Math.max(1, width - 1);
    state.scrollX = Math.max(0, Math.min(maxScrollX, Math.round((col / denomX) * maxScrollX)));
    state.scrollFreed = true;
  }
}

function getEditorHScrollbarTrackCols() {
  return Math.max(1, state.layout.editorW - (getMaxEditorScroll() > 0 ? 1 : 0));
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

function clickEditor(cx, cy, addCursorMode) {
  state.focus = 'editor';
  if (!state.openPath) {
    render();
    return;
  }
  state.scrollFreed = false;
  state.mouseDown = true;
  const pos = editorPositionFromMouse(cx, cy);
  if (addCursorMode) {
    state.mouseDown = false;
    state.dragMode = 0;
    addCursor(pos.row, pos.col);
    render();
    return;
  }
  const now = Date.now();
  if (state.lastClickPane === 'editor' && now - state.lastClickTime < 400 &&
      state.lastClickRow === pos.row && Math.abs(state.lastClickCol - pos.col) <= 1) {
    state.clickCount = Math.min(3, state.clickCount + 1);
  } else {
    state.clickCount = 1;
  }
  state.lastClickPane = 'editor';
  state.lastClickTime = now;
  state.lastClickRow = pos.row;
  state.lastClickCol = pos.col;
  state.lastClickIndex = -1;

  if (state.clickCount === 3) {
    selectEditorLine(pos.row);
  } else if (state.clickCount === 2) {
    selectEditorWord(pos.row, pos.col);
  } else {
    state.dragMode = 0;
    moveCursor(pos.row, pos.col, false);
  }
  render();
}

function editorPositionFromMouse(cx, cy) {
  if (!state.openPath) return { row: 0, col: 0 };
  const contentStart = state.layout.editorCol + state.layout.gutterW + 2;
  const screenCol = Math.max(0, Math.min(cx, state.layout.editorScrollCol - 1) - contentStart);

  if (state.wordWrap) {
    const seg = segmentAt(state.scrollY + (cy - state.layout.bodyTop));
    const line = state.editLines[seg.row] || '';
    const within = screenColToCharIdx(line.substring(seg.startCol, seg.endCol), screenCol);
    return {
      row: seg.row,
      col: Math.max(0, Math.min(seg.startCol + within, line.length)),
    };
  }

  const row = state.scrollY + (cy - state.layout.bodyTop);
  const clampedRow = Math.max(0, Math.min(row, state.editLines.length - 1));
  const actualCol = state.scrollX + screenCol;
  const col = screenColToCharIdx(state.editLines[clampedRow] || '', actualCol);
  return {
    row: clampedRow,
    col: Math.max(0, Math.min(col, (state.editLines[clampedRow] || '').length)),
  };
}

function selectEditorWord(row, col) {
  const line = state.editLines[row] || '';
  const wb = wordBoundsAt(line, Math.min(col, Math.max(0, line.length - 1)));
  state.selAnchorRow = row;
  state.selAnchorCol = wb.start;
  state.cursorRow = row;
  state.cursorCol = wb.end;
  state.dragMode = 2;
  state.dragOriginStartRow = row;
  state.dragOriginStartCol = wb.start;
  state.dragOriginEndRow = row;
  state.dragOriginEndCol = wb.end;
  syncSelectionsFromLegacy(state);
}

function selectEditorLine(row) {
  const line = state.editLines[row] || '';
  const cursorRow = row < state.editLines.length - 1 ? row + 1 : row;
  const cursorCol = row < state.editLines.length - 1 ? 0 : line.length;
  state.selAnchorRow = row;
  state.selAnchorCol = 0;
  state.cursorRow = cursorRow;
  state.cursorCol = cursorCol;
  state.dragMode = 3;
  state.dragOriginStartRow = row;
  state.dragOriginStartCol = 0;
  state.dragOriginEndRow = cursorRow;
  state.dragOriginEndCol = cursorCol;
  syncSelectionsFromLegacy(state);
}

function dragEditorCursorFromMouse(cx, cy) {
  if (!state.openPath) return;
  state.scrollFreed = false;
  const pos = editorPositionFromMouse(cx, cy);

  if (state.dragMode === 2) {
    const line = state.editLines[pos.row] || '';
    const wb = wordBoundsAt(line, Math.min(pos.col, Math.max(0, line.length - 1)));
    const forward = pos.row > state.dragOriginEndRow ||
      (pos.row === state.dragOriginEndRow && pos.col >= state.dragOriginEndCol);
    if (forward) {
      state.selAnchorRow = state.dragOriginStartRow;
      state.selAnchorCol = state.dragOriginStartCol;
      state.cursorRow = pos.row;
      state.cursorCol = wb.end;
    } else {
      state.selAnchorRow = state.dragOriginEndRow;
      state.selAnchorCol = state.dragOriginEndCol;
      state.cursorRow = pos.row;
      state.cursorCol = wb.start;
    }
  } else if (state.dragMode === 3) {
    const forward = pos.row >= state.dragOriginEndRow;
    if (forward) {
      state.selAnchorRow = state.dragOriginStartRow;
      state.selAnchorCol = state.dragOriginStartCol;
      if (pos.row < state.editLines.length - 1) {
        state.cursorRow = pos.row + 1;
        state.cursorCol = 0;
      } else {
        state.cursorRow = pos.row;
        state.cursorCol = (state.editLines[pos.row] || '').length;
      }
    } else {
      state.selAnchorRow = state.dragOriginEndRow;
      state.selAnchorCol = state.dragOriginEndCol;
      state.cursorRow = pos.row;
      state.cursorCol = 0;
    }
  } else {
    moveCursor(pos.row, pos.col, true);
  }
  syncSelectionsFromLegacy(state);

  if (cy <= state.layout.bodyTop && state.scrollY > 0) {
    state.scrollY = Math.max(0, state.scrollY - 1);
  } else if (cy >= state.layout.bodyTop + state.layout.bodyH - 1 && state.scrollY < getMaxEditorScroll()) {
    state.scrollY = Math.min(getMaxEditorScroll(), state.scrollY + 1);
  }
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

async function promptSaveAs() {
  if (!state.openPath || state.readonly) return;
  if (hecaton.picker && typeof hecaton.picker.save === 'function') {
    const picked = await hecaton.picker.save({
      default_path: dirName(state.openPath),
      default_name: state.openName,
    }).catch(() => null);
    if (picked && picked.path) await performSaveAs(resolvePath(picked.path, state.root), true);
    else render();
    return;
  }
  state.pendingDialog = { type: 'save-as', targetDir: dirName(state.openPath) };
  await hecaton.dialog.show({
    type: 'input',
    title: 'Save As',
    message: 'Save as:',
    defaultValue: state.openName,
    buttons: [
      { id: 'save_as', label: 'Save', default: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

async function performSaveAs(target, overwriteConfirmed) {
  if (!target || !state.openPath) {
    render();
    return;
  }
  if (target === state.openPath) {
    await saveFile();
    render();
    return;
  }
  const st = await statPath(target);
  if (st && st.is_dir) {
    setStatus('Path is a folder: ' + target, 'error', 4000);
    render();
    return;
  }
  if (st && !overwriteConfirmed) {
    state.pendingDialog = { type: 'save-as-overwrite', targetPath: target };
    await hecaton.dialog.show({
      type: 'message',
      title: 'Overwrite File',
      message: '"' + baseName(target) + '" already exists. Overwrite?',
      buttons: [
        { id: 'overwrite', label: 'Overwrite' },
        { id: 'cancel', label: 'Cancel', default: true },
      ],
    }).catch(() => { state.pendingDialog = null; });
    return;
  }
  const ok = await saveFileAs(target);
  if (ok) await refreshTree(target);
  render();
}

async function promptRename() {
  const entry = selectedEntry();
  if (!entry) return;
  state.pendingDialog = { type: 'rename', targetPath: entry.path };
  await hecaton.dialog.show({
    type: 'input',
    title: entry.isDir ? 'Rename Folder' : 'Rename File',
    message: 'New name:',
    defaultValue: entry.name,
    buttons: [
      { id: 'rename', label: 'Rename', default: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

async function performRename(oldPath, value) {
  const target = resolvePath(value, dirName(oldPath));
  if (!target || target === oldPath) {
    render();
    return;
  }
  if (await statPath(target)) {
    setStatus('Path already exists: ' + (baseName(target) || target), 'error', 4000);
    render();
    return;
  }
  const result = await renamePath(oldPath, target);
  if (!result.ok) {
    setStatus(result.error || 'Rename failed', 'error', 4000);
    render();
    return;
  }
  remapExpandedDirs(oldPath, target);
  remapOpenPath(oldPath, target);
  await refreshTree(target);
  setStatus('Renamed to ' + (baseName(target) || target), 'success', 2500);
  render();
}

function remapExpandedDirs(oldPath, newPath) {
  const next = new Set();
  for (const dir of state.expandedDirs) {
    if (dir === oldPath) next.add(newPath);
    else if (dir.startsWith(oldPath + '/')) next.add(newPath + dir.substring(oldPath.length));
    else next.add(dir);
  }
  state.expandedDirs = next;
}

async function duplicateEntry() {
  const entry = selectedEntry();
  if (!entry) return;
  const target = await uniqueCopyPath(entry.path, entry.isDir);
  if (!target) {
    setStatus('No free name for a copy of ' + entry.name, 'error', 4000);
    render();
    return;
  }
  const result = await copyPath(entry.path, target, entry.isDir);
  if (!result.ok) {
    setStatus(result.error || 'Duplicate failed', 'error', 4000);
    render();
    return;
  }
  await refreshTree(target);
  setStatus('Duplicated to ' + baseName(target), 'success', 2500);
  render();
}

async function promptDelete() {
  const entry = selectedEntry();
  if (!entry) return;
  state.pendingDialog = { type: 'delete', targetPath: entry.path };
  await hecaton.dialog.show({
    type: 'message',
    title: entry.isDir ? 'Delete Folder' : 'Delete File',
    message: 'Delete "' + entry.name + '"' + (entry.isDir ? ' and all of its contents?' : '?') + ' This cannot be undone.',
    buttons: [
      { id: 'delete', label: 'Delete' },
      { id: 'cancel', label: 'Cancel', default: true },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

async function performDelete(targetPath) {
  const result = await deletePath(targetPath);
  if (!result.ok) {
    setStatus(result.error || 'Delete failed', 'error', 4000);
    render();
    return;
  }
  if (state.openPath && (state.openPath === targetPath || state.openPath.startsWith(targetPath + '/'))) {
    await closeFile(true);
  }
  for (const dir of [...state.expandedDirs]) {
    if (dir === targetPath || dir.startsWith(targetPath + '/')) state.expandedDirs.delete(dir);
  }
  await refreshTree();
  setStatus('Deleted ' + (baseName(targetPath) || targetPath), 'success', 2500);
  render();
}

function handleContextMenuRequest(col, row) {
  if (!state.treeCollapsed && row >= state.layout.bodyTop && row < state.layout.bodyTop + state.layout.bodyH && isTreeCell(col)) {
    const idx = state.treeScroll + (row - state.layout.bodyTop);
    if (idx >= 0 && idx < state.treeEntries.length) state.treeCursor = idx;
    state.focus = 'tree';
    hecaton.menu.show({ items: getTreeMenuItems() }).catch(() => null);
    render();
    return;
  }
  if (isEditorColumn(col)) {
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
    items.push({ id: 'rename_entry', label: 'Rename...', shortcut: 'F2', icon: 'edit' });
    items.push({ id: 'duplicate_entry', label: 'Duplicate', shortcut: 'D', icon: 'files' });
    items.push({ id: 'delete_entry', label: 'Delete...', shortcut: 'Del', icon: 'trash' });
    items.push({ type: 'separator' });
  }
  items.push(
    { id: 'new_file', label: 'New File...', icon: 'new-file' },
    { id: 'new_folder', label: 'New Folder...', icon: 'new-folder' },
    { type: 'separator' },
    { id: 'toggle_tree_panel', label: state.treeCollapsed ? 'Show Files' : 'Hide Files', icon: 'layout-sidebar-left' },
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
    { id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z', icon: 'undo', enabled: canUndo() },
    { id: 'redo', label: 'Redo', shortcut: 'Ctrl+Y', icon: 'redo', enabled: canRedo() },
    { type: 'separator' },
    { id: 'save', label: 'Save', shortcut: 'Ctrl+S', icon: 'save', enabled: hasOpen && state.dirty && !state.readonly },
    { id: 'save_as', label: 'Save As...', shortcut: 'Ctrl+Shift+S', icon: 'save-as', enabled: hasOpen && !state.readonly },
    { id: 'close_file', label: 'Close File', shortcut: 'Ctrl+W', icon: 'close', enabled: hasOpen },
    { type: 'separator' },
    { id: 'toggle_tree_panel', label: state.treeCollapsed ? 'Show Files' : 'Hide Files', shortcut: 'Ctrl+B', icon: 'layout-sidebar-left' },
    { id: 'toggle_editor_panel', label: state.editorCollapsed ? 'Show Editor' : 'Hide Editor', icon: 'layout' },
    { id: 'toggle_wrap', label: state.wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap', shortcut: 'Alt+Z', icon: 'word-wrap', enabled: hasOpen },
    { type: 'separator' },
    { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X', icon: 'cut', enabled: hasSel && !state.readonly },
    { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', enabled: hasSel },
    { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', enabled: hasOpen && !state.readonly },
    { id: 'select_all', label: 'Select All', shortcut: 'Ctrl+A', icon: 'selection', enabled: hasOpen },
    { id: 'select_line', label: 'Select Line', shortcut: 'Ctrl+L', icon: 'selection', enabled: hasOpen },
    { id: 'select_next_occurrence', label: 'Select Next Occurrence', shortcut: 'Ctrl+D', icon: 'selection', enabled: hasOpen },
    { type: 'separator' },
    { id: 'find', label: 'Find...', shortcut: 'Ctrl+F', icon: 'search', enabled: hasOpen },
    { id: 'find_next', label: 'Find Next', shortcut: 'F3', icon: 'arrow-down', enabled: hasOpen && !!state.findQuery },
    { id: 'find_previous', label: 'Find Previous', shortcut: 'Shift+F3', icon: 'arrow-up', enabled: hasOpen && !!state.findQuery },
    { id: 'replace', label: 'Replace...', shortcut: 'Ctrl+R', icon: 'replace', enabled: hasOpen && !state.readonly },
    { id: 'goto_line', label: 'Go to Line...', shortcut: 'Ctrl+G', icon: 'go-to-file', enabled: hasOpen },
    { type: 'separator' },
    { id: 'toggle_comment', label: 'Toggle Line Comment', shortcut: 'Ctrl+/', icon: 'comment', enabled: hasOpen && !state.readonly },
    { id: 'delete_line', label: hasSel ? 'Delete Selected Lines' : 'Delete Line', icon: 'trash', enabled: hasOpen && !state.readonly },
    { id: 'duplicate_line', label: hasSel ? 'Duplicate Selected Lines' : 'Duplicate Line', icon: 'copy', enabled: hasOpen && !state.readonly },
    { id: 'move_line_up', label: 'Move Line Up', icon: 'arrow-up', enabled: hasOpen && !state.readonly },
    { id: 'move_line_down', label: 'Move Line Down', icon: 'arrow-down', enabled: hasOpen && !state.readonly },
    { type: 'separator' },
    { id: 'copy_file_path', label: 'Copy File Path', icon: 'copy', enabled: hasOpen },
  ];
}

async function handleContextMenuAction(actionId) {
  const entry = selectedEntry();
  switch (actionId) {
    case 'undo':
      undo();
      render();
      return;
    case 'redo':
      redo();
      render();
      return;
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
    case 'rename_entry':
      await promptRename();
      return;
    case 'duplicate_entry':
      await duplicateEntry();
      return;
    case 'delete_entry':
      await promptDelete();
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
    case 'toggle_wrap':
      toggleWordWrap();
      return;
    case 'save':
      await saveFile();
      render();
      return;
    case 'save_as':
      await promptSaveAs();
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
    case 'select_line':
      selectLine();
      render();
      return;
    case 'select_next_occurrence':
      selectNextOccurrence();
      render();
      return;
    case 'find':
      await promptFind();
      return;
    case 'replace':
      await promptReplace();
      return;
    case 'find_next':
      findNext(null, false);
      render();
      return;
    case 'find_previous':
      findNext(null, true);
      render();
      return;
    case 'goto_line':
      await promptGotoLine();
      return;
    case 'toggle_comment':
      toggleLineComment();
      render();
      return;
    case 'delete_line':
      deleteLine();
      render();
      return;
    case 'duplicate_line':
      duplicateLines();
      render();
      return;
    case 'move_line_up':
      moveLines(-1);
      render();
      return;
    case 'move_line_down':
      moveLines(1);
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

  if (pending.type === 'rename') {
    if (button === 'rename' && value.trim()) await performRename(pending.targetPath, value.trim());
    else render();
    return;
  }

  if (pending.type === 'delete') {
    if (button === 'delete') await performDelete(pending.targetPath);
    else render();
    return;
  }

  if (pending.type === 'save-as') {
    if (button === 'save_as' && value.trim()) await performSaveAs(resolvePath(value.trim(), pending.targetDir), false);
    else render();
    return;
  }

  if (pending.type === 'save-as-overwrite') {
    if (button === 'overwrite') await performSaveAs(pending.targetPath, true);
    else render();
    return;
  }

  if (pending.type === 'find') {
    if (button === 'toggle_case') {
      state.findCaseSensitive = !state.findCaseSensitive;
      await promptFind(value);
      return;
    }
    if (button === 'find') {
      if (value) findNext(value, false);
      else state.findQuery = '';
    }
    render();
    return;
  }

  if (pending.type === 'replace-find') {
    if (button === 'toggle_case') {
      state.findCaseSensitive = !state.findCaseSensitive;
      await promptReplace(value);
      return;
    }
    if (button === 'next' && value) {
      state.findQuery = value;
      await promptReplaceWith(value);
      return;
    }
    render();
    return;
  }

  if (pending.type === 'replace-with') {
    state.replaceText = value;
    if (button === 'replace') {
      replaceNext(pending.query, value);
    } else if (button === 'replace_all') {
      const count = replaceAllMatches(pending.query, value);
      setStatus(count
        ? 'Replaced ' + count + ' occurrence' + (count === 1 ? '' : 's')
        : 'No matches: ' + pending.query, count ? 'success' : 'error', 3000);
    }
    render();
    return;
  }

  if (pending.type === 'goto-line') {
    if (button === 'go' && value) gotoLine(parseInt(value, 10));
    render();
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
      setStatus('Created ' + (baseName(target) || target), 'success', 2500);
    }
    render();
  }
}

async function promptFind(seedOverride) {
  const selected = selectedText();
  const seed = seedOverride != null
    ? seedOverride
    : (selected && selected.indexOf('\n') < 0 ? selected : state.findQuery);
  state.pendingDialog = { type: 'find' };
  await hecaton.dialog.show({
    type: 'input',
    title: 'Find' + (state.findCaseSensitive ? ' (case sensitive)' : ''),
    message: 'Find:',
    defaultValue: seed || '',
    buttons: [
      { id: 'find', label: 'Find', default: true },
      { id: 'toggle_case', label: state.findCaseSensitive ? 'Aa: On' : 'Aa: Off' },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

async function promptReplace(seedOverride) {
  if (!state.openPath || state.readonly) return;
  const selected = selectedText();
  const seed = seedOverride != null
    ? seedOverride
    : (selected && selected.indexOf('\n') < 0 ? selected : state.findQuery);
  state.pendingDialog = { type: 'replace-find' };
  await hecaton.dialog.show({
    type: 'input',
    title: 'Replace' + (state.findCaseSensitive ? ' (case sensitive)' : ''),
    message: 'Find:',
    defaultValue: seed || '',
    buttons: [
      { id: 'next', label: 'Next', default: true },
      { id: 'toggle_case', label: state.findCaseSensitive ? 'Aa: On' : 'Aa: Off' },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

async function promptReplaceWith(query) {
  state.pendingDialog = { type: 'replace-with', query };
  await hecaton.dialog.show({
    type: 'input',
    title: 'Replace',
    message: 'Replace "' + query + '" with:',
    defaultValue: state.replaceText || '',
    buttons: [
      { id: 'replace', label: 'Replace', default: true },
      { id: 'replace_all', label: 'Replace All' },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

async function promptGotoLine() {
  state.pendingDialog = { type: 'goto-line' };
  await hecaton.dialog.show({
    type: 'input',
    title: 'Go to Line',
    message: 'Line number:',
    defaultValue: String(state.cursorRow + 1),
    buttons: [
      { id: 'go', label: 'Go', default: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).catch(() => { state.pendingDialog = null; });
}

function cleanup() {
  setMouseShape('default');
  process.stdout.write(ansi.blockCursor + ansi.showCursor + ansi.reset + ansi.clear);
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
