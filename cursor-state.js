function comparePositions(aRow, aCol, bRow, bCol) {
  if (aRow !== bRow) return aRow < bRow ? -1 : 1;
  if (aCol !== bCol) return aCol < bCol ? -1 : 1;
  return 0;
}

function emptySelection(row, col) {
  return { anchorRow: row, anchorCol: col, row, col };
}

function cloneSelection(sel) {
  return {
    anchorRow: sel.anchorRow,
    anchorCol: sel.anchorCol,
    row: sel.row,
    col: sel.col,
  };
}

function selectionIsEmpty(sel) {
  return sel.anchorRow === sel.row && sel.anchorCol === sel.col;
}

function selectionRange(sel) {
  if (comparePositions(sel.anchorRow, sel.anchorCol, sel.row, sel.col) > 0) {
    return { startRow: sel.row, startCol: sel.col, endRow: sel.anchorRow, endCol: sel.anchorCol };
  }
  return { startRow: sel.anchorRow, startCol: sel.anchorCol, endRow: sel.row, endCol: sel.col };
}

function selectionFromRange(range, reversed) {
  if (reversed) {
    return {
      anchorRow: range.endRow,
      anchorCol: range.endCol,
      row: range.startRow,
      col: range.startCol,
    };
  }
  return {
    anchorRow: range.startRow,
    anchorCol: range.startCol,
    row: range.endRow,
    col: range.endCol,
  };
}

function clampPosition(row, col, lines) {
  if (!lines.length) lines = [''];
  row = Math.max(0, Math.min(row, lines.length - 1));
  col = Math.max(0, Math.min(col, (lines[row] || '').length));
  return { row, col };
}

function clampSelection(sel, lines) {
  const anchor = clampPosition(sel.anchorRow, sel.anchorCol, lines);
  const position = clampPosition(sel.row, sel.col, lines);
  return {
    anchorRow: anchor.row,
    anchorCol: anchor.col,
    row: position.row,
    col: position.col,
  };
}

function rangeCompare(a, b) {
  return comparePositions(a.startRow, a.startCol, b.startRow, b.startCol) ||
    comparePositions(a.endRow, a.endCol, b.endRow, b.endCol);
}

function rangesShouldMerge(a, b, aEmpty, bEmpty) {
  const startVsEnd = comparePositions(b.startRow, b.startCol, a.endRow, a.endCol);
  if (aEmpty || bEmpty) return startVsEnd <= 0;
  return startVsEnd < 0;
}

function mergeRanges(a, b) {
  const start = comparePositions(a.startRow, a.startCol, b.startRow, b.startCol) <= 0 ? a : b;
  const end = comparePositions(a.endRow, a.endCol, b.endRow, b.endCol) >= 0 ? a : b;
  return {
    startRow: start.startRow,
    startCol: start.startCol,
    endRow: end.endRow,
    endCol: end.endCol,
  };
}

function normalizeSelections(selections, lines) {
  const source = Array.isArray(selections) && selections.length
    ? selections
    : [emptySelection(0, 0)];
  const sorted = source
    .map(sel => clampSelection(sel, lines))
    .map((sel, index) => ({ sel, range: selectionRange(sel), index }))
    .sort((a, b) => rangeCompare(a.range, b.range) || a.index - b.index);

  const result = [];
  for (const item of sorted) {
    const last = result[result.length - 1];
    if (!last) {
      result.push(item);
      continue;
    }

    if (!rangesShouldMerge(last.range, item.range, selectionIsEmpty(last.sel), selectionIsEmpty(item.sel))) {
      result.push(item);
      continue;
    }

    const merged = mergeRanges(last.range, item.range);
    const keepReversed = comparePositions(last.sel.anchorRow, last.sel.anchorCol, last.sel.row, last.sel.col) > 0;
    last.range = merged;
    last.sel = selectionFromRange(merged, keepReversed);
  }

  return result.map(item => item.sel);
}

function legacySelection(state) {
  const anchorRow = state.selAnchorRow >= 0 ? state.selAnchorRow : state.cursorRow;
  const anchorCol = state.selAnchorRow >= 0 ? state.selAnchorCol : state.cursorCol;
  return {
    anchorRow,
    anchorCol,
    row: state.cursorRow,
    col: state.cursorCol,
  };
}

function ensureSelections(state) {
  if (!Array.isArray(state.selections) || state.selections.length === 0) {
    state.selections = [legacySelection(state)];
  }
  state.selections = normalizeSelections(state.selections, state.editLines);
  syncLegacyFromSelections(state);
  return state.selections;
}

function setSelections(state, selections) {
  state.selections = normalizeSelections(selections, state.editLines);
  syncLegacyFromSelections(state);
}

function syncLegacyFromSelections(state) {
  const primary = (state.selections && state.selections[0]) || emptySelection(0, 0);
  state.cursorRow = primary.row;
  state.cursorCol = primary.col;
  if (selectionIsEmpty(primary)) {
    state.selAnchorRow = -1;
    state.selAnchorCol = -1;
  } else {
    state.selAnchorRow = primary.anchorRow;
    state.selAnchorCol = primary.anchorCol;
  }
}

function syncSelectionsFromLegacy(state) {
  setSelections(state, [legacySelection(state)]);
}

module.exports = {
  comparePositions,
  emptySelection,
  cloneSelection,
  selectionIsEmpty,
  selectionRange,
  selectionFromRange,
  normalizeSelections,
  ensureSelections,
  setSelections,
  syncLegacyFromSelections,
  syncSelectionsFromLegacy,
};
