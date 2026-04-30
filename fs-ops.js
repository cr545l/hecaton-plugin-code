const { state, setStatus } = require('./state');

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function trimTrailingSlash(p) {
  p = normalizePath(p);
  if (/^[A-Za-z]:\/$/.test(p)) return p;
  if (p === '/') return p;
  return p.replace(/\/+$/, '');
}

function joinPath(dir, name) {
  dir = trimTrailingSlash(dir);
  if (!dir) return normalizePath(name);
  if (dir.endsWith('/')) return dir + name;
  return dir + '/' + name;
}

function baseName(p) {
  const s = trimTrailingSlash(p);
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.substring(i + 1);
}

function dirName(p) {
  const s = trimTrailingSlash(p);
  if (/^[A-Za-z]:\/?$/.test(s)) return s.endsWith('/') ? s : s + '/';
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  if (/^[A-Za-z]:$/.test(s.substring(0, i))) return s.substring(0, i + 1);
  return s.substring(0, i);
}

function isAbsolutePath(p) {
  p = normalizePath(p);
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

function resolvePath(input, base) {
  let p = normalizePath(input).trim();
  if (!p) return trimTrailingSlash(base || state.root || '');
  if (!isAbsolutePath(p)) p = joinPath(base || state.root || '', p);
  const drive = p.match(/^([A-Za-z]:)(\/|$)/);
  const prefix = drive ? drive[1] : (p.startsWith('/') ? '/' : '');
  const rest = drive ? p.substring(drive[0].length) : (p.startsWith('/') ? p.substring(1) : p);
  const parts = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  if (drive) return prefix + '/' + parts.join('/');
  return prefix + parts.join('/');
}

async function rpc(method, params) {
  try {
    const parts = method.split('.');
    let target = hecaton;
    let parent = hecaton;
    for (const part of parts) {
      if (target == null) return null;
      parent = target;
      target = target[part];
    }
    if (typeof target !== 'function') return null;
    return await target.call(parent, params || {});
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function formatSize(bytes) {
  bytes = Number(bytes || 0);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

async function statPath(path) {
  const r = await rpc('fs.stat', { path });
  if (!r || r.error) return null;
  if (r.ok === false) return null;
  return r.exists ? r : null;
}

async function readDirectory(dirPath) {
  const result = await rpc('fs.read_dir', { path: dirPath });
  if (!result || result.error || result.ok === false) return [];
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const items = entries.map(entry => ({
    name: entry.name || baseName(entry.path || ''),
    path: normalizePath(entry.path || joinPath(dirPath, entry.name || '')),
    isDir: !!entry.is_dir,
    isSymlink: !!entry.is_symlink,
    size: entry.size_bytes || 0,
    mtime: entry.mtime_ms || 0,
    ctime: entry.birthtime_ms || entry.created_ms || entry.creation_time_ms || entry.ctime_ms || 0,
  }));
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return items;
}

async function buildTree(rootPath, expandedDirs, showHidden) {
  const root = trimTrailingSlash(rootPath);
  const out = [];

  async function walk(dir, depth) {
    const items = await readDirectory(dir);
    for (const item of items) {
      if (!showHidden && item.name.startsWith('.')) continue;
      const expanded = item.isDir && !item.isSymlink && expandedDirs.has(trimTrailingSlash(item.path));
      out.push({
        ...item,
        path: trimTrailingSlash(item.path),
        depth,
        expanded,
      });
      if (expanded) await walk(item.path, depth + 1);
    }
  }

  await walk(root, 0);
  return out;
}

async function refreshTree(preservePath) {
  if (!state.root) return;
  const selected = preservePath || (state.treeEntries[state.treeCursor] && state.treeEntries[state.treeCursor].path);
  const entries = await buildTree(state.root, state.expandedDirs, state.showHidden);
  state.treeEntries = entries;
  let nextCursor = selected ? entries.findIndex(e => e.path === selected) : state.treeCursor;
  if (nextCursor < 0) nextCursor = Math.min(state.treeCursor, Math.max(0, entries.length - 1));
  state.treeCursor = Math.max(0, nextCursor);
}

async function readTextFile(filePath) {
  const st = await statPath(filePath);
  if (!st) return { ok: false, error: 'File not found' };
  if (st.is_dir) return { ok: false, error: 'Path is a folder' };
  const size = st.size_bytes || 0;
  if (size > 8 * 1024 * 1024) {
    return { ok: false, error: 'File too large to edit: ' + formatSize(size), size, mtime: st.mtime_ms || 0 };
  }

  const result = await rpc('fs.read_file', { path: filePath, encoding: 'utf8' });
  if (!result || result.ok === false) return { ok: false, error: (result && result.error) || 'Cannot read file' };
  if (result.is_binary || result.error === 'Binary file') return { ok: false, binary: true, error: 'Binary file', size, mtime: st.mtime_ms || 0 };

  const content = typeof result === 'string'
    ? result
    : (typeof result.content === 'string' ? result.content : '');
  if (content.indexOf('\x00') >= 0) return { ok: false, binary: true, error: 'Binary file', size, mtime: st.mtime_ms || 0 };
  return { ok: true, content, size, mtime: st.mtime_ms || 0 };
}

async function writeTextFile(filePath, content) {
  const result = await rpc('fs.write_file', { path: filePath, content });
  if (!result || result.ok === false || result.error) {
    return { ok: false, error: (result && result.error) || 'Cannot write file' };
  }
  const st = await statPath(filePath);
  return { ok: true, mtime: st && st.mtime_ms || Date.now(), size: st && st.size_bytes || content.length };
}

async function createFile(filePath) {
  const exists = await statPath(filePath);
  if (exists) return { ok: false, error: 'Path already exists' };
  return writeTextFile(filePath, '');
}

async function createFolder(dirPath) {
  const exists = await statPath(dirPath);
  if (exists) return { ok: false, error: 'Path already exists' };
  const result = await rpc('fs.mkdir', { path: dirPath, recursive: true });
  if (!result || result.ok === false || result.error) {
    return { ok: false, error: (result && result.error) || 'Cannot create folder' };
  }
  return { ok: true };
}

async function pickFolder() {
  const picked = await rpc('picker.folder', { default_path: state.root }).catch(() => null);
  if (picked && picked.path) return normalizePath(picked.path);
  return '';
}

function setRoot(rootPath) {
  state.root = trimTrailingSlash(rootPath);
  state.expandedDirs = new Set();
  state.treeEntries = [];
  state.treeCursor = 0;
  state.treeScroll = 0;
  setStatus('Folder changed', 'info', 1600);
}

module.exports = {
  normalizePath,
  trimTrailingSlash,
  joinPath,
  baseName,
  dirName,
  isAbsolutePath,
  resolvePath,
  formatSize,
  formatTime,
  statPath,
  readDirectory,
  buildTree,
  refreshTree,
  readTextFile,
  writeTextFile,
  createFile,
  createFolder,
  pickFolder,
  setRoot,
};
