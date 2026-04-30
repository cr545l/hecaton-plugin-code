const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  inverse: CSI + '7m',
  underline: CSI + '4m',
  moveTo: (row, col) => `${CSI}${row};${col}H`,
  fg: {
    default: CSI + '39m',
    dim: CSI + '90m',
    red: CSI + '31m',
    green: CSI + '32m',
    yellow: CSI + '33m',
    blue: CSI + '34m',
    magenta: CSI + '35m',
    cyan: CSI + '36m',
    white: CSI + '37m',
    brightBlue: CSI + '94m',
    brightCyan: CSI + '96m',
  },
  bg: {
    default: CSI + '49m',
    active: CSI + '48;2;42;45;52m',
    selected: CSI + '48;2;35;68;112m',
    dirty: CSI + '48;2;74;56;25m',
  },
};

const colors = {
  title: ansi.fg.brightBlue,
  border: ansi.dim,
  dim: ansi.dim,
  treeDir: ansi.fg.brightCyan,
  treeFile: ansi.fg.default,
  active: ansi.bg.active,
  selected: ansi.bg.selected,
  dirty: ansi.fg.yellow,
  saved: ansi.fg.green,
  error: ansi.fg.red,
  status: ansi.fg.dim,
  lineNo: ansi.fg.dim,
};

module.exports = { ESC, CSI, ansi, colors };
