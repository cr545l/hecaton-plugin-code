const { ansi } = require('./ansi');

let upstream = null;
try {
  upstream = require('../hecaton-plugin-git-client/highlighter');
} catch {
  upstream = null;
}

function escapeFallback(line) {
  return String(line || '')
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, ansi.fg.yellow + '$1' + ansi.fg.default)
    .replace(/\b(const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|try|catch|throw|new|switch|case|break|continue)\b/g, ansi.fg.brightBlue + '$1' + ansi.fg.default)
    .replace(/\b(true|false|null|undefined|this)\b/g, ansi.fg.green + '$1' + ansi.fg.default)
    .replace(/(\/\/.*)$/g, ansi.fg.dim + '$1' + ansi.fg.default);
}

function getLanguage(filePath) {
  if (upstream && typeof upstream.getLanguage === 'function') {
    return upstream.getLanguage(filePath);
  }
  return null;
}

function highlightLine(line, filePath) {
  if (!line) return '';
  if (upstream && typeof upstream.highlightLine === 'function' && typeof upstream.getLanguage === 'function') {
    const lang = upstream.getLanguage(filePath);
    if (lang) return upstream.highlightLine(line, lang) + ansi.reset;
  }
  return escapeFallback(line) + ansi.reset;
}

module.exports = { highlightLine, getLanguage };
