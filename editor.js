const { state, setStatus } = require('./state');
const { baseName, readTextFile, writeTextFile } = require('./fs-ops');
const { wordLeft, wordRight } = require('./text');

const DEFAULT_TAB_SIZE = 2;
const COALESCE_MS = 850;

const PAIRS = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
};

function detectLineEnding(content) {
  const text = String(content || '');
  const crlf = (text.match(/\r\n/g) || []).length;
  const totalLf = (text.match(/\n/g) || []).length;
  const lf = Math.max(0, totalLf - crlf);
  return crlf > lf ? '\r\n' : '\n';
}

function normalizeContent(content) {
  return String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function setLinesFromContent(content) {
  state.lineEnding = detectLineEnding(content);
  const text = normalizeContent(content);
  state.editLines = text.length ? text.split('\n') : [''];
}

function contentFromLines(opts) {
  const eol = opts && opts.native ? (state.lineEnding || '\n') : '\n';
  return state.editLines.join(eol);
}

function normalizedContentFromLines() {
  return state.editLines.join('\n');
}

function clampCursor() {
  if (state.editLines.length === 0) state.editLines = [''];
  state.cursorRow = Math.max(0, Math.min(state.cursorRow, state.editLines.length - 1));
  state.cursorCol = Math.max(0, Math.min(state.cursorCol, state.editLines[state.cursorRow].length));
  if (state.selAnchorRow >= state.editLines.length) {
    state.selAnchorRow = state.editLines.length - 1;
    state.selAnchorCol = state.editLines[state.selAnchorRow].length;
  }
  if (state.selAnchorRow >= 0) {
    state.selAnchorRow = Math.max(0, state.selAnchorRow);
    state.selAnchorCol = Math.max(0, Math.min(state.selAnchorCol, state.editLines[state.selAnchorRow].length));
  }
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

function comparePositions(aRow, aCol, bRow, bCol) {
  if (aRow !== bRow) return aRow < bRow ? -1 : 1;
  if (aCol !== bCol) return aCol < bCol ? -1 : 1;
  return 0;
}

function positionsEqual(aRow, aCol, bRow, bCol) {
  return aRow === bRow && aCol === bCol;
}

function getSelectionRange() {
  if (!hasSelection()) return null;
  return normalizeRange(state.selAnchorRow, state.selAnchorCol, state.cursorRow, state.cursorCol);
}

function normalizeRange(startRow, startCol, endRow, endCol) {
  if (comparePositions(startRow, startCol, endRow, endCol) > 0) {
    return { startRow: endRow, startCol: endCol, endRow: startRow, endCol: startCol };
  }
  return { startRow, startCol, endRow, endCol };
}

function cloneRange(r) {
  return {
    startRow: r.startRow,
    startCol: r.startCol,
    endRow: r.endRow,
    endCol: r.endCol,
  };
}

function emptyRangeAt(row, col) {
  return { startRow: row, startCol: col, endRow: row, endCol: col };
}

function rangeIsEmpty(r) {
  return r.startRow === r.endRow && r.startCol === r.endCol;
}

function textFromRange(r) {
  if (r.startRow === r.endRow) {
    return state.editLines[r.startRow].substring(r.startCol, r.endCol);
  }
  const out = [state.editLines[r.startRow].substring(r.startCol)];
  for (let row = r.startRow + 1; row < r.endRow; row++) out.push(state.editLines[row]);
  out.push(state.editLines[r.endRow].substring(0, r.endCol));
  return out.join('\n');
}

function selectedText() {
  const r = getSelectionRange();
  return r ? textFromRange(r) : '';
}

function rangeEndForText(startRow, startCol, text) {
  const parts = normalizeContent(text).split('\n');
  if (parts.length === 1) return { row: startRow, col: startCol + parts[0].length };
  return { row: startRow + parts.length - 1, col: parts[parts.length - 1].length };
}

function replaceRangeRaw(r, text) {
  r = cloneRange(r);
  text = normalizeContent(text);
  const parts = text.split('\n');
  const before = state.editLines[r.startRow].substring(0, r.startCol);
  const after = state.editLines[r.endRow].substring(r.endCol);
  let replacement;

  if (parts.length === 1) {
    replacement = [before + parts[0] + after];
  } else {
    replacement = [before + parts[0]];
    for (let i = 1; i < parts.length - 1; i++) replacement.push(parts[i]);
    replacement.push(parts[parts.length - 1] + after);
  }

  state.editLines.splice(r.startRow, r.endRow - r.startRow + 1, ...replacement);
  if (state.editLines.length === 0) state.editLines = [''];
  return rangeEndForText(r.startRow, r.startCol, text);
}

function captureCursorState() {
  return {
    cursorRow: state.cursorRow,
    cursorCol: state.cursorCol,
    selAnchorRow: state.selAnchorRow,
    selAnchorCol: state.selAnchorCol,
    desiredCol: state.desiredCol,
  };
}

function captureSnapshotState() {
  return {
    lines: state.editLines.slice(),
    ...captureCursorState(),
  };
}

function restoreCursorState(s) {
  state.cursorRow = s.cursorRow;
  state.cursorCol = s.cursorCol;
  state.selAnchorRow = s.selAnchorRow;
  state.selAnchorCol = s.selAnchorCol;
  state.desiredCol = s.desiredCol == null ? null : s.desiredCol;
  clampCursor();
}

function restoreSnapshotState(s) {
  state.editLines = s.lines.slice();
  restoreCursorState(s);
}

function resetEditCoalescing() {
  state.lastUndoType = '';
  state.lastUndoTime = 0;
  const last = state.undoStack[state.undoStack.length - 1];
  if (last) last.timestamp = 0;
}

function canMergeHistory(last, entry) {
  if (!last || last.kind !== 'edit' || entry.kind !== 'edit') return false;
  if (last.type !== entry.type) return false;
  if (Date.now() - (last.timestamp || 0) > COALESCE_MS) return false;
  if (last.edit.oldText.includes('\n') || entry.edit.oldText.includes('\n')) return false;
  if (last.edit.newText.includes('\n') || entry.edit.newText.includes('\n')) return false;

  const a = last.edit;
  const b = entry.edit;
  if (entry.type === 'insert') {
    return rangeIsEmpty(a.range) &&
      rangeIsEmpty(b.range) &&
      positionsEqual(a.afterRange.endRow, a.afterRange.endCol, b.range.startRow, b.range.startCol);
  }
  if (entry.type === 'delete-backward') {
    return positionsEqual(b.range.endRow, b.range.endCol, a.range.startRow, a.range.startCol);
  }
  if (entry.type === 'delete-forward') {
    return positionsEqual(b.range.startRow, b.range.startCol, a.range.startRow, a.range.startCol);
  }
  return false;
}

function mergeHistory(last, entry) {
  const a = last.edit;
  const b = entry.edit;

  if (entry.type === 'insert') {
    a.newText += b.newText;
    a.afterRange.endRow = b.afterRange.endRow;
    a.afterRange.endCol = b.afterRange.endCol;
  } else if (entry.type === 'delete-backward') {
    a.range.startRow = b.range.startRow;
    a.range.startCol = b.range.startCol;
    a.oldText = b.oldText + a.oldText;
    a.afterRange = emptyRangeAt(b.range.startRow, b.range.startCol);
  } else if (entry.type === 'delete-forward') {
    a.oldText += b.oldText;
    const end = rangeEndForText(a.range.startRow, a.range.startCol, a.oldText);
    a.range.endRow = end.row;
    a.range.endCol = end.col;
    a.afterRange = emptyRangeAt(a.range.startRow, a.range.startCol);
  }

  last.after = entry.after;
  last.timestamp = entry.timestamp;
  state.lastUndoTime = entry.timestamp;
}

function pushHistory(entry) {
  const last = state.undoStack[state.undoStack.length - 1];
  state.redoStack = [];
  if (canMergeHistory(last, entry)) {
    mergeHistory(last, entry);
    return;
  }

  state.undoStack.push(entry);
  while (state.undoStack.length > state.maxUndo) state.undoStack.shift();
  state.lastUndoType = entry.type || '';
  state.lastUndoTime = entry.timestamp || Date.now();
}

function resetHistory() {
  state.undoStack = [];
  state.redoStack = [];
  resetEditCoalescing();
}

function markDirty() {
  state.dirty = normalizedContentFromLines() !== state.originalContent;
}

function replaceRange(r, text, type, afterCursor) {
  if (state.readonly || !state.openPath) return false;
  state.scrollFreed = false;
  r = cloneRange(r);
  text = normalizeContent(text);
  const oldText = textFromRange(r);
  if (oldText === text) return false;

  const before = captureCursorState();
  const end = replaceRangeRaw(r, text);
  if (afterCursor) {
    state.cursorRow = afterCursor.row;
    state.cursorCol = afterCursor.col;
  } else {
    state.cursorRow = end.row;
    state.cursorCol = end.col;
  }
  clearSelection();
  clampCursor();

  const entry = {
    kind: 'edit',
    type: type || 'edit',
    label: type || 'edit',
    before,
    after: captureCursorState(),
    timestamp: Date.now(),
    edit: {
      range: cloneRange(r),
      oldText,
      newText: text,
      afterRange: {
        startRow: r.startRow,
        startCol: r.startCol,
        endRow: end.row,
        endCol: end.col,
      },
    },
  };
  pushHistory(entry);
  markDirty();
  return true;
}

function commitSnapshotEdit(type, label, mutator) {
  if (state.readonly || !state.openPath) return false;
  state.scrollFreed = false;
  const before = captureSnapshotState();
  const beforeContent = normalizedContentFromLines();
  const changed = mutator();
  if (changed === false) {
    restoreSnapshotState(before);
    return false;
  }
  clampCursor();
  const afterContent = normalizedContentFromLines();
  if (beforeContent === afterContent) {
    restoreSnapshotState(before);
    return false;
  }

  pushHistory({
    kind: 'snapshot',
    type,
    label: label || type,
    before,
    after: captureSnapshotState(),
    timestamp: Date.now(),
  });
  markDirty();
  return true;
}

function snapshot(type) {
  void type;
  resetEditCoalescing();
}

function canUndo() {
  return state.undoStack.length > 0 && !state.readonly;
}

function canRedo() {
  return state.redoStack.length > 0 && !state.readonly;
}

function applyHistoryEntry(entry, direction) {
  if (entry.kind === 'snapshot') {
    restoreSnapshotState(direction === 'undo' ? entry.before : entry.after);
    return;
  }

  const edit = entry.edit;
  if (direction === 'undo') {
    replaceRangeRaw(edit.afterRange, edit.oldText);
    restoreCursorState(entry.before);
  } else {
    replaceRangeRaw(edit.range, edit.newText);
    restoreCursorState(entry.after);
  }
}

function undo() {
  if (!state.undoStack.length || state.readonly) return;
  state.scrollFreed = false;
  const entry = state.undoStack.pop();
  applyHistoryEntry(entry, 'undo');
  state.redoStack.push(entry);
  markDirty();
  resetEditCoalescing();
}

function redo() {
  if (!state.redoStack.length || state.readonly) return;
  state.scrollFreed = false;
  const entry = state.redoStack.pop();
  applyHistoryEntry(entry, 'redo');
  state.undoStack.push(entry);
  markDirty();
  resetEditCoalescing();
}

function insertText(text, type) {
  if (state.readonly || !state.openPath) return false;
  text = normalizeContent(text);
  if (!text) return false;
  const r = getSelectionRange() || emptyRangeAt(state.cursorRow, state.cursorCol);
  return replaceRange(r, text, type || 'insert');
}

function previousCharIndex(line, col) {
  let i = Math.max(0, Math.min(col, line.length));
  if (i <= 0) return 0;
  i--;
  const code = line.charCodeAt(i);
  if (code >= 0xDC00 && code <= 0xDFFF && i > 0) {
    const prev = line.charCodeAt(i - 1);
    if (prev >= 0xD800 && prev <= 0xDBFF) i--;
  }
  return i;
}

function nextCharIndex(line, col) {
  let i = Math.max(0, Math.min(col, line.length));
  if (i >= line.length) return line.length;
  const code = line.charCodeAt(i);
  i++;
  if (code >= 0xD800 && code <= 0xDBFF && i < line.length) {
    const next = line.charCodeAt(i);
    if (next >= 0xDC00 && next <= 0xDFFF) i++;
  }
  return i;
}

function deleteSelectionOnly() {
  const r = getSelectionRange();
  if (!r) return false;
  replaceRangeRaw(r, '');
  state.cursorRow = r.startRow;
  state.cursorCol = r.startCol;
  clearSelection();
  clampCursor();
  return true;
}

function deleteSelection(type) {
  const r = getSelectionRange();
  if (!r) return false;
  return replaceRange(r, '', type || 'delete');
}

function deleteBackward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete')) return true;

  if (state.cursorCol > 0) {
    const line = state.editLines[state.cursorRow];
    const prev = previousCharIndex(line, state.cursorCol);
    return replaceRange(
      normalizeRange(state.cursorRow, prev, state.cursorRow, state.cursorCol),
      '',
      'delete-backward'
    );
  }
  if (state.cursorRow > 0) {
    const prevLen = state.editLines[state.cursorRow - 1].length;
    return replaceRange(
      normalizeRange(state.cursorRow - 1, prevLen, state.cursorRow, 0),
      '',
      'delete-newline',
      { row: state.cursorRow - 1, col: prevLen }
    );
  }
  return false;
}

function deleteForward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete')) return true;

  const line = state.editLines[state.cursorRow];
  if (state.cursorCol < line.length) {
    const next = nextCharIndex(line, state.cursorCol);
    return replaceRange(
      normalizeRange(state.cursorRow, state.cursorCol, state.cursorRow, next),
      '',
      'delete-forward'
    );
  }
  if (state.cursorRow < state.editLines.length - 1) {
    return replaceRange(
      normalizeRange(state.cursorRow, state.cursorCol, state.cursorRow + 1, 0),
      '',
      'delete-newline'
    );
  }
  return false;
}

function deleteWordBackward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-word')) return true;
  if (state.cursorCol > 0) {
    const line = state.editLines[state.cursorRow] || '';
    const col = wordLeft(line, state.cursorCol);
    return replaceRange(normalizeRange(state.cursorRow, col, state.cursorRow, state.cursorCol), '', 'delete-word');
  }
  if (state.cursorRow > 0) {
    const prevLen = state.editLines[state.cursorRow - 1].length;
    return replaceRange(normalizeRange(state.cursorRow - 1, prevLen, state.cursorRow, 0), '', 'delete-word');
  }
  return false;
}

function deleteWordForward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-word')) return true;
  const line = state.editLines[state.cursorRow] || '';
  if (state.cursorCol < line.length) {
    const col = wordRight(line, state.cursorCol);
    return replaceRange(normalizeRange(state.cursorRow, state.cursorCol, state.cursorRow, col), '', 'delete-word');
  }
  if (state.cursorRow < state.editLines.length - 1) {
    return replaceRange(normalizeRange(state.cursorRow, state.cursorCol, state.cursorRow + 1, 0), '', 'delete-word');
  }
  return false;
}

function deleteToLineStart() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-line-start')) return true;
  if (state.cursorCol > 0) {
    return replaceRange(normalizeRange(state.cursorRow, 0, state.cursorRow, state.cursorCol), '', 'delete-line-start');
  }
  if (state.cursorRow > 0) {
    const prevLen = state.editLines[state.cursorRow - 1].length;
    return replaceRange(normalizeRange(state.cursorRow - 1, prevLen, state.cursorRow, 0), '', 'delete-line-start');
  }
  return false;
}

function deleteToLineEnd() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-line-end')) return true;
  const line = state.editLines[state.cursorRow] || '';
  if (state.cursorCol < line.length) {
    return replaceRange(normalizeRange(state.cursorRow, state.cursorCol, state.cursorRow, line.length), '', 'delete-line-end');
  }
  if (state.cursorRow < state.editLines.length - 1) {
    return replaceRange(normalizeRange(state.cursorRow, line.length, state.cursorRow + 1, 0), '', 'delete-line-end');
  }
  return false;
}

function getSelectedLineBounds() {
  const r = getSelectionRange();
  if (!r) return { start: state.cursorRow, end: state.cursorRow };
  let end = r.endRow;
  if (r.endCol === 0 && end > r.startRow) end--;
  return { start: r.startRow, end };
}

function deleteLine() {
  return commitSnapshotEdit('delete-line', 'delete line', () => {
    const bounds = getSelectedLineBounds();
    const count = bounds.end - bounds.start + 1;
    if (state.editLines.length === 1) {
      state.editLines[0] = '';
      state.cursorRow = 0;
      state.cursorCol = 0;
    } else {
      state.editLines.splice(bounds.start, count);
      if (state.editLines.length === 0) state.editLines = [''];
      state.cursorRow = Math.min(bounds.start, state.editLines.length - 1);
      state.cursorCol = Math.min(state.cursorCol, state.editLines[state.cursorRow].length);
    }
    clearSelection();
    return true;
  });
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
  if (state.desiredCol == null) state.desiredCol = state.cursorCol;
  const row = Math.max(0, Math.min(state.cursorRow + delta, state.editLines.length - 1));
  const col = Math.min(state.desiredCol, state.editLines[row].length);
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
    if (state.cursorCol > 0) moveCursor(state.cursorRow, previousCharIndex(state.editLines[state.cursorRow], state.cursorCol), selecting);
    else if (state.cursorRow > 0) moveCursor(state.cursorRow - 1, state.editLines[state.cursorRow - 1].length, selecting);
  } else {
    const line = state.editLines[state.cursorRow] || '';
    if (state.cursorCol < line.length) moveCursor(state.cursorRow, nextCharIndex(line, state.cursorCol), selecting);
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

function moveHome(selecting) {
  state.desiredCol = null;
  const line = state.editLines[state.cursorRow] || '';
  const first = line.search(/\S/);
  const indent = first < 0 ? 0 : first;
  moveCursor(state.cursorRow, state.cursorCol === indent ? 0 : indent, selecting);
}

function moveDocumentStart(selecting) {
  state.desiredCol = null;
  moveCursor(0, 0, selecting);
}

function moveDocumentEnd(selecting) {
  state.desiredCol = null;
  const row = state.editLines.length - 1;
  moveCursor(row, state.editLines[row].length, selecting);
}

function selectAll() {
  state.scrollFreed = false;
  state.selAnchorRow = 0;
  state.selAnchorCol = 0;
  state.cursorRow = state.editLines.length - 1;
  state.cursorCol = state.editLines[state.cursorRow].length;
}

function indentUnit() {
  return ' '.repeat(Math.max(1, state.tabSize || DEFAULT_TAB_SIZE));
}

function adjustPositionColumn(pos, row, delta) {
  if (pos.row !== row) return;
  pos.col = Math.max(0, pos.col + delta);
}

function indentLines() {
  return commitSnapshotEdit('indent', 'indent lines', () => {
    const unit = indentUnit();
    const bounds = getSelectedLineBounds();
    const cursor = { row: state.cursorRow, col: state.cursorCol };
    const anchor = { row: state.selAnchorRow, col: state.selAnchorCol };
    for (let row = bounds.start; row <= bounds.end; row++) {
      state.editLines[row] = unit + state.editLines[row];
      adjustPositionColumn(cursor, row, unit.length);
      adjustPositionColumn(anchor, row, unit.length);
    }
    state.cursorCol = cursor.col;
    if (anchor.row >= 0) state.selAnchorCol = anchor.col;
    return true;
  });
}

function outdentAmount(line) {
  if (line.startsWith('\t')) return 1;
  const max = Math.max(1, state.tabSize || DEFAULT_TAB_SIZE);
  let count = 0;
  while (count < max && line[count] === ' ') count++;
  return count;
}

function outdentLines() {
  return commitSnapshotEdit('outdent', 'outdent lines', () => {
    const bounds = getSelectedLineBounds();
    const cursor = { row: state.cursorRow, col: state.cursorCol };
    const anchor = { row: state.selAnchorRow, col: state.selAnchorCol };
    let changed = false;
    for (let row = bounds.start; row <= bounds.end; row++) {
      const amount = outdentAmount(state.editLines[row] || '');
      if (!amount) continue;
      state.editLines[row] = state.editLines[row].substring(amount);
      adjustPositionColumn(cursor, row, -Math.min(amount, cursor.col));
      adjustPositionColumn(anchor, row, -Math.min(amount, anchor.col));
      changed = true;
    }
    state.cursorCol = cursor.col;
    if (anchor.row >= 0) state.selAnchorCol = anchor.col;
    return changed;
  });
}

function duplicateLines() {
  return commitSnapshotEdit('duplicate-line', 'duplicate lines', () => {
    const bounds = getSelectedLineBounds();
    const block = state.editLines.slice(bounds.start, bounds.end + 1);
    state.editLines.splice(bounds.end + 1, 0, ...block);
    const offset = block.length;
    state.cursorRow += offset;
    if (state.selAnchorRow >= 0) state.selAnchorRow += offset;
    return true;
  });
}

function moveLines(delta) {
  return commitSnapshotEdit(delta < 0 ? 'move-line-up' : 'move-line-down', 'move lines', () => {
    const bounds = getSelectedLineBounds();
    if (delta < 0 && bounds.start === 0) return false;
    if (delta > 0 && bounds.end >= state.editLines.length - 1) return false;
    const count = bounds.end - bounds.start + 1;
    const block = state.editLines.splice(bounds.start, count);
    const insertAt = delta < 0 ? bounds.start - 1 : bounds.start + 1;
    state.editLines.splice(insertAt, 0, ...block);
    state.cursorRow += delta;
    if (state.selAnchorRow >= 0) state.selAnchorRow += delta;
    return true;
  });
}

function commentPrefixForPath(filePath) {
  const name = String(filePath || '').toLowerCase();
  const ext = name.substring(name.lastIndexOf('.') + 1);
  if (['py', 'rb', 'sh', 'bash', 'zsh', 'ps1', 'r', 'yaml', 'yml', 'toml', 'dockerfile'].includes(ext) ||
      name.endsWith('/dockerfile') || name.endsWith('\\dockerfile')) return '#';
  if (['sql', 'lua'].includes(ext)) return '--';
  if (['ini', 'cfg', 'conf'].includes(ext)) return ';';
  if (['tex', 'sty'].includes(ext)) return '%';
  return '//';
}

function toggleLineComment() {
  return commitSnapshotEdit('toggle-comment', 'toggle comment', () => {
    const bounds = getSelectedLineBounds();
    const prefix = commentPrefixForPath(state.openPath);
    const rows = [];
    for (let row = bounds.start; row <= bounds.end; row++) {
      if ((state.editLines[row] || '').trim()) rows.push(row);
    }
    if (!rows.length) return false;

    const allCommented = rows.every(row => {
      const line = state.editLines[row] || '';
      const indent = line.match(/^\s*/)[0].length;
      return line.substring(indent).startsWith(prefix);
    });

    for (const row of rows) {
      const line = state.editLines[row] || '';
      const indentText = line.match(/^\s*/)[0];
      if (allCommented) {
        let rest = line.substring(indentText.length);
        rest = rest.substring(prefix.length);
        if (rest.startsWith(' ')) rest = rest.substring(1);
        state.editLines[row] = indentText + rest;
      } else {
        state.editLines[row] = indentText + prefix + ' ' + line.substring(indentText.length);
      }
    }
    return true;
  });
}

function tryInsertPair(ch) {
  if (!Object.prototype.hasOwnProperty.call(PAIRS, ch) || state.readonly || !state.openPath) return false;
  const close = PAIRS[ch];
  const line = state.editLines[state.cursorRow] || '';

  if (ch === close && line[state.cursorCol] === close && !hasSelection()) {
    moveHorizontal(1, false);
    return true;
  }

  const r = getSelectionRange() || emptyRangeAt(state.cursorRow, state.cursorCol);
  const selected = getSelectionRange() ? selectedText() : '';
  const text = ch + selected + close;
  const selectedEnd = rangeEndForText(r.startRow, r.startCol, text);
  const afterCursor = selected
    ? selectedEnd
    : { row: r.startRow, col: r.startCol + ch.length };
  return replaceRange(r, text, selected ? 'wrap-pair' : 'insert-pair', afterCursor);
}

function trySkipClosingPair(ch) {
  const line = state.editLines[state.cursorRow] || '';
  if (Object.values(PAIRS).includes(ch) && line[state.cursorCol] === ch && !hasSelection()) {
    moveHorizontal(1, false);
    return true;
  }
  return false;
}

function tryDeletePairBackward() {
  if (state.cursorCol <= 0 || hasSelection() || state.readonly || !state.openPath) return false;
  const line = state.editLines[state.cursorRow] || '';
  const prev = line[state.cursorCol - 1];
  const next = line[state.cursorCol];
  if (!prev || PAIRS[prev] !== next) return false;
  return replaceRange(
    normalizeRange(state.cursorRow, state.cursorCol - 1, state.cursorRow, state.cursorCol + 1),
    '',
    'delete-pair'
  );
}

function findInLine(line, query, start, reverse, caseSensitive) {
  if (!caseSensitive) {
    line = line.toLowerCase();
    query = query.toLowerCase();
  }
  if (reverse) {
    if (start < 0) return -1;
    return line.lastIndexOf(query, Math.min(start, line.length - 1));
  }
  return line.indexOf(query, Math.max(0, start));
}

function countFindMatches(query) {
  query = String(query || '');
  if (!query) return 0;
  const q = state.findCaseSensitive ? query : query.toLowerCase();
  let count = 0;
  for (const raw of state.editLines) {
    const line = state.findCaseSensitive ? raw : raw.toLowerCase();
    let idx = 0;
    while ((idx = line.indexOf(q, idx)) >= 0) {
      count++;
      idx += Math.max(1, q.length);
    }
  }
  return count;
}

function countMatchesBefore(query, row, col) {
  query = String(query || '');
  if (!query) return 0;
  const q = state.findCaseSensitive ? query : query.toLowerCase();
  let count = 0;
  for (let r = 0; r <= row; r++) {
    const raw = state.editLines[r] || '';
    const line = state.findCaseSensitive ? raw : raw.toLowerCase();
    let idx = 0;
    while ((idx = line.indexOf(q, idx)) >= 0) {
      if (r === row && idx >= col) break;
      count++;
      idx += Math.max(1, q.length);
    }
  }
  return count;
}

function findNext(query, reverse) {
  if (!state.openPath) return false;
  if (query != null) state.findQuery = String(query);
  const q = state.findQuery;
  if (!q) return false;

  const sel = getSelectionRange();
  let startRow = state.cursorRow;
  let startCol = state.cursorCol;
  if (sel) {
    startRow = reverse ? sel.startRow : sel.endRow;
    startCol = reverse ? sel.startCol - 1 : sel.endCol;
  } else if (reverse) {
    startCol--;
  }

  for (let pass = 0; pass < 2; pass++) {
    if (reverse) {
      for (let row = startRow; row >= 0; row--) {
        const line = state.editLines[row] || '';
        const from = row === startRow ? Math.min(startCol, line.length - 1) : line.length - 1;
        const idx = findInLine(line, q, from, true, state.findCaseSensitive);
        if (idx >= 0) return selectFoundMatch(q, row, idx);
      }
      startRow = state.editLines.length - 1;
      startCol = (state.editLines[startRow] || '').length - 1;
    } else {
      for (let row = startRow; row < state.editLines.length; row++) {
        const line = state.editLines[row] || '';
        const from = row === startRow ? startCol : 0;
        const idx = findInLine(line, q, from, false, state.findCaseSensitive);
        if (idx >= 0) return selectFoundMatch(q, row, idx);
      }
      startRow = 0;
      startCol = 0;
    }
  }

  clearSelection();
  setStatus('No matches: ' + q, 'error', 2600);
  return false;
}

function selectFoundMatch(query, row, col) {
  state.scrollFreed = false;
  state.selAnchorRow = row;
  state.selAnchorCol = col;
  state.cursorRow = row;
  state.cursorCol = col + query.length;
  clampCursor();
  const total = countFindMatches(query);
  const index = countMatchesBefore(query, row, col) + 1;
  setStatus('Match ' + index + '/' + total + ': ' + query, 'info', 2200);
  return true;
}

function gotoLine(lineNumber) {
  if (!state.openPath) return false;
  const row = Math.max(0, Math.min(Number(lineNumber || 1) - 1, state.editLines.length - 1));
  moveCursor(row, Math.min(state.cursorCol, state.editLines[row].length), false);
  setStatus('Line ' + (row + 1), 'info', 1600);
  return true;
}

function currentLineText() {
  if (!state.openPath) return '';
  return (state.editLines[state.cursorRow] || '') + '\n';
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
    state.lineEnding = '\n';
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
    resetHistory();
    clearSelection();
    setStatus(result.error || 'Cannot open file', result.binary ? 'info' : 'error', 3000);
    return false;
  }

  state.openPath = filePath;
  state.openName = baseName(filePath);
  state.originalContent = normalizeContent(result.content);
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
  state.findQuery = '';
  resetHistory();
  clearSelection();
  if (!opts.keepFocus) state.focus = 'editor';
  setStatus('Opened ' + state.openName, 'info', 1800);
  return true;
}

async function saveFile() {
  if (!state.openPath || state.readonly) return false;
  const content = contentFromLines({ native: true });
  const result = await writeTextFile(state.openPath, content);
  if (!result.ok) {
    setStatus(result.error || 'Save failed', 'error', 4000);
    return false;
  }
  state.originalContent = normalizedContentFromLines();
  state.dirty = false;
  state.fileMtimeMs = result.mtime || Date.now();
  state.fileSizeBytes = result.size || content.length;
  state.lastSavedAt = Date.now();
  resetEditCoalescing();
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
  state.lineEnding = '\n';
  state.editLines = [''];
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.scrollY = 0;
  state.scrollX = 0;
  state.scrollFreed = false;
  state.dirty = false;
  state.readonly = false;
  state.binary = false;
  state.findQuery = '';
  resetHistory();
  clearSelection();
  setStatus('Closed file', 'info', 1500);
  return true;
}

module.exports = {
  setLinesFromContent,
  contentFromLines,
  normalizedContentFromLines,
  clampCursor,
  hasSelection,
  clearSelection,
  startSelection,
  getSelectionRange,
  selectedText,
  currentLineText,
  deleteSelectionOnly,
  deleteSelection,
  snapshot,
  markDirty,
  canUndo,
  canRedo,
  undo,
  redo,
  insertText,
  tryInsertPair,
  trySkipClosingPair,
  tryDeletePairBackward,
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
  moveDocumentStart,
  moveDocumentEnd,
  selectAll,
  findNext,
  gotoLine,
  countFindMatches,
  openFile,
  saveFile,
  closeFile,
};
