const { ansi, colors } = require('./ansi');
const { state, clearExpiredStatus } = require('./state');
const { baseName, formatSize, formatTime } = require('./fs-ops');
const {
  padRight,
  truncateAnsi,
  stringWidth,
  visibleSlice,
  sanitizeDisplayText,
} = require('./text');
const { getSelectionRange, hasSelection } = require('./editor');
const { highlightLine, getLanguage } = require('./highlighter');
const {
  CURSOR_PALETTE,
  renderCursorPixels,
  encodeSixel,
  encodeClearSixel,
} = require('./sixel');

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fit(text, width) {
  if (width <= 0) return '';
  const truncated = truncateAnsi(String(text || ''), width);
  return padRight(truncated, width);
}

function resetInlineStyle() {
  return ansi.noBold + ansi.noItalic + ansi.noUnderline + ansi.noInverse + ansi.fg.default;
}

function render() {
  clearExpiredStatus();
  if (state.minimized) return renderMinimized();

  const rows = Math.max(7, state.termRows || 24);
  const cols = Math.max(40, state.termCols || 80);
  const bodyTop = 4;
  const sepRow = 3;
  const bottomSepRow = rows - 1;
  const statusRow = rows;
  const bodyH = Math.max(1, bottomSepRow - bodyTop);
  const layout = computePanelLayout(cols);
  const treeW = layout.treeW;
  const editorW = layout.editorW;
  const dividerCol = layout.dividerCol;
  const editorCol = layout.editorCol;

  state.layout = {
    treeW,
    editorW,
    bodyTop,
    bodyH,
    sepRow,
    bottomSepRow,
    statusRow,
    dividerCol,
    dividerVisible: layout.dividerVisible,
    editorCol,
    treeScrollCol: layout.hasTree ? treeW : 0,
    editorScrollCol: layout.hasEditor ? cols : 0,
    gutterW: Math.max(3, String(state.editLines.length).length) + 1,
    titleZones: [],
  };

  if (layout.hasTree) keepTreeCursorVisible(bodyH);
  if (layout.hasEditor) keepEditorCursorVisible(editorW, bodyH);

  const out = [];
  out.push(ansi.clear + ansi.hideCursor);
  out.push(ansi.moveTo(1, 1) + renderTitle(cols));
  out.push(ansi.moveTo(2, 1) + renderPanelHeaders(layout));
  out.push(ansi.moveTo(sepRow, 1) + renderSeparator(layout));

  const treeLines = layout.hasTree ? renderTreeLines(treeW, bodyH) : [];
  const editorLines = layout.hasEditor ? renderEditorLines(editorW, bodyH) : [];
  for (let i = 0; i < bodyH; i++) {
    let line = ansi.moveTo(bodyTop + i, 1);
    if (layout.hasTree) line += treeLines[i];
    if (layout.dividerVisible) line += colors.border + '\u2502' + ansi.reset;
    if (layout.hasEditor) line += editorLines[i];
    out.push(line);
  }

  out.push(ansi.moveTo(bottomSepRow, 1) + renderBottomSeparator(layout));
  out.push(ansi.moveTo(statusRow, 1) + renderStatus(cols));
  process.stdout.write(out.join(''));
  renderEditorCursorOverlay();
}

function computePanelLayout(cols) {
  let hasTree = !state.treeCollapsed;
  let hasEditor = !state.editorCollapsed;
  if (!hasTree && !hasEditor) {
    hasEditor = true;
    state.editorCollapsed = false;
  }

  if (hasTree && !hasEditor) {
    return { hasTree, hasEditor, treeW: cols, editorW: 0, dividerCol: 0, editorCol: cols + 1, dividerVisible: false };
  }
  if (!hasTree && hasEditor) {
    return { hasTree, hasEditor, treeW: 0, editorW: cols, dividerCol: 0, editorCol: 1, dividerVisible: false };
  }

  const minTree = Math.min(18, Math.max(8, cols - 24));
  const minEditor = Math.min(24, Math.max(12, cols - minTree - 1));
  const maxTree = Math.max(minTree, cols - minEditor - 1);
  const treeW = clamp(Math.floor(cols * state.dividerRatio), minTree, maxTree);
  state.dividerRatio = treeW / cols;
  return {
    hasTree,
    hasEditor,
    treeW,
    editorW: Math.max(1, cols - treeW - 1),
    dividerCol: treeW + 1,
    editorCol: treeW + 2,
    dividerVisible: true,
  };
}

function renderMinimized() {
  const cols = Math.max(20, state.termCols || 80);
  const title = ' Code ' + (state.openName || baseName(state.root) || '');
  const marker = state.dirty ? ' *' : '';
  process.stdout.write(ansi.clear + ansi.hideCursor + ansi.moveTo(1, 1) + fit(colors.title + title + marker + ansi.reset, cols));
}

function renderTitle(width) {
  const zones = [];
  let col = 1;
  let line = '';

  const explorerLabel = state.treeCollapsed ? ' [+ Explorer] ' : ' [- Explorer] ';
  zones.push({ row: 1, colStart: col, colEnd: col + explorerLabel.length - 1, action: 'toggle-tree' });
  line += colors.title + explorerLabel + ansi.reset;
  col += explorerLabel.length;

  const editorLabel = state.editorCollapsed ? ' [+ Editor] ' : ' [- Editor] ';
  zones.push({ row: 1, colStart: col, colEnd: col + editorLabel.length - 1, action: 'toggle-editor' });
  line += colors.title + editorLabel + ansi.reset;

  state.layout.titleZones = zones;
  return fit(line, width);
}

function renderPanelHeaders(layout) {
  const treeW = layout.treeW;
  const editorW = layout.editorW;
  const rootLabel = state.root ? baseName(state.root) || state.root : 'Open Folder';
  const leftStyle = state.focus === 'tree' ? colors.active : '';
  const rightStyle = state.focus === 'editor' ? colors.active : '';
  const treeCount = state.treeEntries.length ? '  ' + state.treeEntries.length + ' items' : '';
  const fileLabel = state.openName
    ? (state.dirty ? '* ' : '') + state.openName + (state.readonly ? ' [readonly]' : '') + '  Lines ' + state.editLines.length
    : 'No file';
  let line = '';
  if (layout.hasTree) line += leftStyle + fit(' ' + rootLabel + treeCount, treeW) + ansi.reset;
  if (layout.dividerVisible) line += colors.border + '\u2502' + ansi.reset;
  if (layout.hasEditor) line += rightStyle + fit(' ' + fileLabel, editorW) + ansi.reset;
  return line;
}

function renderSeparator(layout) {
  let line = colors.border;
  if (layout.hasTree) line += '\u2500'.repeat(layout.treeW);
  if (layout.dividerVisible) line += '\u253c';
  if (layout.hasEditor) line += '\u2500'.repeat(layout.editorW);
  return line + ansi.reset;
}

function renderBottomSeparator(layout) {
  const leftPct = scrollPct(state.treeScroll, Math.max(0, state.treeEntries.length - state.layout.bodyH));
  const rightPct = scrollPct(state.scrollY, Math.max(0, state.editLines.length - state.layout.bodyH));
  let line = colors.border;
  if (layout.hasTree) line += labelOnRule(layout.treeW, leftPct >= 0 ? leftPct + '%' : '');
  if (layout.dividerVisible) line += '\u253c';
  if (layout.hasEditor) line += labelOnRule(layout.editorW, rightPct >= 0 ? rightPct + '%' : '');
  return line + ansi.reset;
}

function labelOnRule(width, label) {
  if (!label || width < label.length + 4) return '\u2500'.repeat(width);
  const text = ' ' + label + ' ';
  return '\u2500'.repeat(width - text.length) + text;
}

function keepTreeCursorVisible(height) {
  const max = Math.max(0, state.treeEntries.length - 1);
  state.treeCursor = clamp(state.treeCursor, 0, max);
  if (state.treeCursor < state.treeScroll) state.treeScroll = state.treeCursor;
  if (state.treeCursor >= state.treeScroll + height) state.treeScroll = state.treeCursor - height + 1;
  state.treeScroll = clamp(state.treeScroll, 0, Math.max(0, state.treeEntries.length - height));
}

function renderTreeLines(width, height) {
  const lines = [];
  const contentW = Math.max(1, width - 1);
  const maxScroll = Math.max(0, state.treeEntries.length - height);
  if (state.loading) {
    lines.push(fit(colors.dim + ' Loading...' + ansi.reset, contentW) + renderScrollbarCell(0, height, state.treeScroll, maxScroll));
  } else if (!state.root) {
    lines.push(fit(colors.dim + ' No folder selected' + ansi.reset, contentW) + renderScrollbarCell(0, height, state.treeScroll, maxScroll));
  } else if (state.treeEntries.length === 0) {
    lines.push(fit(colors.dim + ' Empty folder' + ansi.reset, contentW) + renderScrollbarCell(0, height, state.treeScroll, maxScroll));
  }

  for (let row = lines.length; row < height; row++) {
    const idx = state.treeScroll + row;
    const entry = state.treeEntries[idx];
    if (!entry) {
      lines.push(' '.repeat(contentW) + renderScrollbarCell(row, height, state.treeScroll, maxScroll));
      continue;
    }

    const selected = idx === state.treeCursor;
    const open = entry.path === state.openPath;
    const indent = '  '.repeat(Math.max(0, entry.depth));
    const marker = entry.isDir ? (entry.expanded ? '- ' : '+ ') : '  ';
    const nameColor = entry.isDir ? colors.treeDir : colors.treeFile;
    const inlineReset = resetInlineStyle();
    const openMark = open ? colors.saved + '>' + inlineReset : ' ';
    let line = openMark + indent + marker + nameColor + entry.name + inlineReset;
    if (!entry.isDir && contentW > 28) {
      const meta = entry.size ? colors.dim + ' ' + formatSize(entry.size) + inlineReset : '';
      const free = contentW - stringWidth(entry.name) - stringWidth(indent) - 5;
      if (free > 8) line += meta;
    }
    line = fit(line, contentW);
    if (selected) line = colors.selected + line + ansi.reset;
    lines.push(line + renderScrollbarCell(row, height, state.treeScroll, maxScroll));
  }
  return lines.slice(0, height);
}

function keepEditorCursorVisible(editorW, height) {
  const gutterW = Math.max(3, String(state.editLines.length).length) + 1;
  const contentW = Math.max(1, editorW - gutterW - 3);
  state.cursorRow = clamp(state.cursorRow, 0, Math.max(0, state.editLines.length - 1));
  const line = state.editLines[state.cursorRow] || '';
  state.cursorCol = clamp(state.cursorCol, 0, line.length);

  if (!state.dragging && !state.scrollFreed) {
    if (state.cursorRow < state.scrollY) state.scrollY = state.cursorRow;
    if (state.cursorRow >= state.scrollY + height) state.scrollY = state.cursorRow - height + 1;
  }
  state.scrollY = clamp(state.scrollY, 0, Math.max(0, state.editLines.length - height));

  const cursorX = stringWidth(line.substring(0, state.cursorCol));
  if (!state.dragging && !state.scrollFreed) {
    if (cursorX < state.scrollX) state.scrollX = cursorX;
    if (cursorX >= state.scrollX + contentW) state.scrollX = cursorX - contentW + 1;
  }
  state.scrollX = Math.max(0, state.scrollX);
}

function renderEditorLines(width, height) {
  const lines = [];
  const maxScroll = Math.max(0, state.editLines.length - height);
  const panelW = Math.max(1, width - 1);
  if (!state.openPath) {
    const messages = [
      '',
      ' Select a file in Explorer and press Enter.',
      ' Ctrl+O opens a different folder.',
      '',
    ];
    for (let i = 0; i < height; i++) {
      lines.push(fit(colors.dim + (messages[i] || '') + ansi.reset, panelW) + renderScrollbarCell(i, height, 0, 0));
    }
    return lines;
  }

  const gutterW = state.layout.gutterW;
  const contentW = Math.max(1, panelW - gutterW - 2);
  for (let row = 0; row < height; row++) {
    const lineIdx = state.scrollY + row;
    if (lineIdx >= state.editLines.length) {
      lines.push(fit(colors.lineNo + ' '.repeat(gutterW) + ' \u2502' + ansi.reset, panelW) +
        renderScrollbarCell(row, height, state.scrollY, maxScroll));
      continue;
    }

    const lineNo = String(lineIdx + 1).padStart(gutterW - 1, ' ') + ' ';
    const gutter = colors.lineNo + lineNo + '\u2502' + ansi.reset + ' ';
    let content = renderCodeContent(lineIdx, contentW);
    let full = gutter + content;
    full = fit(full, panelW);
    lines.push(full + renderScrollbarCell(row, height, state.scrollY, maxScroll));
  }
  return lines;
}

function renderCodeContent(lineIdx, width) {
  const raw = state.editLines[lineIdx] || '';
  const slice = visibleSlice(raw, state.scrollX, width);
  const segment = sanitizeDisplayText(slice.text);
  const leading = ' '.repeat(slice.leftPad);
  const selected = selectionTouchesLine(lineIdx);
  const highlighted = highlightLine(segment, state.openPath);

  if (selected) {
    return fit(leading + renderMarkedHighlighted(highlighted, segment, lineIdx, slice.start), width);
  }

  return fit(leading + highlighted, width);
}

function selectionTouchesLine(lineIdx) {
  const r = getSelectionRange();
  if (!r) return false;
  return lineIdx >= r.startRow && lineIdx <= r.endRow;
}

function renderMarkedHighlighted(highlighted, segment, lineIdx, startChar) {
  const sel = getSelectionRange();
  let out = '';
  let plainOffset = 0;
  let i = 0;

  while (i < highlighted.length) {
    if (highlighted[i] === '\x1b') {
      const m = highlighted.substring(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }

    const cp = highlighted.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const absolute = startChar + plainOffset;
    const selected = sel && isSelected(lineIdx, absolute, sel);
    if (selected) out += ansi.inverse + ch + ansi.noInverse;
    else out += ch;
    i += ch.length;
    plainOffset += ch.length;
  }

  return out;
}

function renderEditorCursorOverlay() {
  if (!state.openPath || state.focus !== 'editor') return;
  if (state.cellW <= 0 || state.cellH <= 0) return;

  const layout = state.layout;
  const gutterW = layout.gutterW;
  const contentW = Math.max(1, layout.editorW - 1 - gutterW - 2);
  const cursorDisplayCol = stringWidth((state.editLines[state.cursorRow] || '').substring(0, state.cursorCol));
  const row = layout.bodyTop + (state.cursorRow - state.scrollY);
  const col = layout.editorCol + gutterW + 2 + (cursorDisplayCol - state.scrollX);
  const visible = row >= layout.bodyTop &&
    row < layout.bodyTop + layout.bodyH &&
    col >= layout.editorCol + gutterW + 2 &&
    col < layout.editorCol + gutterW + 2 + contentW;

  if (!visible) return;

  if (!state.cursorBlinkOn) {
    process.stdout.write(ansi.moveTo(row, col) + encodeClearSixel(state.cellW, state.cellH));
    return;
  }

  const pixels = renderCursorPixels(state.cellW, state.cellH);
  const sixel = encodeSixel(pixels, state.cellW, state.cellH, CURSOR_PALETTE);
  process.stdout.write(ansi.moveTo(row, col) + sixel);
}

function isSelected(row, col, sel) {
  if (row < sel.startRow || row > sel.endRow) return false;
  if (sel.startRow === sel.endRow) return col >= sel.startCol && col < sel.endCol;
  if (row === sel.startRow) return col >= sel.startCol;
  if (row === sel.endRow) return col < sel.endCol;
  return true;
}

function renderStatus(width) {
  const info = state.focus === 'editor' && state.openPath
    ? renderEditorStatusInfo()
    : renderExplorerStatusInfo();
  const messageColor = state.statusKind === 'error' ? colors.error :
    state.statusKind === 'success' ? colors.saved : colors.status;
  const message = state.status ? '  ' + messageColor + state.status + ansi.reset : '';
  return fit(colors.status + ' ' + info + ansi.reset + message, width);
}

function renderEditorStatusInfo() {
  const parts = [
    (state.dirty ? '* ' : '') + (state.openName || baseName(state.openPath)),
    'Ln ' + (state.cursorRow + 1) + '/' + state.editLines.length,
    'Col ' + (state.cursorCol + 1),
  ];
  if (state.readonly) parts.push('readonly');
  if (state.binary) parts.push('binary');
  if (state.fileSizeBytes) parts.push(formatSize(state.fileSizeBytes));
  const lang = getLanguage(state.openPath);
  if (lang) parts.push(lang);
  return parts.filter(Boolean).join('  ');
}

function renderExplorerStatusInfo() {
  const entry = state.treeEntries[state.treeCursor];
  if (!state.root) return 'No folder selected';
  if (!entry) return 'Folder  ' + state.root;

  const parts = [entry.name];
  if (entry.isSymlink) parts.push('symlink');
  if (!entry.isDir) parts.push(formatSize(entry.size || 0));
  if (entry.mtime) parts.push('Modified ' + formatTime(entry.mtime));
  if (entry.ctime) parts.push('Created ' + formatTime(entry.ctime));
  return parts.filter(Boolean).join('  ');
}

function scrollPct(offset, maxScroll) {
  if (maxScroll <= 0) return -1;
  return Math.round((offset / maxScroll) * 100);
}

function renderScrollbarCell(row, viewportRows, scrollOffset, maxScroll) {
  if (maxScroll <= 0 || viewportRows <= 0) return ' ';
  const totalRows = viewportRows + maxScroll;
  const handleH = Math.max(1, Math.floor((viewportRows * viewportRows) / totalRows));
  const handleY = Math.floor((viewportRows - handleH) * scrollOffset / maxScroll);
  if (row >= handleY && row < handleY + handleH) {
    return colors.title + '\u2588' + ansi.reset;
  }
  return colors.border + '\u2502' + ansi.reset;
}

module.exports = { render };
