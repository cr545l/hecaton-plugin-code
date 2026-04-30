function stripAnsi(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code <= 0x1F || code === 0x7F) return 0;
  if (
    (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0x303E) ||
    (code >= 0x3040 && code <= 0x33BF) ||
    (code >= 0x3400 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7FF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE30 && code <= 0xFE6F) ||
    (code >= 0xFF01 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x1F000 && code <= 0x1FFFF) ||
    (code >= 0x20000 && code <= 0x3FFFF)
  ) return 2;
  return 1;
}

function stringWidth(str) {
  let w = 0;
  for (const ch of String(str || '')) w += charWidth(ch);
  return w;
}

function padRight(text, width) {
  const pad = Math.max(0, width - stringWidth(stripAnsi(text)));
  return text + ' '.repeat(pad);
}

function truncateToWidth(str, maxW) {
  str = String(str || '');
  if (maxW <= 0) return '';
  let w = 0;
  let i = 0;
  for (const ch of str) {
    const cw = charWidth(ch);
    if (w + cw > maxW) break;
    w += cw;
    i += ch.length;
  }
  return str.substring(0, i);
}

function truncateAnsi(text, maxW) {
  text = String(text || '');
  if (maxW <= 0) return '';
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < maxW) {
    if (text[i] === '\x1b') {
      const m = text.substring(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(ch);
    if (visible + cw > maxW) break;
    visible += cw;
    i += ch.length;
  }
  return text.substring(0, i);
}

function screenColToCharIdx(line, screenCol) {
  line = String(line || '');
  let w = 0;
  let i = 0;
  for (const ch of line) {
    if (w >= screenCol) break;
    const cw = charWidth(ch);
    if (w + cw > screenCol) break;
    w += cw;
    i += ch.length;
  }
  return i;
}

function visibleSlice(line, scrollX, width) {
  line = String(line || '');
  const start = screenColToCharIdx(line, scrollX);
  const skipped = stringWidth(line.substring(0, start));
  const leftPad = Math.max(0, skipped - scrollX);
  const textWidth = Math.max(0, width - leftPad);
  const text = truncateToWidth(line.substring(start), textWidth);
  return { start, text, leftPad };
}

function sanitizeDisplayText(str) {
  return String(str || '').replace(/\t/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

function wordLeft(line, col) {
  let i = Math.max(0, Math.min(col, line.length));
  while (i > 0 && /\s/.test(line[i - 1])) i--;
  while (i > 0 && /[\w$]/.test(line[i - 1])) i--;
  return i;
}

function wordRight(line, col) {
  let i = Math.max(0, Math.min(col, line.length));
  while (i < line.length && /[\w$]/.test(line[i])) i++;
  while (i < line.length && /\s/.test(line[i])) i++;
  return i;
}

function wordBoundsAt(line, pos) {
  if (!line) return { start: 0, end: 0 };
  pos = Math.max(0, Math.min(pos, line.length - 1));
  const isWord = /[\w$]/.test(line[pos]);
  let start = pos;
  let end = pos;
  while (start > 0 && /[\w$]/.test(line[start - 1]) === isWord) start--;
  while (end < line.length && /[\w$]/.test(line[end]) === isWord) end++;
  return { start, end };
}

module.exports = {
  stripAnsi,
  charWidth,
  stringWidth,
  padRight,
  truncateToWidth,
  truncateAnsi,
  screenColToCharIdx,
  visibleSlice,
  sanitizeDisplayText,
  wordLeft,
  wordRight,
  wordBoundsAt,
};
