const { state } = require('./state');
const { charWidth, stringWidth } = require('./text');

// Visual layout cache; invalidated via state.docVersion which editor.js bumps
// on every content change.
const cache = { key: '', segments: [], lineStarts: [] };

function wrapContentWidth() {
  return Math.max(1, (state.layout.editorW || 1) - (state.layout.gutterW || 4) - 3);
}

function wrapLine(line, width) {
  if (!line) return [{ start: 0, end: 0 }];
  const segs = [];
  let start = 0;
  while (start < line.length) {
    let w = 0;
    let i = start;
    let lastSpace = -1;
    while (i < line.length) {
      const cp = line.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const cw = charWidth(ch);
      if (w + cw > width) break;
      w += cw;
      i += ch.length;
      if (ch === ' ' || ch === '\t') lastSpace = i;
    }
    if (i >= line.length) {
      segs.push({ start, end: line.length });
      break;
    }
    let end = lastSpace > start ? lastSpace : i;
    if (end <= start) end = start + String.fromCodePoint(line.codePointAt(start)).length;
    segs.push({ start, end });
    start = end;
  }
  return segs;
}

function getVisualLayout() {
  const width = wrapContentWidth();
  const key = width + ':' + state.docVersion + ':' + state.editLines.length + ':' + state.openPath;
  if (cache.key === key) return cache;
  const segments = [];
  const lineStarts = new Array(state.editLines.length);
  for (let row = 0; row < state.editLines.length; row++) {
    lineStarts[row] = segments.length;
    for (const seg of wrapLine(state.editLines[row] || '', width)) {
      segments.push({ row, startCol: seg.start, endCol: seg.end });
    }
  }
  cache.key = key;
  cache.segments = segments;
  cache.lineStarts = lineStarts;
  return cache;
}

function visualRowCount() {
  return getVisualLayout().segments.length;
}

// Widest line display width, cached by docVersion: scanning every line per
// render is far too slow for host-driven scrolling on large files.
const widthCache = { key: '', width: 0 };

function maxLineDisplayWidth() {
  const key = state.docVersion + ':' + state.openPath;
  if (widthCache.key === key) return widthCache.width;
  let w = 0;
  for (const line of state.editLines) {
    if (line.length * 2 <= w) continue; // upper bound (charWidth <= 2) can't beat current max
    w = Math.max(w, stringWidth(line));
  }
  widthCache.key = key;
  widthCache.width = w;
  return w;
}

function posToVisualRow(row, col) {
  const layout = getVisualLayout();
  row = Math.max(0, Math.min(row, state.editLines.length - 1));
  const segments = layout.segments;
  let v = layout.lineStarts[row];
  while (v + 1 < segments.length && segments[v + 1].row === row && col >= segments[v + 1].startCol) v++;
  return v;
}

function segmentAt(vrow) {
  const layout = getVisualLayout();
  if (!layout.segments.length) return { row: 0, startCol: 0, endCol: 0 };
  return layout.segments[Math.max(0, Math.min(vrow, layout.segments.length - 1))];
}

module.exports = {
  wrapLine,
  wrapContentWidth,
  getVisualLayout,
  visualRowCount,
  posToVisualRow,
  segmentAt,
  maxLineDisplayWidth,
};
