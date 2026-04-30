const { ansi, CSI } = require('./ansi');

function baseName(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return s.substring(s.lastIndexOf('/') + 1);
}

function extName(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.substring(i);
}

function tryRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}

const hljs =
  tryRequire('./highlight/highlight.min.js') ||
  tryRequire('../hecaton-plugin-git-client/highlight/highlight.min.js');

const upstream = hljs ? null : tryRequire('../hecaton-plugin-git-client/highlighter');
const styleReset = CSI + '22;23;24;39m';

const theme = {
  keyword: ansi.bold + ansi.fg.brightBlue,
  built_in: ansi.fg.brightCyan,
  type: ansi.fg.brightYellow,
  literal: ansi.fg.brightGreen,
  number: ansi.fg.brightGreen,
  string: ansi.fg.yellow,
  comment: ansi.dim,
  function: ansi.fg.green,
  variable: ansi.fg.brightMagenta,
  operator: ansi.fg.brightRed,
  punctuation: ansi.fg.dim,
  class_: ansi.bold + ansi.fg.brightCyan,
  decorator: ansi.fg.brightYellow,
  property: ansi.fg.cyan,
  regexp: ansi.fg.magenta,
  tag: ansi.fg.brightBlue,
  attr: ansi.fg.cyan,
  section: ansi.bold + ansi.fg.brightMagenta,
  selector: ansi.fg.brightYellow,
  addition: ansi.fg.green,
  deletion: ansi.fg.red,
  strong: ansi.bold + ansi.fg.brightWhite,
  emphasis: ansi.italic + ansi.fg.white,
  link: ansi.underline + ansi.fg.cyan,
  default: '',
};

const langCache = new Map();
const highlightCache = new Map();
const MAX_CACHE_SIZE = 1200;

const languageAliases = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cfg: 'ini',
  cmake: 'cmake',
  conf: 'ini',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cxx: 'cpp',
  diff: 'diff',
  dockerfile: 'dockerfile',
  go: 'go',
  h: 'cpp',
  hpp: 'cpp',
  htm: 'xml',
  html: 'xml',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  mk: 'makefile',
  patch: 'diff',
  php: 'php',
  ps1: 'powershell',
  py: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  scala: 'scala',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  svelte: 'svelte',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

const filenameLanguages = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
};

function getLanguage(filePath) {
  if (!filePath) return null;
  if (langCache.has(filePath)) return langCache.get(filePath);

  if (!hljs && upstream && typeof upstream.getLanguage === 'function') {
    const lang = upstream.getLanguage(filePath);
    langCache.set(filePath, lang || null);
    return lang || null;
  }

  if (!hljs || typeof hljs.getLanguage !== 'function') return null;

  const name = baseName(filePath).toLowerCase();
  const ext = extName(filePath).toLowerCase().slice(1);
  const candidates = [
    filenameLanguages[name],
    languageAliases[ext],
    ext,
  ].filter(Boolean);

  for (const lang of candidates) {
    if (hljs.getLanguage(lang)) {
      langCache.set(filePath, lang);
      return lang;
    }
  }

  langCache.set(filePath, null);
  return null;
}

function getAnsiForClass(className) {
  if (!className) return theme.default;
  const cls = className.toLowerCase();

  if (cls.includes('comment') || cls.includes('quote')) return theme.comment;
  if (cls.includes('keyword')) return theme.keyword;
  if (cls.includes('built_in') || cls.includes('builtin')) return theme.built_in;
  if (cls.includes('type')) return theme.type;
  if (cls.includes('literal')) return theme.literal;
  if (cls.includes('number')) return theme.number;
  if (cls.includes('regexp')) return theme.regexp;
  if (cls.includes('string')) return theme.string;
  if (cls.includes('addition')) return theme.addition;
  if (cls.includes('deletion')) return theme.deletion;
  if (cls.includes('strong')) return theme.strong;
  if (cls.includes('emphasis')) return theme.emphasis;
  if (cls.includes('link')) return theme.link;
  if (cls.includes('selector')) return theme.selector;
  if (cls.includes('title') && (cls.includes('class') || cls.includes('class_'))) return theme.class_;
  if (cls.includes('title') || cls.includes('function')) return theme.function;
  if (cls.includes('variable') || cls.includes('params') || cls.includes('subst')) return theme.variable;
  if (cls.includes('operator')) return theme.operator;
  if (cls.includes('punctuation')) return theme.punctuation;
  if (cls.includes('class')) return theme.class_;
  if (cls.includes('decorator') || cls.includes('meta')) return theme.decorator;
  if (cls.includes('property') || cls.includes('attr')) return theme.property;
  if (cls.includes('tag') || cls.includes('name')) return theme.tag;
  if (cls.includes('section') || cls.includes('symbol') || cls.includes('bullet')) return theme.section;

  return theme.default;
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function restoreStyle(stack) {
  const parent = stack[stack.length - 1];
  return styleReset + (parent || '');
}

function formatToAnsi(value) {
  if (!value) return '';

  let output = '';
  const stack = [];
  const tagRegex = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let match;

  while ((match = tagRegex.exec(value)) !== null) {
    if (match[1] !== undefined) {
      const color = getAnsiForClass(match[1]);
      stack.push(color);
      if (color) output += color;
    } else if (match[0] === '</span>') {
      stack.pop();
      output += restoreStyle(stack);
    } else {
      output += decodeHtmlEntities(match[2]);
    }
  }

  return output + styleReset;
}

function escapeFallback(line) {
  return String(line || '')
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, theme.string + '$1' + styleReset)
    .replace(/\b(const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|try|catch|throw|new|switch|case|break|continue)\b/g, theme.keyword + '$1' + styleReset)
    .replace(/\b(true|false|null|undefined|this)\b/g, theme.literal + '$1' + styleReset)
    .replace(/(\/\/.*)$/g, theme.comment + '$1' + styleReset);
}

function remember(cacheKey, highlighted) {
  if (highlightCache.size >= MAX_CACHE_SIZE) {
    const firstKey = highlightCache.keys().next().value;
    highlightCache.delete(firstKey);
  }
  highlightCache.set(cacheKey, highlighted);
  return highlighted;
}

function highlightLine(line, filePathOrLang) {
  if (!line) return '';

  const lang = hljs && filePathOrLang && hljs.getLanguage(filePathOrLang)
    ? filePathOrLang
    : getLanguage(filePathOrLang);

  if (!hljs) {
    if (upstream && typeof upstream.highlightLine === 'function' && lang) {
      return upstream.highlightLine(line, lang) + styleReset;
    }
    return escapeFallback(line) + styleReset;
  }

  if (!lang) return escapeFallback(line) + styleReset;

  const cacheKey = lang + ':' + line;
  if (highlightCache.has(cacheKey)) return highlightCache.get(cacheKey);

  try {
    const result = hljs.highlight(line, { language: lang, ignoreIllegals: true });
    return remember(cacheKey, formatToAnsi(result.value));
  } catch {
    return remember(cacheKey, escapeFallback(line) + styleReset);
  }
}

function clearCache() {
  highlightCache.clear();
}

module.exports = { highlightLine, getLanguage, clearCache, theme };
