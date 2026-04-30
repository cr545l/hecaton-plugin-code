const CURSOR_PALETTE = [[220, 225, 235]];

function renderCursorPixels(cW, cH) {
  const buf = new Uint8Array(cW * cH);
  const thickness = 2;
  for (let y = 0; y < cH; y++) {
    for (let x = 0; x < thickness && x < cW; x++) {
      buf[y * cW + x] = 1;
    }
  }
  return buf;
}

function encodeClearSixel(w, h) {
  let out = '\x1bP0;2;0q';
  out += '"1;1;' + w + ';' + h;
  const bands = Math.ceil(h / 6);
  for (let i = 0; i < bands; i++) {
    if (w >= 4) out += '!' + w + '?';
    else out += '?'.repeat(w);
    if (i < bands - 1) out += '-';
  }
  out += '\x1b\\';
  return out;
}

function encodeSixel(buf, w, h, palette) {
  let out = '\x1bP0;1;0q';
  out += '"1;1;' + w + ';' + h;
  for (let i = 0; i < palette.length; i++) {
    const [r, g, b] = palette[i];
    out += '#' + (i + 1) + ';2;' + Math.round(r * 100 / 255) +
      ';' + Math.round(g * 100 / 255) + ';' + Math.round(b * 100 / 255);
  }
  for (let bandY = 0; bandY < h; bandY += 6) {
    const bandH = Math.min(6, h - bandY);
    let bandHasData = false;
    for (let ci = 1; ci <= palette.length; ci++) {
      let row = '';
      let runChar = '';
      let runLen = 0;
      for (let x = 0; x < w; x++) {
        let bits = 0;
        for (let dy = 0; dy < bandH; dy++) {
          if (buf[(bandY + dy) * w + x] === ci) bits |= (1 << dy);
        }
        const ch = String.fromCharCode(63 + bits);
        if (ch === runChar) {
          runLen++;
        } else {
          if (runLen > 0) {
            if (runLen >= 4) row += '!' + runLen + runChar;
            else row += runChar.repeat(runLen);
          }
          runChar = ch;
          runLen = 1;
        }
      }
      if (runLen > 0) {
        if (runLen >= 4) row += '!' + runLen + runChar;
        else row += runChar.repeat(runLen);
      }
      if (row.replace(/[!0-9]/g, '').replace(/\?/g, '') === '') continue;
      bandHasData = true;
      out += '#' + ci + row + '$';
    }
    if (bandHasData && out.endsWith('$')) out = out.slice(0, -1);
    out += '-';
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  out += '\x1b\\';
  return out;
}

module.exports = {
  CURSOR_PALETTE,
  renderCursorPixels,
  encodeSixel,
  encodeClearSixel,
};
