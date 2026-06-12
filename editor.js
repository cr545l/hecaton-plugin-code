const { state, setStatus } = require('./state');
const { baseName, readTextFile, writeTextFile } = require('./fs-ops');
const { wordLeft, wordRight, wordBoundsAt } = require('./text');
const {
  emptySelection,
  cloneSelection,
  selectionIsEmpty,
  selectionRange,
  ensureSelections,
  setSelections,
  syncSelectionsFromLegacy,
} = require('./cursor-state');

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
  state.docVersion++;
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
  ensureSelections(state);
}

function hasSelection() {
  return ensureSelections(state).some(sel => !selectionIsEmpty(sel));
}

function clearSelection() {
  const selections = ensureSelections(state).map(sel => emptySelection(sel.row, sel.col));
  setSelections(state, selections);
}

function startSelection() {
  const selections = ensureSelections(state).map(sel =>
    selectionIsEmpty(sel) ? emptySelection(sel.row, sel.col) : cloneSelection(sel)
  );
  setSelections(state, selections);
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
  const primary = ensureSelections(state)[0];
  if (!primary || selectionIsEmpty(primary)) return null;
  return selectionRange(primary);
}

function getSelectionRanges() {
  return ensureSelections(state)
    .filter(sel => !selectionIsEmpty(sel))
    .map(selectionRange);
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
  const ranges = getSelectionRanges();
  if (!ranges.length) return '';
  return ranges.map(textFromRange).join('\n');
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

function lineStartOffsets(lines) {
  const offsets = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offset);
    offset += (lines[i] || '').length + 1;
  }
  return offsets;
}

function positionToOffset(row, col, offsets) {
  return offsets[row] + col;
}

function offsetToPosition(offset, text) {
  offset = Math.max(0, Math.min(offset, text.length));
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, col: offset - lineStart };
}

function replaceRangesRaw(edits) {
  if (!edits.length) return [];
  const beforeLines = state.editLines.slice();
  const beforeText = beforeLines.join('\n');
  const offsets = lineStartOffsets(beforeLines);
  const normalized = edits.map((edit, index) => {
    const range = cloneRange(edit.range);
    const text = normalizeContent(edit.text);
    const startOffset = positionToOffset(range.startRow, range.startCol, offsets);
    const endOffset = positionToOffset(range.endRow, range.endCol, offsets);
    return { ...edit, index, range, text, startOffset, endOffset };
  }).sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

  const filtered = [];
  for (const edit of normalized) {
    const last = filtered[filtered.length - 1];
    if (last && edit.startOffset < last.endOffset) continue;
    if (last && edit.startOffset === last.startOffset && edit.endOffset === last.endOffset) continue;
    filtered.push(edit);
  }

  let out = '';
  let cursor = 0;
  let delta = 0;
  const afterOffsets = new Array(filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    const edit = filtered[i];
    out += beforeText.substring(cursor, edit.startOffset);
    const newStartOffset = edit.startOffset + delta;
    out += edit.text;
    cursor = edit.endOffset;
    const replacementDelta = edit.text.length - (edit.endOffset - edit.startOffset);
    delta += replacementDelta;
    afterOffsets[i] = edit.afterOffset != null
      ? newStartOffset + edit.afterOffset
      : newStartOffset + edit.text.length;
  }
  out += beforeText.substring(cursor);

  state.editLines = out.length ? out.split('\n') : [''];
  return afterOffsets.map(offset => offsetToPosition(offset, out));
}

function captureCursorState() {
  ensureSelections(state);
  return {
    cursorRow: state.cursorRow,
    cursorCol: state.cursorCol,
    selAnchorRow: state.selAnchorRow,
    selAnchorCol: state.selAnchorCol,
    selections: state.selections.map(cloneSelection),
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
  if (Array.isArray(s.selections) && s.selections.length) {
    state.selections = s.selections.map(cloneSelection);
  } else {
    state.cursorRow = s.cursorRow;
    state.cursorCol = s.cursorCol;
    state.selAnchorRow = s.selAnchorRow;
    state.selAnchorCol = s.selAnchorCol;
    syncSelectionsFromLegacy(state);
  }
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
  state.docVersion++;
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
  syncSelectionsFromLegacy(state);
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

function replaceSelections(text, type, afterOffset) {
  if (state.readonly || !state.openPath) return false;
  const selections = ensureSelections(state);
  if (selections.length <= 1) {
    const r = getSelectionRange() || emptyRangeAt(state.cursorRow, state.cursorCol);
    let afterCursor = null;
    if (afterOffset != null) {
      const end = rangeEndForText(r.startRow, r.startCol, normalizeContent(text).substring(0, afterOffset));
      afterCursor = end;
    }
    return replaceRange(r, text, type, afterCursor);
  }

  text = normalizeContent(text);
  const ranges = selections.map(sel => selectionRange(sel));
  const oldTexts = ranges.map(textFromRange);
  if (oldTexts.every(oldText => oldText === text)) return false;

  return commitSnapshotEdit(type || 'multi-edit', type || 'multi edit', () => {
    const edits = ranges.map(range => ({
      range,
      text,
      afterOffset,
    }));
    const positions = replaceRangesRaw(edits);
    setSelections(state, positions.map(pos => emptySelection(pos.row, pos.col)));
    return true;
  });
}

function deleteSelectionRanges(type) {
  const ranges = getSelectionRanges();
  if (!ranges.length) return false;
  if (ranges.length === 1 && ensureSelections(state).length === 1) {
    return replaceRange(ranges[0], '', type || 'delete');
  }
  return commitSnapshotEdit(type || 'delete', type || 'delete', () => {
    const positions = replaceRangesRaw(ranges.map(range => ({ range, text: '' })));
    setSelections(state, positions.map(pos => emptySelection(pos.row, pos.col)));
    return true;
  });
}

function replaceCursorRanges(ranges, text, type) {
  ranges = ranges.filter(r => !rangeIsEmpty(r));
  if (!ranges.length) return false;
  if (ranges.length === 1 && ensureSelections(state).length === 1) {
    return replaceRange(ranges[0], text, type || 'edit');
  }
  return commitSnapshotEdit(type || 'multi-edit', type || 'multi edit', () => {
    const positions = replaceRangesRaw(ranges.map(range => ({ range, text })));
    setSelections(state, positions.map(pos => emptySelection(pos.row, pos.col)));
    return true;
  });
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
  return replaceSelections(text, type || 'insert');
}

const BLOCK_PAIRS = { '(': ')', '[': ']', '{': '}' };

function insertNewline() {
  if (state.readonly || !state.openPath) return false;
  const selections = ensureSelections(state);
  const unit = indentUnit();
  const edits = selections.map(sel => {
    const range = selectionRange(sel);
    const before = (state.editLines[range.startRow] || '').substring(0, range.startCol);
    const after = (state.editLines[range.endRow] || '').substring(range.endCol);
    const baseIndent = (before.match(/^[ \t]*/) || [''])[0];
    const trimmed = before.replace(/[ \t]+$/, '');
    const lastCh = trimmed.charAt(trimmed.length - 1);
    const opensBlock = Object.prototype.hasOwnProperty.call(BLOCK_PAIRS, lastCh);
    let text = '\n' + baseIndent;
    if (opensBlock) {
      text = '\n' + baseIndent + unit;
      if (after.charAt(0) === BLOCK_PAIRS[lastCh]) {
        return { range, text: text + '\n' + baseIndent, afterOffset: text.length };
      }
    }
    return { range, text, afterOffset: text.length };
  });

  if (selections.length === 1) {
    const e = edits[0];
    const afterCursor = rangeEndForText(e.range.startRow, e.range.startCol, e.text.substring(0, e.afterOffset));
    return replaceRange(e.range, e.text, 'newline', afterCursor);
  }
  return commitSnapshotEdit('newline', 'newline', () => {
    const positions = replaceRangesRaw(edits);
    setSelections(state, positions.map(pos => emptySelection(pos.row, pos.col)));
    return true;
  });
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
  return deleteSelectionRanges('delete');
}

function deleteSelection(type) {
  return deleteSelectionRanges(type || 'delete');
}

function deleteBackward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete')) return true;

  const ranges = ensureSelections(state).map(sel => {
    if (sel.col > 0) {
      const line = state.editLines[sel.row];
      const prev = previousCharIndex(line, sel.col);
      return normalizeRange(sel.row, prev, sel.row, sel.col);
    }
    if (sel.row > 0) {
      const prevLen = state.editLines[sel.row - 1].length;
      return normalizeRange(sel.row - 1, prevLen, sel.row, 0);
    }
    return null;
  }).filter(Boolean);
  return replaceCursorRanges(ranges, '', 'delete-backward');
}

function deleteForward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete')) return true;

  const ranges = ensureSelections(state).map(sel => {
    const line = state.editLines[sel.row];
    if (sel.col < line.length) {
      const next = nextCharIndex(line, sel.col);
      return normalizeRange(sel.row, sel.col, sel.row, next);
    }
    if (sel.row < state.editLines.length - 1) {
      return normalizeRange(sel.row, sel.col, sel.row + 1, 0);
    }
    return null;
  }).filter(Boolean);
  return replaceCursorRanges(ranges, '', 'delete-forward');
}

function deleteWordBackward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-word')) return true;
  const ranges = ensureSelections(state).map(sel => {
    if (sel.col > 0) {
      const line = state.editLines[sel.row] || '';
      const col = wordLeft(line, sel.col);
      return normalizeRange(sel.row, col, sel.row, sel.col);
    }
    if (sel.row > 0) {
      const prevLen = state.editLines[sel.row - 1].length;
      return normalizeRange(sel.row - 1, prevLen, sel.row, 0);
    }
    return null;
  }).filter(Boolean);
  return replaceCursorRanges(ranges, '', 'delete-word');
}

function deleteWordForward() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-word')) return true;
  const ranges = ensureSelections(state).map(sel => {
    const line = state.editLines[sel.row] || '';
    if (sel.col < line.length) {
      const col = wordRight(line, sel.col);
      return normalizeRange(sel.row, sel.col, sel.row, col);
    }
    if (sel.row < state.editLines.length - 1) {
      return normalizeRange(sel.row, sel.col, sel.row + 1, 0);
    }
    return null;
  }).filter(Boolean);
  return replaceCursorRanges(ranges, '', 'delete-word');
}

function deleteToLineStart() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-line-start')) return true;
  const ranges = ensureSelections(state).map(sel => {
    if (sel.col > 0) return normalizeRange(sel.row, 0, sel.row, sel.col);
    if (sel.row > 0) {
      const prevLen = state.editLines[sel.row - 1].length;
      return normalizeRange(sel.row - 1, prevLen, sel.row, 0);
    }
    return null;
  }).filter(Boolean);
  return replaceCursorRanges(ranges, '', 'delete-line-start');
}

function deleteToLineEnd() {
  if (state.readonly || !state.openPath) return false;
  if (deleteSelection('delete-line-end')) return true;
  const ranges = ensureSelections(state).map(sel => {
    const line = state.editLines[sel.row] || '';
    if (sel.col < line.length) return normalizeRange(sel.row, sel.col, sel.row, line.length);
    if (sel.row < state.editLines.length - 1) return normalizeRange(sel.row, line.length, sel.row + 1, 0);
    return null;
  }).filter(Boolean);
  return replaceCursorRanges(ranges, '', 'delete-line-end');
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
    syncSelectionsFromLegacy(state);
    clearSelection();
    return true;
  });
}

function moveCursor(row, col, selecting) {
  state.scrollFreed = false;
  const current = ensureSelections(state)[0] || emptySelection(0, 0);
  row = Math.max(0, Math.min(row, state.editLines.length - 1));
  col = Math.max(0, Math.min(col, state.editLines[row].length));
  setSelections(state, [{
    anchorRow: selecting ? current.anchorRow : row,
    anchorCol: selecting ? current.anchorCol : col,
    row,
    col,
  }]);
}

function moveVertical(delta, selecting) {
  const selections = ensureSelections(state).map(sel => {
    const desired = sel.desiredCol == null ? sel.col : sel.desiredCol;
    const row = Math.max(0, Math.min(sel.row + delta, state.editLines.length - 1));
    const col = Math.min(desired, state.editLines[row].length);
    return {
      anchorRow: selecting ? sel.anchorRow : row,
      anchorCol: selecting ? sel.anchorCol : col,
      row,
      col,
      desiredCol: desired,
    };
  });
  setSelections(state, selections);
}

function moveHorizontal(delta, selecting) {
  state.desiredCol = null;
  const selections = ensureSelections(state).map(sel => {
    let row = sel.row;
    let col = sel.col;
    if (!selecting && !selectionIsEmpty(sel)) {
      const r = selectionRange(sel);
      row = delta < 0 ? r.startRow : r.endRow;
      col = delta < 0 ? r.startCol : r.endCol;
    } else if (delta < 0) {
      if (col > 0) col = previousCharIndex(state.editLines[row], col);
      else if (row > 0) {
        row--;
        col = state.editLines[row].length;
      }
    } else {
      const line = state.editLines[row] || '';
      if (col < line.length) col = nextCharIndex(line, col);
      else if (row < state.editLines.length - 1) {
        row++;
        col = 0;
      }
    }
    return {
      anchorRow: selecting ? sel.anchorRow : row,
      anchorCol: selecting ? sel.anchorCol : col,
      row,
      col,
    };
  });
  setSelections(state, selections);
}

function moveWord(delta, selecting) {
  state.desiredCol = null;
  const selections = ensureSelections(state).map(sel => {
    let row = sel.row;
    let col = sel.col;
    const line = state.editLines[row] || '';
    if (delta < 0) {
      if (col > 0) col = wordLeft(line, col);
      else if (row > 0) {
        row--;
        col = state.editLines[row].length;
      }
    } else {
      if (col < line.length) col = wordRight(line, col);
      else if (row < state.editLines.length - 1) {
        row++;
        col = 0;
      }
    }
    return {
      anchorRow: selecting ? sel.anchorRow : row,
      anchorCol: selecting ? sel.anchorCol : col,
      row,
      col,
    };
  });
  setSelections(state, selections);
}

function moveHome(selecting) {
  state.desiredCol = null;
  const selections = ensureSelections(state).map(sel => {
    const line = state.editLines[sel.row] || '';
    const first = line.search(/\S/);
    const indent = first < 0 ? 0 : first;
    const col = sel.col === indent ? 0 : indent;
    return {
      anchorRow: selecting ? sel.anchorRow : sel.row,
      anchorCol: selecting ? sel.anchorCol : col,
      row: sel.row,
      col,
    };
  });
  setSelections(state, selections);
}

function moveLineEnd(selecting) {
  state.desiredCol = null;
  const selections = ensureSelections(state).map(sel => {
    const col = (state.editLines[sel.row] || '').length;
    return {
      anchorRow: selecting ? sel.anchorRow : sel.row,
      anchorCol: selecting ? sel.anchorCol : col,
      row: sel.row,
      col,
    };
  });
  setSelections(state, selections);
}

function moveDocumentStart(selecting) {
  state.desiredCol = null;
  const selections = ensureSelections(state).map(sel => ({
    anchorRow: selecting ? sel.anchorRow : 0,
    anchorCol: selecting ? sel.anchorCol : 0,
    row: 0,
    col: 0,
  }));
  setSelections(state, selections);
}

function moveDocumentEnd(selecting) {
  state.desiredCol = null;
  const row = state.editLines.length - 1;
  const col = state.editLines[row].length;
  const selections = ensureSelections(state).map(sel => ({
    anchorRow: selecting ? sel.anchorRow : row,
    anchorCol: selecting ? sel.anchorCol : col,
    row,
    col,
  }));
  setSelections(state, selections);
}

function selectAll() {
  state.scrollFreed = false;
  const row = state.editLines.length - 1;
  setSelections(state, [{
    anchorRow: 0,
    anchorCol: 0,
    row,
    col: state.editLines[row].length,
  }]);
}

function addCursor(row, col) {
  if (!state.openPath) return false;
  row = Math.max(0, Math.min(row, state.editLines.length - 1));
  col = Math.max(0, Math.min(col, state.editLines[row].length));
  const selections = ensureSelections(state).concat([emptySelection(row, col)]);
  setSelections(state, selections);
  setStatus(state.selections.length + ' cursors', 'info', 1200);
  return true;
}

function addCursorVertical(delta) {
  if (!state.openPath) return false;
  const selections = ensureSelections(state);
  const base = selections[selections.length - 1] || selections[0];
  const row = Math.max(0, Math.min(base.row + delta, state.editLines.length - 1));
  if (row === base.row) return false;
  const col = Math.min(base.col, state.editLines[row].length);
  return addCursor(row, col);
}

function indentUnit() {
  if (state.indentWithTabs) return '\t';
  return ' '.repeat(Math.max(1, state.tabSize || DEFAULT_TAB_SIZE));
}

function detectIndentation(content) {
  const lines = normalizeContent(content).split('\n');
  let tabLines = 0;
  const widthCounts = new Map();
  let prevIndent = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line[0] === '\t') {
      tabLines++;
      continue;
    }
    const m = line.match(/^ +/);
    const indent = m ? m[0].length : 0;
    const delta = indent - prevIndent;
    if (delta >= 2 && delta <= 8) widthCounts.set(delta, (widthCounts.get(delta) || 0) + 1);
    prevIndent = indent;
  }
  let bestWidth = 0;
  let bestCount = 0;
  for (const [width, count] of widthCounts) {
    if (count > bestCount) {
      bestWidth = width;
      bestCount = count;
    }
  }
  return {
    tabs: tabLines > bestCount,
    size: bestWidth || DEFAULT_TAB_SIZE,
  };
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
    syncSelectionsFromLegacy(state);
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
    syncSelectionsFromLegacy(state);
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
    syncSelectionsFromLegacy(state);
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
    syncSelectionsFromLegacy(state);
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
  const selections = ensureSelections(state);
  if (selections.length > 1) {
    return commitSnapshotEdit('insert-pair', 'insert pair', () => {
      const edits = selections.map(sel => {
        const range = selectionRange(sel);
        const selected = selectionIsEmpty(sel) ? '' : textFromRange(range);
        const text = ch + selected + close;
        return {
          range,
          text,
          afterOffset: selected ? text.length : ch.length,
        };
      });
      const positions = replaceRangesRaw(edits);
      setSelections(state, positions.map(pos => emptySelection(pos.row, pos.col)));
      return true;
    });
  }
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
  const selections = ensureSelections(state);
  if (Object.values(PAIRS).includes(ch) && !hasSelection() &&
      selections.every(sel => (state.editLines[sel.row] || '')[sel.col] === ch)) {
    moveHorizontal(1, false);
    return true;
  }
  return false;
}

function tryDeletePairBackward() {
  if (hasSelection() || state.readonly || !state.openPath) return false;
  const ranges = ensureSelections(state).map(sel => {
    if (sel.col <= 0) return null;
    const line = state.editLines[sel.row] || '';
    const prev = line[sel.col - 1];
    const next = line[sel.col];
    if (!prev || PAIRS[prev] !== next) return null;
    return normalizeRange(sel.row, sel.col - 1, sel.row, sel.col + 1);
  });
  if (ranges.some(r => !r)) return false;
  return replaceCursorRanges(ranges, '', 'delete-pair');
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
  syncSelectionsFromLegacy(state);
  clampCursor();
  const total = countFindMatches(query);
  const index = countMatchesBefore(query, row, col) + 1;
  setStatus('Match ' + index + '/' + total + ': ' + query, 'info', 2200);
  return true;
}

function selectNextOccurrence() {
  if (!state.openPath) return false;
  state.scrollFreed = false;
  const selections = ensureSelections(state);
  const last = selections[selections.length - 1];

  if (selectionIsEmpty(last)) {
    const line = state.editLines[last.row] || '';
    if (!line.trim()) return false;
    const wb = wordBoundsAt(line, Math.min(last.col, Math.max(0, line.length - 1)));
    if (wb.start === wb.end) return false;
    setSelections(state, selections.slice(0, -1).concat([{
      anchorRow: last.row,
      anchorCol: wb.start,
      row: last.row,
      col: wb.end,
    }]));
    return true;
  }

  const lastRange = selectionRange(last);
  if (lastRange.startRow !== lastRange.endRow) return false;
  const query = textFromRange(lastRange);
  if (!query) return false;

  const matches = [];
  for (let row = 0; row < state.editLines.length; row++) {
    const line = state.editLines[row];
    let idx = 0;
    while ((idx = line.indexOf(query, idx)) >= 0) {
      matches.push({ row, start: idx, end: idx + query.length });
      idx += Math.max(1, query.length);
    }
  }

  const selectedKeys = new Set(getSelectionRanges()
    .filter(r => r.startRow === r.endRow)
    .map(r => r.startRow + ':' + r.startCol + ':' + r.endCol));
  const isAfterLast = m => m.row > lastRange.endRow ||
    (m.row === lastRange.endRow && m.start >= lastRange.endCol);
  const ordered = matches.filter(isAfterLast).concat(matches.filter(m => !isAfterLast(m)));

  for (const m of ordered) {
    if (selectedKeys.has(m.row + ':' + m.start + ':' + m.end)) continue;
    setSelections(state, selections.concat([{
      anchorRow: m.row,
      anchorCol: m.start,
      row: m.row,
      col: m.end,
    }]));
    setStatus(state.selections.length + ' selections', 'info', 1400);
    return true;
  }
  setStatus('All occurrences selected', 'info', 1600);
  return false;
}

function selectLine() {
  if (!state.openPath) return false;
  state.scrollFreed = false;
  const sel = ensureSelections(state)[0];
  const r = selectionRange(sel);
  const lastRow = state.editLines.length - 1;
  const empty = selectionIsEmpty(sel);
  const startRow = empty ? sel.row : r.startRow;

  let lastTouched;
  if (empty) lastTouched = sel.row;
  else if (r.endCol === 0 && r.endRow > r.startRow) {
    lastTouched = r.startCol === 0 ? r.endRow : r.endRow - 1;
  } else {
    lastTouched = r.endRow;
  }

  let row, col;
  if (lastTouched >= lastRow) {
    row = lastRow;
    col = state.editLines[lastRow].length;
  } else {
    row = lastTouched + 1;
    col = 0;
  }
  setSelections(state, [{ anchorRow: startRow, anchorCol: 0, row, col }]);
  return true;
}

function matchesFindQuery(text, query) {
  if (state.findCaseSensitive) return text === query;
  return text.toLowerCase() === query.toLowerCase();
}

function replaceNext(query, replacement) {
  if (!state.openPath || state.readonly) return false;
  if (query != null) state.findQuery = String(query);
  const q = state.findQuery;
  if (!q) return false;
  const sel = getSelectionRange();
  if (sel && matchesFindQuery(textFromRange(sel), q)) {
    replaceRange(sel, replacement, 'replace');
  }
  return findNext(q, false);
}

function replaceAllMatches(query, replacement) {
  if (!state.openPath || state.readonly) return 0;
  query = String(query || '');
  replacement = normalizeContent(replacement || '');
  if (!query) return 0;
  let count = 0;
  const ok = commitSnapshotEdit('replace-all', 'replace all', () => {
    const q = state.findCaseSensitive ? query : query.toLowerCase();
    for (let row = 0; row < state.editLines.length; row++) {
      const line = state.editLines[row];
      const hay = state.findCaseSensitive ? line : line.toLowerCase();
      if (hay.indexOf(q) < 0) continue;
      let out = '';
      let i = 0;
      let idx;
      while ((idx = hay.indexOf(q, i)) >= 0) {
        out += line.substring(i, idx) + replacement;
        i = idx + query.length;
        count++;
      }
      out += line.substring(i);
      state.editLines[row] = out;
    }
    if (count > 0 && replacement.indexOf('\n') >= 0) {
      state.editLines = state.editLines.join('\n').split('\n');
    }
    return count > 0;
  });
  return ok ? count : 0;
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

const BRACKET_CLOSE_TO_OPEN = { ')': '(', ']': '[', '}': '{' };
const BRACKET_SCAN_BUDGET = 200000;

function findBracketMatch() {
  if (!state.openPath) return null;
  const sel = ensureSelections(state)[0];
  if (!sel || !selectionIsEmpty(sel)) return null;
  const line = state.editLines[sel.row] || '';
  let col = -1;
  let ch = '';
  for (const c of [sel.col, sel.col - 1]) {
    const candidate = c >= 0 ? line[c] : '';
    if (candidate && (BLOCK_PAIRS[candidate] || BRACKET_CLOSE_TO_OPEN[candidate])) {
      col = c;
      ch = candidate;
      break;
    }
  }
  if (col < 0) return null;
  const partner = BLOCK_PAIRS[ch]
    ? scanBracketForward(sel.row, col, ch, BLOCK_PAIRS[ch])
    : scanBracketBackward(sel.row, col, BRACKET_CLOSE_TO_OPEN[ch], ch);
  if (!partner) return null;
  return [{ row: sel.row, col }, partner];
}

function scanBracketForward(row, col, open, close) {
  let depth = 0;
  let budget = BRACKET_SCAN_BUDGET;
  for (let r = row; r < state.editLines.length; r++) {
    const line = state.editLines[r] || '';
    for (let c = r === row ? col : 0; c < line.length; c++) {
      if (--budget < 0) return null;
      const ch = line[c];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return { row: r, col: c };
      }
    }
  }
  return null;
}

function scanBracketBackward(row, col, open, close) {
  let depth = 0;
  let budget = BRACKET_SCAN_BUDGET;
  for (let r = row; r >= 0; r--) {
    const line = state.editLines[r] || '';
    for (let c = r === row ? col : line.length - 1; c >= 0; c--) {
      if (--budget < 0) return null;
      const ch = line[c];
      if (ch === close) depth++;
      else if (ch === open) {
        depth--;
        if (depth === 0) return { row: r, col: c };
      }
    }
  }
  return null;
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
    state.docVersion++;
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
    syncSelectionsFromLegacy(state);
    clearSelection();
    setStatus(result.error || 'Cannot open file', result.binary ? 'info' : 'error', 3000);
    return false;
  }

  state.openPath = filePath;
  state.openName = baseName(filePath);
  state.originalContent = normalizeContent(result.content);
  setLinesFromContent(result.content);
  const indent = detectIndentation(result.content);
  state.tabSize = indent.size;
  state.indentWithTabs = indent.tabs;
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
  syncSelectionsFromLegacy(state);
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

async function saveFileAs(targetPath) {
  if (!state.openPath || state.readonly || !targetPath) return false;
  const content = contentFromLines({ native: true });
  const result = await writeTextFile(targetPath, content);
  if (!result.ok) {
    setStatus(result.error || 'Save failed', 'error', 4000);
    return false;
  }
  state.openPath = targetPath;
  state.openName = baseName(targetPath);
  state.originalContent = normalizedContentFromLines();
  state.dirty = false;
  state.fileMtimeMs = result.mtime || Date.now();
  state.fileSizeBytes = result.size || content.length;
  state.lastSavedAt = Date.now();
  resetEditCoalescing();
  setStatus('Saved as ' + state.openName, 'success', 2200);
  return true;
}

function remapOpenPath(oldPath, newPath) {
  if (!state.openPath) return;
  if (state.openPath === oldPath) {
    state.openPath = newPath;
    state.openName = baseName(newPath);
  } else if (state.openPath.startsWith(oldPath + '/')) {
    state.openPath = newPath + state.openPath.substring(oldPath.length);
  }
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
  state.docVersion++;
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.scrollY = 0;
  state.scrollX = 0;
  state.scrollFreed = false;
  state.dirty = false;
  state.readonly = false;
  state.binary = false;
  state.findQuery = '';
  state.tabSize = DEFAULT_TAB_SIZE;
  state.indentWithTabs = false;
  resetHistory();
  syncSelectionsFromLegacy(state);
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
  getSelectionRanges,
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
  insertNewline,
  indentUnit,
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
  moveLineEnd,
  moveDocumentStart,
  moveDocumentEnd,
  selectAll,
  selectLine,
  selectNextOccurrence,
  addCursor,
  addCursorVertical,
  findNext,
  replaceNext,
  replaceAllMatches,
  gotoLine,
  countFindMatches,
  findBracketMatch,
  openFile,
  saveFile,
  saveFileAs,
  remapOpenPath,
  closeFile,
};
