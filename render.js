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
const { getSelectionRange, hasSelection, countFindMatches, canUndo, canRedo } = require('./editor');
const { highlightLine, getLanguage } = require('./highlighter');
const {
  CURSOR_PALETTE,
  SCROLLBAR_PALETTE,
  SCROLLBAR_ACTIVE_PALETTE,
  renderCursorPixels,
  renderScrollbarPixels,
  renderHScrollbarPixels,
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
  return ansi.noBold + ansi.noItalic + ansi.noUnderline + ansi.noInverse + ansi.fg.default + ansi.bg.default;
}

const ACTIVITY_BAR_W = 4;
const BOX = {
  H: '\u2500',
  V: '\u2502',
  CROSS: '\u253c',
  T_DOWN: '\u252c',
  T_UP: '\u2534',
  T_RIGHT: '\u251c',
};
const CODICON_CODEPOINTS = {
  'add': 0xea60,
  'comment': 0xea6b,
  'search': 0xea6d,
  'close': 0xea76,
  'file': 0xea7b,
  'new-file': 0xea7f,
  'folder-opened': 0xeaf7,
  'files': 0xeaf0,
  'go-to-file': 0xea94,
  'discard': 0xeae2,
  'edit': 0xea73,
  'clippy': 0xeac0,
  'refresh': 0xeb37,
  'save': 0xeb4b,
  'split-horizontal': 0xeb56,
  'redo': 0xebb0,
  'copy': 0xebcc,
  'layout': 0xebeb,
  'layout-sidebar-left': 0xebf3,
  'remove': 0xeb3b,
  'question': 0xeb32,
};

function codicon(name) {
  return String.fromCodePoint(CODICON_CODEPOINTS[name] || CODICON_CODEPOINTS.question);
}

function render() {
  clearExpiredStatus();
  if (state.minimized) return renderMinimized();

  const rows = Math.max(7, state.termRows || 24);
  const cols = Math.max(40, state.termCols || 80);
  const activityW = Math.min(ACTIVITY_BAR_W, Math.max(0, cols - 24));
  const contentCols = Math.max(1, cols - activityW);
  const bodyTop = 3;
  const sepRow = 2;
  const bottomSepRow = rows - 1;
  const statusRow = rows;
  const bodyH = Math.max(1, bottomSepRow - bodyTop);
  const layout = computePanelLayout(contentCols);
  const treeW = layout.treeW;
  const editorW = layout.editorW;
  const contentCol = activityW + 1;
  const treeCol = layout.hasTree ? contentCol : 0;
  const dividerCol = layout.dividerVisible ? activityW + layout.dividerCol : 0;
  const editorCol = layout.hasEditor ? activityW + layout.editorCol : cols + 1;

  state.layout = {
    activityW,
    contentCol,
    treeCol,
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
    treeScrollCol: layout.hasTree ? activityW + treeW : 0,
    editorScrollCol: layout.hasEditor ? cols : 0,
    gutterW: Math.max(3, String(state.editLines.length).length) + 1,
    titleZones: [],
    titleDividerOffsets: [],
    activityZones: [],
  };

  if (layout.hasTree) keepTreeCursorVisible(bodyH);
  if (layout.hasEditor) keepEditorCursorVisible(editorW, bodyH);

  const out = [];
  out.push(ansi.clear + ansi.hideCursor);
  out.push(ansi.moveTo(1, 1) + renderActivityRail(1) + renderTitle(contentCols));
  out.push(ansi.moveTo(sepRow, 1) + renderActivityRail(sepRow, BOX.T_RIGHT) + renderSeparator(layout));

  const treeLines = layout.hasTree ? renderTreeLines(treeW, bodyH) : [];
  const editorLines = layout.hasEditor ? renderEditorLines(editorW, bodyH) : [];
  for (let i = 0; i < bodyH; i++) {
    let line = ansi.moveTo(bodyTop + i, 1);
    line += renderActivityRail(bodyTop + i);
    if (layout.hasTree) line += treeLines[i];
    if (layout.dividerVisible) line += colors.border + '\u2502' + ansi.reset;
    if (layout.hasEditor) line += editorLines[i];
    out.push(line);
  }

  out.push(ansi.moveTo(bottomSepRow, 1) + renderActivityRail(bottomSepRow, BOX.T_RIGHT) + renderBottomSeparator(layout));
  out.push(ansi.moveTo(statusRow, 1) + renderActivityRail(statusRow) + renderStatus(contentCols));
  process.stdout.write(out.join(''));
  renderScrollbarOverlays();
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
  const title = ' ' + (state.openName || baseName(state.root) || '');
  const marker = state.dirty ? ' *' : '';
  process.stdout.write(ansi.clear + ansi.hideCursor + ansi.moveTo(1, 1) + fit(colors.title + title + marker + ansi.reset, cols));
}

function renderActivityRail(row, boundaryChar) {
  const width = state.layout.activityW || 0;
  if (width <= 0) return '';

  const iconW = Math.max(1, width - 1);
  let icon = ' ';
  let active = false;
  let focused = false;
  let action = '';

  if (row === 1) {
    icon = codicon('files');
    active = !state.treeCollapsed;
    focused = state.focus === 'tree';
    action = 'toggle-tree';
  } else if (row === 2) {
    icon = codicon('edit');
    active = !state.editorCollapsed;
    focused = state.focus === 'editor';
    action = 'toggle-editor';
  }

  if (action) {
    state.layout.activityZones.push({ row, colStart: 1, colEnd: iconW, action });
  }

  let style = active ? colors.title : colors.dim;
  if (focused && active) style = colors.active + colors.title;
  const cell = centerCell(icon, iconW);
  return style + cell + ansi.reset + colors.border + (boundaryChar || BOX.V) + ansi.reset;
}

function centerCell(text, width) {
  text = truncateAnsi(String(text || ''), width);
  const left = Math.floor(Math.max(0, width - stringWidth(text)) / 2);
  return ' '.repeat(left) + padRight(text, width - left);
}

function renderTitle(width) {
  const zones = [];
  const startCol = state.layout.contentCol || 1;
  let col = startCol;
  let used = 0;
  let line = '';

  for (const item of getToolbarItems()) {
    if (item.type === 'separator') {
      if (used + 1 > width) break;
      state.layout.titleDividerOffsets.push(used);
      line += colors.border + BOX.V + ansi.reset;
      used += 1;
      col += 1;
      continue;
    }

    const buttonW = 3;
    if (used + buttonW > width) break;
    if (item.enabled) {
      zones.push({ row: 1, colStart: col, colEnd: col + buttonW - 1, action: item.action });
    }
    line += renderToolbarButton(item, buttonW);
    used += buttonW;
    col += buttonW;
  }

  state.layout.titleZones = zones;
  return fit(line, width);
}

function getToolbarItems() {
  const hasOpen = !!state.openPath;
  const hasSel = hasSelection();
  const writable = hasOpen && !state.readonly;
  return [
    { action: 'new_file', icon: 'new-file', enabled: !!state.root },
    { action: 'open_folder', icon: 'folder-opened', enabled: true },
    { action: 'refresh', icon: 'refresh', enabled: !!state.root },
    { type: 'separator' },
    { action: 'save', icon: 'save', enabled: writable && state.dirty, accent: state.dirty ? 'dirty' : '' },
    { action: 'close_file', icon: 'close', enabled: hasOpen },
    { type: 'separator' },
    { action: 'undo', icon: 'discard', enabled: canUndo() },
    { action: 'redo', icon: 'redo', enabled: canRedo() },
    { type: 'separator' },
    { action: 'cut', icon: 'remove', enabled: hasSel && !state.readonly },
    { action: 'copy', icon: 'copy', enabled: hasSel },
    { action: 'paste', icon: 'clippy', enabled: writable },
    { type: 'separator' },
    { action: 'find', icon: 'search', enabled: hasOpen },
    { action: 'goto_line', icon: 'go-to-file', enabled: hasOpen },
    { action: 'toggle_comment', icon: 'comment', enabled: writable },
  ];
}

function renderToolbarButton(item, width) {
  const style = item.enabled
    ? (item.accent === 'dirty' ? colors.dirty : colors.title)
    : colors.dim;
  return style + centerCell(codicon(item.icon), width) + ansi.reset;
}

function renderSeparator(layout) {
  return colors.border + buildContentSeparator(
    panelWidth(layout),
    state.layout.titleDividerOffsets,
    panelDividerOffsets(layout)
  ) + ansi.reset;
}

function panelWidth(layout) {
  return (layout.hasTree ? layout.treeW : 0) +
    (layout.dividerVisible ? 1 : 0) +
    (layout.hasEditor ? layout.editorW : 0);
}

function panelDividerOffsets(layout) {
  if (!layout.dividerVisible) return [];
  return [layout.treeW];
}

function buildContentSeparator(width, aboveOffsets, belowOffsets) {
  const chars = new Array(Math.max(0, width)).fill(BOX.H);
  const above = new Set((aboveOffsets || []).filter(offset => offset >= 0 && offset < width));
  const below = new Set((belowOffsets || []).filter(offset => offset >= 0 && offset < width));

  for (const offset of above) {
    chars[offset] = below.has(offset) ? BOX.CROSS : BOX.T_UP;
  }
  for (const offset of below) {
    if (!above.has(offset)) chars[offset] = BOX.T_DOWN;
  }

  return chars.join('');
}

function renderBottomSeparator(layout) {
  const leftPct = scrollPct(state.treeScroll, Math.max(0, state.treeEntries.length - state.layout.bodyH));
  const rightPct = scrollPct(state.scrollY, Math.max(0, state.editLines.length - state.layout.bodyH));
  const contentW = getEditorContentWidth(layout.editorW);
  const maxScrollX = getMaxEditorScrollX(contentW);
  let line = colors.border;
  if (layout.hasTree) line += labelOnRule(layout.treeW, leftPct >= 0 ? leftPct + '%' : '');
  if (layout.dividerVisible) line += BOX.T_UP;
  if (layout.hasEditor) {
    if (state.openPath && maxScrollX > 0 && useSixelScrollbars()) {
      line += ' '.repeat(layout.editorW);
    } else if (state.openPath && maxScrollX > 0) {
      line += renderHorizontalScrollbar(layout.editorW, contentW, state.scrollX, maxScrollX);
    } else {
      line += labelOnRule(layout.editorW, rightPct >= 0 ? rightPct + '%' : '');
    }
  }
  return line + ansi.reset;
}

function labelOnRule(width, label) {
  if (!label || width < label.length + 4) return BOX.H.repeat(width);
  const text = ' ' + label + ' ';
  return BOX.H.repeat(width - text.length) + text;
}

function renderHorizontalScrollbar(width, viewportW, offset, maxScroll) {
  if (width <= 0) return '';
  if (maxScroll <= 0) return BOX.H.repeat(width);
  const handleW = Math.max(1, Math.floor(width * viewportW / (viewportW + maxScroll)));
  const handleX = Math.floor((width - handleW) * clamp(offset, 0, maxScroll) / maxScroll);
  const before = BOX.H.repeat(handleX);
  const handle = '\u2501'.repeat(handleW);
  const after = BOX.H.repeat(Math.max(0, width - handleX - handleW));
  return colors.border + before + colors.title + handle + colors.border + after;
}

function getEditorContentWidth(editorW) {
  const gutterW = state.layout.gutterW || Math.max(3, String(state.editLines.length).length) + 1;
  return Math.max(1, editorW - gutterW - 3);
}

function getMaxEditorScrollX(contentW) {
  let maxLineW = 0;
  for (const line of state.editLines) maxLineW = Math.max(maxLineW, stringWidth(line));
  return Math.max(0, maxLineW - contentW);
}

function useSixelScrollbars() {
  return state.cellW > 0 && state.cellH > 0;
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
    const openMark = open ? (selected ? '>' : colors.saved + '>' + inlineReset) : ' ';
    let line = openMark + indent + marker + (selected ? entry.name : nameColor + entry.name + inlineReset);
    if (!entry.isDir && contentW > 28) {
      const metaText = entry.size ? ' ' + formatSize(entry.size) : '';
      const meta = selected ? metaText : colors.dim + metaText + inlineReset;
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
  state.scrollX = clamp(state.scrollX, 0, getMaxEditorScrollX(contentW));
}

function renderEditorLines(width, height) {
  const lines = [];
  const maxScroll = Math.max(0, state.editLines.length - height);
  const panelW = Math.max(1, width - 1);
  if (!state.openPath) {
    const messages = [
      '',
      ' Select a file and press Enter.',
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
  const displayLine = sanitizeDisplayText(raw);
  const slice = visibleSlice(displayLine, state.scrollX, width);
  const segment = slice.text;
  const leading = ' '.repeat(slice.leftPad);
  const selected = selectionTouchesLine(lineIdx);
  const findRanges = state.findQuery ? findRangesForLine(lineIdx) : [];
  const found = findRanges.length > 0;
  const highlightedLine = highlightLine(displayLine, state.openPath);
  const highlighted = sliceAnsiPlainRange(highlightedLine, slice.start, slice.start + segment.length);

  if (selected || found) {
    return fit(leading + renderMarkedHighlighted(highlighted, segment, lineIdx, slice.start, findRanges), width);
  }

  return fit(leading + highlighted, width);
}

function sliceAnsiPlainRange(highlighted, startChar, endChar) {
  let out = '';
  let plainOffset = 0;
  let i = 0;

  while (i < highlighted.length) {
    if (highlighted[i] === '\x1b') {
      const m = highlighted.substring(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        if (plainOffset <= startChar || plainOffset < endChar) out += m[0];
        i += m[0].length;
        continue;
      }
    }

    const cp = highlighted.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const nextOffset = plainOffset + ch.length;
    if (plainOffset >= startChar && plainOffset < endChar) out += ch;
    plainOffset = nextOffset;
    i += ch.length;
  }

  return out + resetInlineStyle();
}

function selectionTouchesLine(lineIdx) {
  const r = getSelectionRange();
  if (!r) return false;
  return lineIdx >= r.startRow && lineIdx <= r.endRow;
}

function findRangesForLine(lineIdx) {
  const query = state.findQuery || '';
  if (!query) return [];
  const raw = state.editLines[lineIdx] || '';
  const line = state.findCaseSensitive ? raw : raw.toLowerCase();
  const needle = state.findCaseSensitive ? query : query.toLowerCase();
  const ranges = [];
  let idx = 0;
  while ((idx = line.indexOf(needle, idx)) >= 0) {
    ranges.push({ start: idx, end: idx + query.length });
    idx += Math.max(1, query.length);
  }
  return ranges;
}

function isFindMatch(col, ranges) {
  return ranges.some(r => col >= r.start && col < r.end);
}

function renderMarkedHighlighted(highlighted, segment, lineIdx, startChar, findRanges) {
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
    const found = !selected && isFindMatch(absolute, findRanges || []);
    if (selected) out += ansi.inverse + ch + ansi.noInverse;
    else if (found) out += ansi.underline + ch + ansi.noUnderline;
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
  if (hasSelection()) parts.push(selectionSummary());
  if (state.undoStack.length || state.redoStack.length) parts.push('U ' + state.undoStack.length + ' R ' + state.redoStack.length);
  if (state.findQuery) parts.push('Find ' + countFindMatches(state.findQuery));
  if (state.readonly) parts.push('readonly');
  if (state.binary) parts.push('binary');
  if (state.fileSizeBytes) parts.push(formatSize(state.fileSizeBytes));
  const lang = getLanguage(state.openPath);
  if (lang) parts.push(lang);
  return parts.filter(Boolean).join('  ');
}

function selectionSummary() {
  const r = getSelectionRange();
  if (!r) return '';
  if (r.startRow === r.endRow) return 'Sel ' + Math.max(0, r.endCol - r.startCol);
  return 'Sel ' + (r.endRow - r.startRow + 1) + ' lines';
}

function renderExplorerStatusInfo() {
  const entry = state.treeEntries[state.treeCursor];
  if (!state.root) return 'No folder selected';
  if (!entry) return baseName(state.root) || 'Folder';

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
  if (useSixelScrollbars()) return ' ';
  if (maxScroll <= 0 || viewportRows <= 0) return ' ';
  const totalRows = viewportRows + maxScroll;
  const handleH = Math.max(1, Math.floor((viewportRows * viewportRows) / totalRows));
  const handleY = Math.floor((viewportRows - handleH) * scrollOffset / maxScroll);
  if (row >= handleY && row < handleY + handleH) {
    return colors.title + '\u2588' + ansi.reset;
  }
  return colors.border + '\u2502' + ansi.reset;
}

function renderScrollbarOverlays() {
  if (!useSixelScrollbars()) return;
  const layout = state.layout;
  const bodyH = layout.bodyH;

  function drawV(scrollOffset, maxScroll, viewportRows, screenRow, screenCol, active) {
    if (maxScroll <= 0 || viewportRows <= 0 || screenCol <= 0) return;
    const pix = renderScrollbarPixels(state.cellW, state.cellH, viewportRows, scrollOffset, maxScroll);
    if (!pix) return;
    const palette = active ? SCROLLBAR_ACTIVE_PALETTE : SCROLLBAR_PALETTE;
    process.stdout.write(ansi.moveTo(screenRow, screenCol) +
      encodeSixel(pix, state.cellW, viewportRows * state.cellH, palette));
  }

  if (!state.treeCollapsed) {
    drawV(
      state.treeScroll,
      Math.max(0, state.treeEntries.length - bodyH),
      bodyH,
      layout.bodyTop,
      layout.treeScrollCol,
      state.dragging === 'tree-scrollbar'
    );
  }

  if (!state.editorCollapsed && state.openPath) {
    const editorMaxY = Math.max(0, state.editLines.length - bodyH);
    const contentW = getEditorContentWidth(layout.editorW);
    const maxScrollX = getMaxEditorScrollX(contentW);
    const hTrackCols = getEditorHScrollbarTrackCols(layout.editorW, editorMaxY > 0);

    drawV(
      state.scrollY,
      editorMaxY,
      bodyH,
      layout.bodyTop,
      layout.editorScrollCol,
      state.dragging === 'editor-scrollbar'
    );

    if (maxScrollX > 0 && hTrackCols > 0) {
      const pix = renderHScrollbarPixels(
        state.cellW,
        state.cellH,
        hTrackCols,
        contentW,
        state.scrollX,
        maxScrollX
      );
      if (pix) {
        const active = state.dragging === 'editor-hscrollbar';
        const palette = active ? SCROLLBAR_ACTIVE_PALETTE : SCROLLBAR_PALETTE;
        process.stdout.write(ansi.moveTo(layout.bottomSepRow, layout.editorCol) +
          encodeSixel(pix, hTrackCols * state.cellW, state.cellH, palette));
      }
    }
  }
}

function getEditorHScrollbarTrackCols(editorW, hasVScroll) {
  return Math.max(1, editorW - (hasVScroll ? 1 : 0));
}

module.exports = { render };
