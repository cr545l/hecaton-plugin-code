const state = {
  termCols: 80,
  termRows: 24,
  cellW: 8,
  cellH: 16,
  minimized: false,
  loading: true,

  root: '',
  showHidden: false,
  expandedDirs: new Set(),
  treeEntries: [],
  treeCursor: 0,
  treeScroll: 0,
  focus: 'tree',
  treeCollapsed: false,
  editorCollapsed: false,
  dividerRatio: 0.32,

  openPath: '',
  openName: '',
  originalContent: '',
  lineEnding: '\n',
  editLines: [''],
  cursorRow: 0,
  cursorCol: 0,
  desiredCol: null,
  scrollY: 0,
  scrollX: 0,
  dirty: false,
  readonly: false,
  binary: false,
  fileMtimeMs: 0,
  fileSizeBytes: 0,
  lastSavedAt: 0,

  selAnchorRow: -1,
  selAnchorCol: -1,
  selections: [
    { anchorRow: 0, anchorCol: 0, row: 0, col: 0 },
  ],
  mouseDown: false,
  dragging: null,
  panDragStart: null,
  scrollFreed: false,
  cursorBlinkOn: true,
  cursorShape: '',
  lastClickTime: 0,
  lastClickPane: '',
  lastClickIndex: -1,
  lastClickRow: -1,
  lastClickCol: -1,
  clickCount: 0,
  dragMode: 0,
  dragOriginStartRow: -1,
  dragOriginStartCol: -1,
  dragOriginEndRow: -1,
  dragOriginEndCol: -1,

  undoStack: [],
  redoStack: [],
  maxUndo: 200,
  lastUndoType: '',
  lastUndoTime: 0,

  findQuery: '',
  findCaseSensitive: false,

  pendingDialog: null,
  pendingOpenPath: '',
  pendingFolder: '',
  status: '',
  statusKind: 'info',
  statusUntil: 0,
  hoverStatus: '',
  hoveredAction: '',

  layout: {
    activityW: 8,
    contentCol: 9,
    treeCol: 9,
    treeW: 23,
    editorW: 48,
    bodyTop: 3,
    bodyH: 20,
    sepRow: 2,
    bottomSepRow: 23,
    statusRow: 24,
    dividerCol: 32,
    dividerVisible: true,
    editorCol: 33,
    treeScrollCol: 31,
    editorScrollCol: 80,
    gutterW: 4,
    editorHScrollRow: 0,
    titleZones: [],
    titleDividerOffsets: [],
    activityZones: [],
  },
};

async function init() {
  state.minimized = hecaton.initialState?.minimized ?? false;
  const cols = await hecaton.env.get({ name: 'HECA_COLS' }).catch(() => null);
  const rows = await hecaton.env.get({ name: 'HECA_ROWS' }).catch(() => null);
  state.termCols = parseInt((cols && cols.value) || '80', 10);
  state.termRows = parseInt((rows && rows.value) || '24', 10);
}

function setStatus(message, kind, timeoutMs) {
  state.status = String(message || '');
  state.statusKind = kind || 'info';
  state.statusUntil = timeoutMs ? Date.now() + timeoutMs : 0;
}

function clearExpiredStatus() {
  if (state.statusUntil && Date.now() > state.statusUntil) {
    state.status = '';
    state.statusKind = 'info';
    state.statusUntil = 0;
  }
}

module.exports = { state, init, setStatus, clearExpiredStatus };
