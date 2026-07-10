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
const { getSelectionRanges, hasSelection, countFindMatches, canUndo, canRedo, findBracketMatch } = require('./editor');
const { getVisualLayout, visualRowCount, posToVisualRow, segmentAt, maxLineDisplayWidth } = require('./wrap');
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
const hostScroll = require('./scroll');

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

const ACTIVITY_BAR_W = 0;
const BOX = {
  H: '\u2500',
  V: '\u2502',
  CROSS: '\u253c',
  T_DOWN: '\u252c',
  T_UP: '\u2534',
  T_RIGHT: '\u251c',
};
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
  const layout = computePanelLayout(contentCols);
  const treeW = layout.treeW;
  const editorW = layout.editorW;
  const gutterW = Math.max(3, String(state.editLines.length).length) + 1;
  const editorContentW = Math.max(1, editorW - gutterW - 3);
  const hasEditorHScroll = layout.hasEditor && state.openPath && !state.wordWrap && getMaxEditorScrollX(editorContentW) > 0;
  const bodyH = Math.max(1, bottomSepRow - bodyTop - (hasEditorHScroll ? 1 : 0));
  const editorHScrollRow = hasEditorHScroll ? bodyTop + bodyH : 0;
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
    gutterW,
    editorHScrollRow,
    titleZones: [],
    titleDividerOffsets: [],
    activityZones: [],
  };

  if (layout.hasTree) keepTreeCursorVisible(bodyH);
  if (layout.hasEditor) keepEditorCursorVisible(editorW, bodyH);

  const out = [];
  out.push(ansi.clear + ansi.hideCursor);
  out.push(ansi.moveTo(1, 1) + ansi.reset + renderActivityRail(1) + renderTitle(contentCols));
  out.push(ansi.moveTo(sepRow, 1) + ansi.reset + renderActivityRail(sepRow, BOX.T_RIGHT) + renderSeparator(layout));

  const treeLines = layout.hasTree ? renderTreeLines(treeW, bodyH) : [];
  const editorLines = layout.hasEditor ? renderEditorLines(editorW, bodyH) : [];
  for (let i = 0; i < bodyH; i++) {
    let line = ansi.moveTo(bodyTop + i, 1) + ansi.reset;
    line += renderActivityRail(bodyTop + i);
    line += ansi.reset;
    if (layout.hasTree) line += treeLines[i];
    line += ansi.reset;
    if (layout.dividerVisible) line += colors.border + '\u2502' + ansi.reset;
    if (layout.hasEditor) line += editorLines[i];
    line += ansi.reset;
    out.push(line);
  }

  if (hasEditorHScroll) {
    out.push(ansi.moveTo(editorHScrollRow, 1) + ansi.reset + renderActivityRail(editorHScrollRow) + ansi.reset + renderEditorHScrollbarRow(layout) + ansi.reset);
  }
  out.push(ansi.moveTo(bottomSepRow, 1) + ansi.reset + renderActivityRail(bottomSepRow, BOX.T_RIGHT) + renderBottomSeparator(layout));
  out.push(ansi.moveTo(statusRow, 1) + ansi.reset + renderActivityRail(statusRow) + renderStatus(contentCols));

  // Host-owned scroll: emit overscan banks (off-screen buffer rows the host
  // reveals during sub-cell scrolling) and in-band render acks in the same
  // stdout write as the frame so the host applies them atomically, then
  // collect the region definitions for the post-write RPC sync.
  let hostScrollDefs = null;
  if (hostScroll.isActive()) {
    hostScrollDefs = [];
    if (layout.hasTree && bodyH > 0) {
      const regionW = Math.max(1, treeW - 1);
      const off = state.treeScroll;
      const bankTop = hostScroll.bankRow('tree');
      // Bank rows live beyond the screen: write them only after the host has
      // confirmed the region (enlarged buffer); earlier writes would clamp
      // onto the bottom visible row.
      if (hostScroll.isReady('tree')) {
        const bank = [off - 1, off + bodyH, off + bodyH + 1];
        for (let i = 0; i < 3; i++) {
          out.push(ansi.reset + ansi.moveTo(bankTop + 1 + i, treeCol) + renderTreeRowAt(bank[i], regionW) + ansi.reset);
        }
        out.push(hostScroll.ackString('tree', off));
      }
      hostScrollDefs.push({
        id: 'tree',
        row: bodyTop - 1,
        col: treeCol - 1,
        width: regionW,
        height: bodyH,
        contentRows: state.treeEntries.length,
        contentCols: regionW, // horizontal stays plugin-owned
        overscanRow: bankTop,
        off,
      });
    }
    if (layout.hasEditor && state.openPath && bodyH > 0) {
      const regionW = Math.max(1, editorW - 1);
      const off = state.scrollY;
      const bankTop = hostScroll.bankRow('editor');
      if (hostScroll.isReady('editor')) {
        const bank = [off - 1, off + bodyH, off + bodyH + 1];
        for (let i = 0; i < 3; i++) {
          out.push(ansi.reset + ansi.moveTo(bankTop + 1 + i, editorCol) + renderEditorRowAt(bank[i], regionW) + ansi.reset);
        }
        out.push(hostScroll.ackString('editor', off));
      }
      hostScrollDefs.push({
        id: 'editor',
        row: bodyTop - 1,
        col: editorCol - 1,
        width: regionW,
        height: bodyH,
        contentRows: editorTotalRows(),
        contentCols: regionW, // horizontal stays plugin-owned (gutter fixed)
        overscanRow: bankTop,
        off,
      });
    }
  }

  process.stdout.write(out.join(''));
  renderScrollbarOverlays();
  renderEditorCursorOverlay();
  if (hostScrollDefs) hostScroll.syncRegions(hostScrollDefs);
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
  hostScroll.syncRegions([]); // minimized: drop regions so wheel reaches the terminal
  const cols = Math.max(20, state.termCols || 80);
  const title = ' ' + (state.openName || baseName(state.root) || '');
  const marker = state.dirty ? ' *' : '';
  process.stdout.write(ansi.clear + ansi.hideCursor + ansi.moveTo(1, 1) + fit(colors.title + title + marker + ansi.reset, cols));
}

function renderActivityRail(row, boundaryChar) {
  const width = state.layout.activityW || 0;
  if (width <= 0) return '';

  const labelW = Math.max(1, width - 1);
  let text = ' ';
  let active = false;
  let focused = false;
  let action = '';

  if (row === 1) {
    text = 'Files';
    active = !state.treeCollapsed;
    focused = state.focus === 'tree';
    action = 'toggle-tree';
  } else if (row === 2) {
    text = 'Editor';
    active = !state.editorCollapsed;
    focused = state.focus === 'editor';
    action = 'toggle-editor';
  }

  if (action) {
    state.layout.activityZones.push({
      row,
      colStart: 1,
      colEnd: labelW,
      action,
      enabled: true,
      label: actionDescription(action),
    });
  }

  let style = active ? colors.title : colors.dim;
  if (action && state.hoveredAction === action) style = colors.active + (active ? colors.title : colors.dim);
  if (focused && active) style = colors.active + colors.title;
  const cell = centerCell(text, labelW);
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
      const separatorPad = used > 0 ? 1 : 0;
      const separatorW = separatorPad + 1;
      if (used + separatorW > width) break;
      state.layout.titleDividerOffsets.push(used + separatorPad);
      if (separatorPad) line += ' ';
      line += colors.border + BOX.V + ansi.reset;
      used += separatorW;
      col += separatorW;
      continue;
    }

    const buttonW = toolbarButtonWidth(item);
    if (used + buttonW > width) break;
    zones.push({
      row: 1,
      colStart: col,
      colEnd: col + buttonW - 1,
      action: item.action,
      enabled: item.enabled,
      label: actionDescription(item.action),
    });
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
    { action: 'new_file', text: 'New', enabled: !!state.root },
    { action: 'open_folder', text: 'Open', enabled: true },
    { action: 'refresh', text: 'Ref', enabled: !!state.root },
    { type: 'separator' },
    { action: 'save', text: state.dirty ? 'Save*' : 'Save', enabled: writable && state.dirty, accent: state.dirty ? 'dirty' : '' },
    { action: 'close_file', text: 'Close', enabled: hasOpen },
    { type: 'separator' },
    { action: 'undo', text: 'Undo', enabled: canUndo() },
    { action: 'redo', text: 'Redo', enabled: canRedo() },
    { type: 'separator' },
    { action: 'cut', text: 'Cut', enabled: hasSel && !state.readonly },
    { action: 'copy', text: 'Copy', enabled: hasSel },
    { action: 'paste', text: 'Paste', enabled: writable },
    { type: 'separator' },
    { action: 'find', text: 'Find', enabled: hasOpen },
    { action: 'goto_line', text: 'Line', enabled: hasOpen },
    { action: 'toggle_comment', text: 'Cmt', enabled: writable },
  ];
}

function toolbarButtonWidth(item) {
  return stringWidth(item.text || '') + 2;
}

function renderToolbarButton(item, width) {
  let style = item.enabled
    ? (item.accent === 'dirty' ? colors.dirty : colors.title)
    : colors.dim;
  if (state.hoveredAction === item.action) {
    style = colors.active + style;
  }
  return style + fit(' ' + (item.text || '') + ' ', width) + ansi.reset;
}

function actionDescription(action) {
  const labels = {
    'toggle-tree': state.treeCollapsed ? 'Show Files' : 'Hide Files',
    'toggle-editor': state.editorCollapsed ? 'Show Editor' : 'Hide Editor',
    new_file: 'New File',
    open_folder: 'Open Folder',
    refresh: 'Refresh Files',
    save: 'Save File',
    close_file: 'Close File',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut Selection',
    copy: 'Copy Selection',
    paste: 'Paste',
    find: 'Find',
    goto_line: 'Go to Line',
    toggle_comment: 'Toggle Comment',
  };
  return labels[action] || String(action || '');
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
  const rightPct = scrollPct(state.scrollY, editorMaxVScroll(state.layout.bodyH));
  let line = colors.border;
  if (layout.hasTree) line += labelOnRule(layout.treeW, leftPct >= 0 ? leftPct + '%' : '');
  if (layout.dividerVisible) line += BOX.T_UP;
  if (layout.hasEditor) {
    line += labelOnRule(layout.editorW, rightPct >= 0 ? rightPct + '%' : '');
  }
  return line + ansi.reset;
}

function renderEditorHScrollbarRow(layout) {
  const contentW = getEditorContentWidth(layout.editorW);
  const maxScrollX = getMaxEditorScrollX(contentW);
  const editorMaxY = editorMaxVScroll(state.layout.bodyH);
  const trackCols = getEditorHScrollbarTrackCols(layout.editorW, editorMaxY > 0);
  let line = '';
  if (layout.hasTree) line += ' '.repeat(layout.treeW);
  if (layout.dividerVisible) line += colors.border + BOX.V + ansi.reset;
  if (layout.hasEditor) {
    if (maxScrollX > 0 && useSixelScrollbars()) {
      line += ' '.repeat(layout.editorW);
    } else if (maxScrollX > 0) {
      line += renderHorizontalScrollbar(trackCols, contentW, state.scrollX, maxScrollX);
      line += ' '.repeat(Math.max(0, layout.editorW - trackCols));
    } else {
      line += ' '.repeat(layout.editorW);
    }
  }
  return line;
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
  if (state.wordWrap) return 0;
  return Math.max(0, maxLineDisplayWidth() - contentW);
}

function editorTotalRows() {
  if (state.wordWrap && state.openPath) return visualRowCount();
  return state.editLines.length;
}

function editorMaxVScroll(height) {
  return Math.max(0, editorTotalRows() - height);
}

function useSixelScrollbars() {
  return state.cellW > 0 && state.cellH > 0;
}

function keepTreeCursorVisible(height) {
  const max = Math.max(0, state.treeEntries.length - 1);
  state.treeCursor = clamp(state.treeCursor, 0, max);
  // Skip cursor-follow while the host drives the position (trackpad momentum);
  // the pin clears as soon as the cursor itself moves.
  const pinned = state.treeScrollPin !== undefined && state.treeScrollPin === state.treeCursor;
  if (state.treeScrollPin !== undefined && state.treeScrollPin !== state.treeCursor) state.treeScrollPin = undefined;
  if (!pinned) {
    if (state.treeCursor < state.treeScroll) state.treeScroll = state.treeCursor;
    if (state.treeCursor >= state.treeScroll + height) state.treeScroll = state.treeCursor - height + 1;
  }
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
    lines.push(renderTreeRowAt(idx, contentW) + renderScrollbarCell(row, height, state.treeScroll, maxScroll));
  }
  return lines.slice(0, height);
}

function renderTreeRowAt(idx, contentW) {
  const entry = idx >= 0 ? state.treeEntries[idx] : null;
  if (!entry) return ' '.repeat(contentW);

  const selected = idx === state.treeCursor;
  const open = entry.path === state.openPath;
  const indent = '  '.repeat(Math.max(0, entry.depth));
  const marker = entry.isDir ? (entry.expanded ? '- ' : '+ ') : '  ';
  const nameColor = entry.isDir ? colors.treeDir : colors.treeFile;
  const inlineReset = resetInlineStyle();
  const openMark = open ? (selected ? '>' : colors.saved + '>' + inlineReset) : ' ';
  const displayName = entry.name + (open && state.dirty ? '*' : '');
  let line = openMark + indent + marker + (selected ? displayName : nameColor + displayName + inlineReset);
  if (!entry.isDir && contentW > 28) {
    const metaText = entry.size ? ' ' + formatSize(entry.size) : '';
    const meta = selected ? metaText : colors.dim + metaText + inlineReset;
    const free = contentW - stringWidth(displayName) - stringWidth(indent) - 5;
    if (free > 8) line += meta;
  }
  line = fit(line, contentW);
  if (selected) line = colors.selected + line + ansi.reset;
  return line;
}

function keepEditorCursorVisible(editorW, height) {
  const gutterW = Math.max(3, String(state.editLines.length).length) + 1;
  const contentW = Math.max(1, editorW - gutterW - 3);
  state.cursorRow = clamp(state.cursorRow, 0, Math.max(0, state.editLines.length - 1));
  const line = state.editLines[state.cursorRow] || '';
  state.cursorCol = clamp(state.cursorCol, 0, line.length);

  if (state.wordWrap && state.openPath) {
    const cursorV = posToVisualRow(state.cursorRow, state.cursorCol);
    if (!state.dragging && !state.scrollFreed) {
      if (cursorV < state.scrollY) state.scrollY = cursorV;
      if (cursorV >= state.scrollY + height) state.scrollY = cursorV - height + 1;
    }
    state.scrollY = clamp(state.scrollY, 0, editorMaxVScroll(height));
    state.scrollX = 0;
    return;
  }

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
  const panelW = Math.max(1, width - 1);
  if (!state.openPath) {
    const messages = [
      '',
      ' Select a file and press Enter.',
      '',
    ];
    for (let i = 0; i < height; i++) {
      lines.push(fit(colors.dim + (messages[i] || '') + ansi.reset, panelW) + ansi.reset + renderScrollbarCell(i, height, 0, 0));
    }
    return lines;
  }

  bracketMatch = findBracketMatch();
  const maxScroll = editorMaxVScroll(height);

  for (let row = 0; row < height; row++) {
    lines.push(renderEditorRowAt(state.scrollY + row, panelW) + ansi.reset +
      renderScrollbarCell(row, height, state.scrollY, maxScroll));
  }
  return lines;
}

function renderEditorRowAt(absIdx, panelW) {
  const gutterW = state.layout.gutterW;
  const contentW = Math.max(1, panelW - gutterW - 2);
  const blank = fit(colors.lineNo + ' '.repeat(gutterW) + ' \u2502' + ansi.reset, panelW);
  if (absIdx < 0) return blank;

  if (state.wordWrap) {
    const seg = getVisualLayout().segments[absIdx];
    if (!seg) return blank;
    const lineNo = seg.startCol === 0
      ? String(seg.row + 1).padStart(gutterW - 1, ' ') + ' '
      : ' '.repeat(gutterW);
    const gutter = colors.lineNo + lineNo + '\u2502' + ansi.reset + ' ';
    return fit(gutter + renderCodeSegment(seg.row, seg.startCol, seg.endCol, contentW), panelW);
  }

  if (absIdx >= state.editLines.length) return blank;
  const lineNo = String(absIdx + 1).padStart(gutterW - 1, ' ') + ' ';
  const gutter = colors.lineNo + lineNo + '\u2502' + ansi.reset + ' ';
  return fit(gutter + renderCodeContent(absIdx, contentW), panelW);
}

let bracketMatch = null;

function bracketColsForLine(lineIdx) {
  if (!bracketMatch) return [];
  const cols = [];
  for (const pos of bracketMatch) {
    if (pos.row === lineIdx) cols.push(pos.col);
  }
  return cols;
}

function renderCodeContent(lineIdx, width) {
  const raw = state.editLines[lineIdx] || '';
  const displayLine = sanitizeDisplayText(raw);
  const slice = visibleSlice(displayLine, state.scrollX, width);
  const segment = slice.text;
  const leading = ' '.repeat(slice.leftPad);
  const selected = selectionTouchesLine(lineIdx);
  const findRanges = state.findQuery ? findRangesForLine(lineIdx) : [];
  const brackets = bracketColsForLine(lineIdx);
  const highlightedLine = highlightLine(displayLine, state.openPath);
  const highlighted = sliceAnsiPlainRange(highlightedLine, slice.start, slice.start + segment.length);

  if (selected || findRanges.length || brackets.length) {
    return fit(leading + renderMarkedHighlighted(highlighted, segment, lineIdx, slice.start, findRanges, brackets) + resetInlineStyle(), width);
  }

  return fit(leading + highlighted, width);
}

function renderCodeSegment(lineIdx, startCol, endCol, width) {
  const raw = state.editLines[lineIdx] || '';
  const displayLine = sanitizeDisplayText(raw);
  const segment = displayLine.substring(startCol, endCol);
  const selected = selectionTouchesLine(lineIdx);
  const findRanges = state.findQuery ? findRangesForLine(lineIdx) : [];
  const brackets = bracketColsForLine(lineIdx);
  const highlightedLine = highlightLine(displayLine, state.openPath);
  const highlighted = sliceAnsiPlainRange(highlightedLine, startCol, endCol);

  if (selected || findRanges.length || brackets.length) {
    return fit(renderMarkedHighlighted(highlighted, segment, lineIdx, startCol, findRanges, brackets) + resetInlineStyle(), width);
  }

  return fit(highlighted, width);
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
  return getSelectionRanges().some(r => lineIdx >= r.startRow && lineIdx <= r.endRow);
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

function renderMarkedHighlighted(highlighted, segment, lineIdx, startChar, findRanges, brackets) {
  const selections = getSelectionRanges();
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
    const selected = selections.some(sel => isSelected(lineIdx, absolute, sel));
    const found = !selected && isFindMatch(absolute, findRanges || []);
    const bracket = !selected && !found && brackets && brackets.indexOf(absolute) >= 0;
    if (selected) out += ansi.inverse + ch + ansi.noInverse;
    else if (found) out += ansi.underline + ch + ansi.noUnderline;
    else if (bracket) out += ansi.bold + ansi.underline + ch + ansi.noUnderline + ansi.noBold;
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
  const selections = (state.selections && state.selections.length ? state.selections : [{
    row: state.cursorRow,
    col: state.cursorCol,
  }]);
  const pixels = state.cursorBlinkOn ? renderCursorPixels(state.cellW, state.cellH) : null;
  const sixel = pixels ? encodeSixel(pixels, state.cellW, state.cellH, CURSOR_PALETTE) : '';

  for (const sel of selections) {
    let row, col;
    if (state.wordWrap) {
      const v = posToVisualRow(sel.row, sel.col);
      const seg = segmentAt(v);
      row = layout.bodyTop + (v - state.scrollY);
      col = layout.editorCol + gutterW + 2 +
        stringWidth((state.editLines[sel.row] || '').substring(seg.startCol, sel.col));
    } else {
      const cursorDisplayCol = stringWidth((state.editLines[sel.row] || '').substring(0, sel.col));
      row = layout.bodyTop + (sel.row - state.scrollY);
      col = layout.editorCol + gutterW + 2 + (cursorDisplayCol - state.scrollX);
    }
    const visible = row >= layout.bodyTop &&
      row < layout.bodyTop + layout.bodyH &&
      col >= layout.editorCol + gutterW + 2 &&
      col < layout.editorCol + gutterW + 2 + contentW;

    if (!visible) continue;

    if (!state.cursorBlinkOn) {
      process.stdout.write(ansi.moveTo(row, col) + encodeClearSixel(state.cellW, state.cellH));
    } else {
      process.stdout.write(ansi.moveTo(row, col) + sixel);
    }
  }
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
  const hasStatus = !!state.status;
  const messageText = hasStatus ? state.status : state.hoverStatus;
  const messageColor = hasStatus
    ? (state.statusKind === 'error' ? colors.error : state.statusKind === 'success' ? colors.saved : colors.status)
    : colors.title;
  const message = messageText ? '  ' + messageColor + messageText + ansi.reset : '';
  return fit(colors.status + ' ' + info + ansi.reset + message, width);
}

function renderEditorStatusInfo() {
  const parts = [
    (state.dirty ? '* ' : '') + (state.openName || baseName(state.openPath)),
    'Ln ' + (state.cursorRow + 1) + '/' + state.editLines.length,
    'Col ' + (state.cursorCol + 1),
  ];
  if (state.selections && state.selections.length > 1) parts.push(state.selections.length + ' cursors');
  if (hasSelection()) parts.push(selectionSummary());
  if (state.undoStack.length || state.redoStack.length) parts.push('U ' + state.undoStack.length + ' R ' + state.redoStack.length);
  if (state.findQuery) parts.push('Find ' + countFindMatches(state.findQuery));
  if (state.wordWrap) parts.push('wrap');
  if (state.readonly) parts.push('readonly');
  if (state.binary) parts.push('binary');
  if (state.fileSizeBytes) parts.push(formatSize(state.fileSizeBytes));
  const lang = getLanguage(state.openPath);
  if (lang) parts.push(lang);
  return parts.filter(Boolean).join('  ');
}

function selectionSummary() {
  const ranges = getSelectionRanges();
  if (!ranges.length) return '';
  if (ranges.length > 1) return 'Sel ' + ranges.length + ' ranges';
  const r = ranges[0];
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
    const editorMaxY = editorMaxVScroll(bodyH);
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
        process.stdout.write(ansi.moveTo(layout.editorHScrollRow || layout.bottomSepRow, layout.editorCol) +
          encodeSixel(pix, hTrackCols * state.cellW, state.cellH, palette));
      }
    }
  }
}

function getEditorHScrollbarTrackCols(editorW, hasVScroll) {
  return Math.max(1, editorW - (hasVScroll ? 1 : 0));
}

module.exports = { render };
