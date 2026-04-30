const { state, setStatus } = require('./state');
const { baseName, readTextFile, writeTextFile } = require('./fs-ops');
const { wordLeft, wordRight } = require('./text');

function setLinesFromContent(content) {
  const text = String(content || '').replace(/\r/g, '');
  state.editLines = text.length ? text.split('\n') : [''];
}

function contentFromLines() {
  return state.editLines.join('\n');
}

function clampCursor() {
  if (state.editLines.length === 0) state.editLines = [''];
  state.cursorRow = Math.max(0, Math.min(state.cursorRow, state.editLines.length - 1));
  state.cursorCol = Math.max(0, Math.min(state.cursorCol, state.editLines[state.cursorRow].length));
}

function hasSelection() {
  return state.selAnchorRow >= 0 &&
    (state.selAnchorRow !== state.cursorRow || state.selAnchorCol !== state.cursorCol);
}

function clearSelection() {
  state.selAnchorRow = -1;
  state.selAnchorCol = -1;
}

function startSelection() {
  if (state.selAnchorRow < 0) {
    state.selAnchorRow = state.cursorRow;
    state.selAnchorCol = state.cursorCol;
  }
}

function getSelectionRange() {
  if (!hasSelection()) return null;
  let startRow = state.selAnchorRow;
  let startCol = state.selAnchorCol;
  let endRow = state.cursorRow;
  let endCol = state.cursorCol;
  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol];
  }
  return { startRow, startCol, endRow, endCol };
}

function selectedText() {
  const r = getSelectionRange();
  if (!r) return '';
  if (r.startRow === r.endRow) {
    return state.editLines[r.startRow].substring(r.startCol, r.endCol);
  }
  const out = [state.editLines[r.startRow].substring(r.startCol)];
  for (let row = r.startRow + 1; row < r.endRow; row++) out.push(state.editLines[row]);
  out.push(state.editLines[r.endRow].substring(0, r.endCol));
  return out.join('\n');
}

function deleteSelectionOnly() {
  const r = getSelectionRange();
  if (!r) return false;
  const before = state.editLines[r.startRow].substring(0, r.startCol);
  const after = state.editLines[r.endRow].substring(r.endCol);
  state.editLines.splice(r.startRow, r.endRow - r.startRow + 1, before + after);
  state.cursorRow = r.startRow;
  state.cursorCol = r.startCol;
  clearSelection();
  clampCursor();
  return true;
}

function snapshot(type) {
  const now = Date.now();
  if (type && type === state.lastUndoType && now - state.lastUndoTime < 450 && state.undoStack.length > 0) {
    state.lastUndoTime = now;
    return;
  }
  state.undoStack.push({
    lines: state.editLines.slice(),
    cursorRow: state.cursorRow,
    cursorCol: state.cursorCol,
    selAnchorRow: state.selAnchorRow,
    selAnchorCol: state.selAnchorCol,
    dirty: state.dirty,
  });
  if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
  state.redoStack = [];
  state.lastUndoType = type || '';
  state.lastUndoTime = now;
}

function markDirty() {
  state.dirty = contentFromLines() !== state.originalContent;
}

function undo() {
  if (!state.undoStack.length || state.readonly) return;
  state.scrollFreed = false;
  state.redoStack.push({
    lines: state.editLines.slice(),
    cursorRow: state.cursorRow,
    cursorCol: state.cursorCol,
    selAnchorRow: state.selAnchorRow,
    selAnchorCol: state.selAnchorCol,
    dirty: state.dirty,
  });
  const s = state.undoStack.pop();
  state.editLines = s.lines.slice();
  state.cursorRow = s.cursorRow;
  state.cursorCol = s.cursorCol;
  state.selAnchorRow = s.selAnchorRow;
  state.selAnchorCol = s.selAnchorCol;
  markDirty();
  clampCursor();
}

function redo() {
  if (!state.redoStack.length || state.readonly) return;
  state.scrollFreed = false;
  state.undoStack.push({
    lines: state.editLines.slice(),
    cursorRow: state.cursorRow,
    cursorCol: state.cursorCol,
    selAnchorRow: state.selAnchorRow,
    selAnchorCol: state.selAnchorCol,
    dirty: state.dirty,
  });
  const s = state.redoStack.pop();
  state.editLines = s.lines.slice();
  state.cursorRow = s.cursorRow;
  state.cursorCol = s.cursorCol;
  state.selAnchorRow = s.selAnchorRow;
  state.selAnchorCol = s.selAnchorCol;
  markDirty();
  clampCursor();
}

function insertText(text, type) {
  if (state.readonly || !state.openPath) return;
  state.scrollFreed = false;
  snapshot(type || 'insert');
  deleteSelectionOnly();
  text = String(text || '').replace(/\r/g, '');
  const parts = text.split('\n');
  const line = state.editLines[state.cursorRow];
  const before = line.substring(0, state.cursorCol);
  const after = line.substring(state.cursorCol);
  if (parts.length === 1) {
    state.editLines[state.cursorRow] = before + parts[0] + after;
    state.cursorCol += parts[0].length;
  } else {
    const replacement = [before + parts[0]];
    for (let i = 1; i < parts.length - 1; i++) replacement.push(parts[i]);
    replacement.push(parts[parts.length - 1] + after);
    state.editLines.splice(state.cursorRow, 1, ...replacement);
    state.cursorRow += replacement.length - 1;
    state.cursorCol = parts[parts.length - 1].length;
  }
  clearSelection();
  markDirty();
}

function deleteBackward() {
  if (state.readonly || !state.openPath) return;
  state.scrollFreed = false;
  snapshot('delete');
  if (deleteSelectionOnly()) {
    markDirty();
    return;
  }
  if (state.cursorCol > 0) {
    const line = state.editLines[state.cursorRow];
    state.editLines[state.cursorRow] = line.substring(0, state.cursorCol - 1) + line.substring(state.cursorCol);
    state.cursorCol--;
  } else if (state.cursorRow > 0) {
    const prevLen = state.editLines[state.cursorRow - 1].length;
    state.editLines[state.cursorRow - 1] += state.editLines[state.cursorRow];
    state.editLines.splice(state.cursorRow, 1);
    state.cursorRow--;
    state.cursorCol = prevLen;
  }
  markDirty();
}

function deleteForward() {
  if (state.readonly || !state.openPath) return;
  state.scrollFreed = false;
  snapshot('delete');
  if (deleteSelectionOnly()) {
    markDirty();
    return;
  }
  const line = state.editLines[state.cursorRow];
  if (state.cursorCol < line.length) {
    state.editLines[state.cursorRow] = line.substring(0, state.cursorCol) + line.substring(state.cursorCol + 1);
  } else if (state.cursorRow < state.editLines.length - 1) {
    state.editLines[state.cursorRow] += state.editLines[state.cursorRow + 1];
    state.editLines.splice(state.cursorRow + 1, 1);
  }
  markDirty();
}

function moveCursor(row, col, selecting) {
  state.scrollFreed = false;
  if (selecting) startSelection();
  else clearSelection();
  state.cursorRow = Math.max(0, Math.min(row, state.editLines.length - 1));
  state.cursorCol = Math.max(0, Math.min(col, state.editLines[state.cursorRow].length));
  if (!selecting && state.selAnchorRow >= 0) clearSelection();
}

function moveVertical(delta, selecting) {
  const row = Math.max(0, Math.min(state.cursorRow + delta, state.editLines.length - 1));
  const col = Math.min(state.cursorCol, state.editLines[row].length);
  moveCursor(row, col, selecting);
}

function moveHorizontal(delta, selecting) {
  state.desiredCol = null;
  if (!selecting && hasSelection()) {
    const r = getSelectionRange();
    if (delta < 0) moveCursor(r.startRow, r.startCol, false);
    else moveCursor(r.endRow, r.endCol, false);
    return;
  }
  if (delta < 0) {
    if (state.cursorCol > 0) moveCursor(state.cursorRow, state.cursorCol - 1, selecting);
    else if (state.cursorRow > 0) moveCursor(state.cursorRow - 1, state.editLines[state.cursorRow - 1].length, selecting);
  } else {
    const line = state.editLines[state.cursorRow] || '';
    if (state.cursorCol < line.length) moveCursor(state.cursorRow, state.cursorCol + 1, selecting);
    else if (state.cursorRow < state.editLines.length - 1) moveCursor(state.cursorRow + 1, 0, selecting);
  }
}

function moveWord(delta, selecting) {
  state.desiredCol = null;
  const line = state.editLines[state.cursorRow] || '';
  if (delta < 0) {
    if (state.cursorCol > 0) moveCursor(state.cursorRow, wordLeft(line, state.cursorCol), selecting);
    else if (state.cursorRow > 0) moveCursor(state.cursorRow - 1, state.editLines[state.cursorRow - 1].length, selecting);
  } else {
    if (state.cursorCol < line.length) moveCursor(state.cursorRow, wordRight(line, state.cursorCol), selecting);
    else if (state.cursorRow < state.editLines.length - 1) moveCursor(state.cursorRow + 1, 0, selecting);
  }
}

function selectAll() {
  state.scrollFreed = false;
  state.selAnchorRow = 0;
  state.selAnchorCol = 0;
  state.cursorRow = state.editLines.length - 1;
  state.cursorCol = state.editLines[state.cursorRow].length;
}

async function openFile(filePath, opts) {
  opts = opts || {};
  if (state.dirty && state.openPath && state.openPath !== filePath && !opts.force) {
    state.pendingOpenPath = filePath;
    state.pendingDialog = { type: 'dirty-open' };
    await hecaton.dialog.show({
      type: 'message',
      title: 'Unsaved Changes',
      message: 'Save changes to "' + state.openName + '" before opening another file?',
      buttons: [
        { id: 'save', label: 'Save' },
        { id: 'discard', label: 'Discard' },
        { id: 'cancel', label: 'Cancel', default: true },
      ],
    }).catch(() => { state.pendingDialog = null; state.pendingOpenPath = ''; });
    return false;
  }

  const result = await readTextFile(filePath);
  if (!result.ok) {
    state.openPath = filePath;
    state.openName = baseName(filePath);
    state.originalContent = '';
    state.editLines = [result.error || 'Cannot open file'];
    state.cursorRow = 0;
    state.cursorCol = 0;
    state.scrollY = 0;
    state.scrollX = 0;
    state.scrollFreed = false;
    state.dirty = false;
    state.readonly = true;
    state.binary = !!result.binary;
    state.fileMtimeMs = result.mtime || 0;
    state.fileSizeBytes = result.size || 0;
    clearSelection();
    setStatus(result.error || 'Cannot open file', result.binary ? 'info' : 'error', 3000);
    return false;
  }

  state.openPath = filePath;
  state.openName = baseName(filePath);
  state.originalContent = result.content;
  setLinesFromContent(result.content);
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.desiredCol = null;
  state.scrollY = 0;
  state.scrollX = 0;
  state.scrollFreed = false;
  state.dirty = false;
  state.readonly = false;
  state.binary = false;
  state.fileMtimeMs = result.mtime || 0;
  state.fileSizeBytes = result.size || result.content.length;
  state.undoStack = [];
  state.redoStack = [];
  clearSelection();
  if (!opts.keepFocus) state.focus = 'editor';
  setStatus('Opened ' + state.openName, 'info', 1800);
  return true;
}

async function saveFile() {
  if (!state.openPath || state.readonly) return false;
  const content = contentFromLines();
  const result = await writeTextFile(state.openPath, content);
  if (!result.ok) {
    setStatus(result.error || 'Save failed', 'error', 4000);
    return false;
  }
  state.originalContent = content;
  state.dirty = false;
  state.fileMtimeMs = result.mtime || Date.now();
  state.fileSizeBytes = result.size || content.length;
  state.lastSavedAt = Date.now();
  setStatus('Saved ' + state.openName, 'success', 2200);
  return true;
}

async function closeFile(force) {
  if (state.dirty && !force) {
    state.pendingDialog = { type: 'dirty-close' };
    await hecaton.dialog.show({
      type: 'message',
      title: 'Unsaved Changes',
      message: 'Save changes to "' + state.openName + '" before closing?',
      buttons: [
        { id: 'save', label: 'Save' },
        { id: 'discard', label: 'Discard' },
        { id: 'cancel', label: 'Cancel', default: true },
      ],
    }).catch(() => { state.pendingDialog = null; });
    return false;
  }
  state.openPath = '';
  state.openName = '';
  state.originalContent = '';
  state.editLines = [''];
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.scrollY = 0;
  state.scrollX = 0;
  state.scrollFreed = false;
  state.dirty = false;
  state.readonly = false;
  state.binary = false;
  state.undoStack = [];
  state.redoStack = [];
  clearSelection();
  setStatus('Closed file', 'info', 1500);
  return true;
}

module.exports = {
  setLinesFromContent,
  contentFromLines,
  clampCursor,
  hasSelection,
  clearSelection,
  startSelection,
  getSelectionRange,
  selectedText,
  deleteSelectionOnly,
  snapshot,
  markDirty,
  undo,
  redo,
  insertText,
  deleteBackward,
  deleteForward,
  moveCursor,
  moveVertical,
  moveHorizontal,
  moveWord,
  selectAll,
  openFile,
  saveFile,
  closeFile,
};
