// Commit B: pure helpers + DOM-level manual credit review UI verification.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'enrich_credits.js'), 'utf8');
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'history.html'), 'utf8');
const CT = require(path.join(ROOT, 'credit_target.js'));
const ENRICH_RATE_LIMIT_MS = Number(BACKGROUND_SOURCE.match(/const ENRICH_RATE_LIMIT_MS = (\d+);/)[1]);

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

class ClassList {
  constructor(el) { this.el = el; }
  set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  put(s) { this.el.className = [...s].join(' '); }
  add(...xs) { const s = this.set(); xs.forEach((x) => s.add(x)); this.put(s); }
  remove(...xs) { const s = this.set(); xs.forEach((x) => s.delete(x)); this.put(s); }
  contains(x) { return this.set().has(x); }
  toggle(x, force) { const s = this.set(); const on = force === undefined ? !s.has(x) : !!force; on ? s.add(x) : s.delete(x); this.put(s); return on; }
}

class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attributes = {}; this.dataset = {}; this.className = ''; this.classList = new ClassList(this); this.style = {};
    this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.tabIndex = 0; this._text = '';
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') { [...child.children].forEach((c) => this.appendChild(c)); return child; }
    child.parentNode = this; this.children.push(child); return child;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async trigger(type, extra = {}) {
    if (type === 'click' && this.disabled) return;
    const event = { type, target: this, currentTarget: this, key: '', preventDefault() {}, ...extra };
    for (const fn of this.listeners[type] || []) await fn(event);
  }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) { return selector === '[data-enrich-sort]' ? [] : descendants(this).filter((e) => matches(e, selector)); }
}

class Doc {
  constructor() { this.ids = new Map(); this.listeners = {}; this.body = new El('body', this); this.activeElement = this.body; }
  createElement(tag) { return new El(tag, this); }
  createElementNS(_ns, tag) { return new El(tag, this); }
  createDocumentFragment() { return new El('#fragment', this); }
  getElementById(id) { return this.ids.get(id) || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  register(id, tag, parent) { const e = this.createElement(tag || 'div'); e.id = id; e.attributes.id = id; this.ids.set(id, e); (parent || this.body).appendChild(e); return e; }
}

function descendants(root) { return (root.children || []).flatMap((c) => [c, ...descendants(c)]); }
function matches(e, selector) {
  if (selector.startsWith('.')) return e.classList.contains(selector.slice(1));
  if (/^[a-z]+$/i.test(selector)) return e.tagName === selector.toUpperCase();
  const m = selector.match(/^\[data-([a-z0-9-]+)(?:="([^"]+)")?\]$/i);
  if (!m) return false;
  const key = m[1].replace(/-([a-z])/g, (_x, c) => c.toUpperCase());
  return Object.prototype.hasOwnProperty.call(e.dataset, key) && (m[2] === undefined || e.dataset[key] === m[2]);
}
function find(root, fn) { return [root, ...descendants(root)].find(fn) || null; }
function findAll(root, fn) { return [root, ...descendants(root)].filter(fn); }
function action(root, name) { return find(root, (e) => e.dataset && e.dataset.manualAction === name); }
function formFor(root, role, mode) { return find(root, (e) => e.dataset && e.dataset.role === role && e.dataset.formMode === mode); }

function buildDoc() {
  const doc = new Doc(); const modal = doc.register('enrichModal');
  doc.register('enrichSubtitle', 'p', modal); const autoTab = doc.register('enrichAutoViewTab', 'button', modal);
  const manualTab = doc.register('enrichManualViewTab', 'button', modal); doc.register('enrichAutoView', 'div', modal);
  const manualView = doc.register('enrichManualView', 'section', modal); doc.register('enrichManualSearch', 'input', manualView);
  doc.register('enrichManualCount', 'span', manualView); doc.register('enrichManualStatus', 'p', manualView);
  const list = doc.register('enrichManualList', 'div', manualView); doc.register('enrichManualEmpty', 'div', manualView);
  autoTab.className = 'enrich-view-tab active'; manualTab.className = 'enrich-view-tab'; manualView.hidden = true; modal.hidden = true;
  return { doc, modal, manualView, list };
}

function base(videoId, extra = {}) {
  return { videoId, title: `Title ${videoId}`, channel: 'Artist - Topic', creditsRaw: 'hint',
    composer: '', lyricist: '', arranger: '', creditsSource: 'general', ...extra };
}

function preCountRecords() {
  return [
    base('pre-1', { channel: 'Shared Artist - Topic' }),
    base('pre-2', { channel: 'Shared Artist - Topic', composer: 'Known Composer' }),
    base('pre-3', { channel: 'Other Artist', lyricist: 'Known Lyricist' }),
    base('pre-complete', { channel: 'Excluded Artist', composer: 'A', lyricist: 'B', arranger: 'C' }),
    base('pre-no-raw', { channel: 'Excluded Artist', creditsRaw: '' }),
  ];
}
function load(records = [], rpc, options = {}) {
  const dom = buildDoc(); const counters = {
    messages: 0, fetches: 0, clipboard: [], reloads: 0, rpc: [],
    runtime: [], confirms: [], opens: 0, tabs: 0,
  };
  const navigatorStub = { clipboard: { writeText: async (text) => counters.clipboard.push(text) } };
  const chromeStub = { runtime: { getURL: () => '', getManifest: () => ({ version: 'test' }), lastError: null,
    sendMessage: (message, cb) => {
      counters.messages++; counters.runtime.push(message);
      cb(message.type === 'getEnrichCreditsConfig'
        ? { success: true, rateLimitMs: ENRICH_RATE_LIMIT_MS }
        : options.runtime ? options.runtime(message, counters.runtime.length) : { success: false });
    } },
  tabs: {
    create: () => { counters.tabs++; throw new Error('chrome.tabs.create must not be called'); },
    update: () => { counters.tabs++; throw new Error('chrome.tabs.update must not be called'); },
  } };
  const fetchStub = async (...args) => {
    counters.fetches++;
    return options.fetch ? options.fetch(...args) : { ok: false };
  };
  const win = { CreditTarget: CT,
    open: () => { counters.opens++; throw new Error('window.open must not be called'); } };
  const confirmStub = (message) => {
    counters.confirms.push(message);
    return options.confirm ? options.confirm(message) : true;
  };
  new Function('window', 'document', 'chrome', 'navigator', 'fetch', 'confirm', SOURCE)(
    win, dom.doc, chromeStub, navigatorStub, fetchStub, confirmStub,
  );
  const controller = win.EnrichCredits.create({ getRecords: () => records, reloadData: async () => { counters.reloads++; },
    sendDbRpc: async (message) => { counters.rpc.push(message); return rpc ? rpc(message, counters.rpc.length) : { success: false }; } });
  controller.switchView('manual');
  return { ...dom, win, controller, counters };
}

async function testPure() {
  console.log('pure helpers'); const H = load().win.EnrichCreditsTestHooks;
  const rec = { title: 'Unique Song', channel: 'Unique Artist - Topic' };
  for (const [role, label] of Object.entries({ composer: '作曲者', lyricist: '作詞者', arranger: '編曲者' })) {
    const q = H.buildManualSearchQuery(rec, role);
    check(`query ${role}: Topic stripped`, q === `Unique Song Unique Artist ${label}`);
    check(`query ${role}: each token once`, ['Unique Song', 'Unique Artist', label].every((t) => q.split(t).length - 1 === 1));
  }
  check('query empty channel', H.buildManualSearchQuery({ title: 'Solo', channel: '' }, 'composer') === 'Solo 作曲者');
  check('fixed role/source maps', Object.isFrozen(H.CREDIT_ROLE_LABELS) && Object.isFrozen(H.CREDIT_SOURCE_LABELS)
    && H.CREDIT_SOURCE_LABELS.manual === '手動入力');
  const preCount = H.getEnrichmentPreCount(preCountRecords());
  check('pre-count uses enrichment gate and distinct target channels', preCount.videoCount === 3 && preCount.channelCount === 2);
  const expectedMinutes = H.estimateEnrichmentMinutes(preCount.videoCount, ENRICH_RATE_LIMIT_MS);
  const confirmText = H.buildEnrichmentConfirmText(preCount, ENRICH_RATE_LIMIT_MS);
  check('pre-count confirmation text includes both computed counts', confirmText.includes('3動画 / 2チャンネル'));
  check('pre-count confirmation includes request-range estimate and maximum request count',
    confirmText.includes(`処理予定 3件、推定所要時間 約${expectedMinutes.minMinutes}〜${expectedMinutes.maxMinutes}分`
      + `（最大 約${preCount.videoCount * H.ENRICH_REQUESTS_PER_VIDEO_MAX} 回の通信）`));
  const rows = [base('partial', { composer: 'Known', creditsRaw: '' }), base('raw'), base('empty', { creditsRaw: '' }),
    base('complete', { composer: 'A', lyricist: 'B', arranger: 'C' }), base('lookup', { title: 'Needle', channel: 'Special' })];
  check('rows include context+missing only', H.getManualReviewRows(rows).map((r) => r.videoId).join(',') === 'partial,raw,lookup');
  check('rows search title', H.getManualReviewRows(rows, 'needle')[0].videoId === 'lookup');
  check('rows search channel', H.getManualReviewRows(rows, 'special')[0].videoId === 'lookup');
  check('rows search videoId', H.getManualReviewRows(rows, 'lookup')[0].videoId === 'lookup');
  for (const v of ['', 'https://example.com/a', 'example.com/a', '@handle', 'Copyright Control', '作曲: Alice', 'A'.repeat(61), 'Reboot"'])
    check(`validation rejects ${JSON.stringify(v).slice(0, 25)}`, H.validateManualCreditInput(v).valid === false);
  check('validation accepts clean name', H.validateManualCreditInput('Alice Example').valid === true);
}

async function testRowsValidation() {
  console.log('DOM rows / validation'); const ui = load([base('partial-dom', { composer: 'Known', creditsRaw: '' }),
    base('complete-dom', { composer: 'A', lyricist: 'B', arranger: 'C' })]);
  const cards = findAll(ui.list, (e) => e.classList.contains('manual-video-card'));
  check('DOM excludes complete record', cards.length === 1 && cards[0].dataset.videoId === 'partial-dom');
  const forms = findAll(cards[0], (e) => e.dataset && e.dataset.formMode === 'missing');
  check('DOM has missing roles only', forms.map((f) => f.dataset.role).join(',') === 'lyricist,arranger');
  const form = formFor(cards[0], 'lyricist', 'missing'); const input = find(form, (e) => e.dataset.manualRoleInput === 'lyricist');
  const save = action(form, 'save');
  for (const v of ['', 'https://example.com/a', 'example.com/a', '@handle', 'Copyright Control', '作詞: Alice', 'A'.repeat(61), 'Reboot"']) {
    input.value = v; await input.trigger('input'); await save.trigger('click');
  }
  check('invalid UI inputs issue zero RPC', ui.counters.rpc.length === 0);
  check('inline validation includes reason+hint', find(form, (e) => e.classList.contains('manual-validation')).textContent.length > 10);
}

async function enterAndSave(ui, role, value) {
  const form = formFor(ui.list, role, 'missing'); const input = find(form, (e) => e.dataset.manualRoleInput === role);
  input.value = value; await input.trigger('input'); await action(form, 'save').trigger('click');
}

async function testResults() {
  console.log('save / conflict / error');
  const saved = base('save', { lyricist: 'Known' });
  const ok = load([saved], (_message, callNo) => callNo === 1
    ? { success: true, result: { updated: true,
      previous: { value: '', source: 'general', sourcePresent: false }, post: { value: 'Alice', source: 'manual' } } }
    : { success: true, result: { updated: true,
      previous: { value: 'Alice', source: 'manual', sourcePresent: true }, post: { value: '', source: 'general' } } });
  await enterAndSave(ok, 'composer', 'Alice');
  check('updated=true updates row and reloads', saved.composer === 'Alice' && saved.creditRoleSources.composer === 'manual' && ok.counters.reloads === 1);
  check('success shows undo', !!action(ok.list, 'undo') && ok.list.textContent.includes('保存しました。'));
  check('save DB_RPC carries expected snapshot', ok.counters.rpc[0].type === 'DB_RPC' && ok.counters.rpc[0].op === 'SET_MANUAL_CREDIT_ROLE'
    && ok.counters.rpc[0].expectedCurrent === '' && ok.counters.rpc[0].expectedSource === 'general');
  const conflicted = base('conflict', { lyricist: 'Known' });
  const conflict = load([conflicted], () => ({ success: true, result: { conflict: true, current: { value: 'Fresh Auto', source: 'topic' } } }));
  await enterAndSave(conflict, 'composer', 'Stale Value');
  await action(ok.list, 'undo').trigger('click');
  check('undo new input sends null restore target and post expected state', ok.counters.rpc[1].value === ''
    && ok.counters.rpc[1].expectedCurrent === 'Alice' && ok.counters.rpc[1].expectedSource === 'manual'
    && ok.counters.rpc[1].restoreRoleSource === null);
  check('save and undo issue no fetch or network runtime message', ok.counters.fetches === 0 && ok.counters.messages === 0);
  check('conflict is non-success and asks retry', !conflict.list.textContent.includes('保存しました。')
    && conflict.list.textContent.includes('再試行') && conflicted.composer === 'Fresh Auto'
    && CT.effectiveRoleSource(conflicted, 'composer') === 'topic');
  const rejected = base('error', { lyricist: 'Known' });
  const errorUi = load([rejected], () => ({ success: true, result: { error: 'not_manual' } }));
  await enterAndSave(errorUi, 'composer', 'Rejected Value');
  check('result.error is non-success and surfaced', !errorUi.list.textContent.includes('保存しました。') && errorUi.list.textContent.includes('変更できません'));
  check('code inspects updated/conflict/error', SOURCE.includes('result.updated === true') && SOURCE.includes('result.conflict === true')
    && SOURCE.includes('errorLabels[result.error]'));
}

async function testCopy() {
  console.log('copy'); const r = base('copy', { title: 'Copy Song', channel: 'Copy Artist - Topic', composer: 'Known' });
  const ui = load([r]); await action(formFor(ui.list, 'lyricist', 'missing'), 'copy').trigger('click');
  check('clipboard receives exact query', ui.counters.clipboard[0] === 'Copy Song Copy Artist 作詞者');
  check('copy has zero fetch/message/tab side effects', ui.counters.fetches === 0 && ui.counters.messages === 0 && ui.counters.rpc.length === 0);
  check('copy never opens a window or chrome tab', ui.counters.opens === 0 && ui.counters.tabs === 0);
}

async function testGenerationPreCount() {
  console.log('generation pre-count');
  const records = preCountRecords();
  const cancelled = load(records);
  cancelled.controller.switchView('auto');
  const originalCandidates = cancelled.controller.candidatesByChannel;
  originalCandidates.set('kept-state', []);
  cancelled.controller.activeChannel = 'kept-state';
  cancelled.controller.renderedRows = 4;
  cancelled.controller.errors = ['kept-error'];

  const cancelPromise = cancelled.controller.generateCandidates();
  await Promise.resolve();
  const panel = find(cancelled.controller.autoView, (e) => e.classList.contains('enrich-precount-confirm'));
  const cancelButton = find(panel, (e) => e.dataset.enrichPrecountAction === 'cancel');
  const startButton = find(panel, (e) => e.dataset.enrichPrecountAction === 'start');
  check('pre-count prompt shows counts with accessible start and cancel controls', !!panel
    && panel.getAttribute('role') === 'alertdialog' && panel.textContent.includes('3動画 / 2チャンネル')
    && startButton.tagName === 'BUTTON' && startButton.textContent === '開始' && startButton.style.minHeight === '44px'
    && cancelButton.tagName === 'BUTTON' && cancelButton.textContent === 'キャンセル' && cancelButton.style.minHeight === '44px');
  await cancelButton.trigger('click');
  await cancelPromise;
  check('pre-count cancel has zero fetch, MusicBrainz, or DB-write side effects', cancelled.counters.fetches === 0
    && cancelled.counters.runtime.filter((message) => message.type === 'enrichCreditsMb').length === 0
    && cancelled.counters.runtime.filter((message) => message.op === 'UPDATE_CREDITS').length === 0
    && cancelled.counters.rpc.length === 0);
  check('pre-count cancel restores unchanged candidate-generation state', cancelled.controller.candidatesByChannel === originalCandidates
    && originalCandidates.has('kept-state') && cancelled.controller.activeChannel === 'kept-state'
    && cancelled.controller.renderedRows === 4 && cancelled.controller.errors.join(',') === 'kept-error'
    && cancelled.controller.generating === false && cancelled.controller.confirmingGeneration === false
    && !find(cancelled.controller.autoView, (e) => e.classList.contains('enrich-precount-confirm')));

  const started = load(records, undefined, {
    fetch: async () => ({ ok: true, json: async () => ({ rules: [] }) }),
    runtime: (message) => message.type === 'enrichCreditsMb'
      ? { success: true, candidate: null }
      : { success: false },
  });
  started.controller.switchView('auto');
  const startPromise = started.controller.generateCandidates();
  await Promise.resolve();
  const startPanel = find(started.controller.autoView, (e) => e.classList.contains('enrich-precount-confirm'));
  await find(startPanel, (e) => e.dataset.enrichPrecountAction === 'start').trigger('click');
  await startPromise;
  const mbMessages = started.counters.runtime.filter((message) => message.type === 'enrichCreditsMb');
  check('full-count selection preserves existing all-target generation flow', started.counters.fetches === 1
    && mbMessages.length === 3 && started.controller.generating === false);

  const limited = load(records, undefined, {
    fetch: async () => ({ ok: true, json: async () => ({ rules: [] }) }),
    runtime: (message) => message.type === 'enrichCreditsMb'
      ? { success: true, candidate: null }
      : { success: false },
  });
  limited.controller.switchView('auto');
  const limitedPromise = limited.controller.generateCandidates();
  await Promise.resolve();
  const limitedPanel = find(limited.controller.autoView, (e) => e.classList.contains('enrich-precount-confirm'));
  const limitMode = find(limitedPanel, (e) => e.dataset.enrichPrecountLimitMode === 'true');
  const limitInput = find(limitedPanel, (e) => e.dataset.enrichPrecountLimit === 'true');
  limitMode.value = 'limited';
  await limitMode.trigger('change');
  limitInput.value = '2';
  await limitInput.trigger('input');
  const limitedMinutes = limited.win.EnrichCreditsTestHooks.estimateEnrichmentMinutes(2, ENRICH_RATE_LIMIT_MS);
  check('limited selection updates request-range estimate from selected count',
    limitedPanel.textContent.includes(`処理予定 2件、推定所要時間 約${limitedMinutes.minMinutes}〜${limitedMinutes.maxMinutes}分`
      + '（最大 約12 回の通信）'));
  await find(limitedPanel, (e) => e.dataset.enrichPrecountAction === 'start').trigger('click');
  await limitedPromise;
  const limitedMbMessages = limited.counters.runtime.filter((message) => message.type === 'enrichCreditsMb');
  check('upper limit N stops candidate generation loop at N videos',
    limitedMbMessages.length === 2 && limited.controller.generating === false);

  const manual = load(records, undefined, {
    fetch: async () => { throw new Error('manual view must not fetch'); },
    runtime: () => { throw new Error('manual view must not message MusicBrainz'); },
  });
  manual.controller.open();
  manual.controller.switchView('manual');
  check('opening manual-confirm view never starts MusicBrainz', manual.counters.fetches === 0
    && manual.counters.runtime.filter((message) => message.type === 'enrichCreditsMb').length === 0);
}
async function testAutoCommitGuards() {
  console.log('auto commit guards');
  const candidate = (videoId) => ({
    videoId, title: `Title ${videoId}`, channel: 'Artist - Topic',
    composer: 'Auto Composer', lyricist: '', arranger: '', source: 'rule', selected: true,
  });
  const runtimeFor = (videoId) => (message) => {
    if (message.type === 'EXPORT_DATA') {
      return { schemaVersion: 2, watchedVideos: [base(videoId)] };
    }
    if (message.type === 'DB_RPC' && message.op === 'UPDATE_CREDITS') {
      return { success: true, result: true };
    }
    return { success: false };
  };

  const denied = load([], undefined, { confirm: () => false, runtime: runtimeFor('auto-denied') });
  denied.controller.candidatesByChannel.set('Artist - Topic', [candidate('auto-denied')]);
  await denied.controller.commitSelected();
  check('auto commit requires confirmation before any write', denied.counters.confirms.length === 1
    && denied.counters.runtime.length === 0);

  const allowed = load([], undefined, { confirm: () => true, runtime: runtimeFor('auto-allowed') });
  allowed.controller.candidatesByChannel.set('Artist - Topic', [candidate('auto-allowed')]);
  await allowed.controller.commitSelected();
  const update = allowed.counters.runtime.find((message) => message.type === 'DB_RPC' && message.op === 'UPDATE_CREDITS');
  check('auto commit UPDATE_CREDITS explicitly sends force false', !!update && update.force === false);
}
async function testActions() {
  console.log('edit / cancel / undo'); const r = base('actions', { composer: 'Old Name', lyricist: 'Auto Name', arranger: '',
    creditRoleSources: { composer: 'manual', lyricist: 'topic' } });
  const rpc = (_m, n) => ({ success: true, result: n === 1
    ? { updated: true, previous: { value: 'Old Name', source: 'manual', sourcePresent: true }, post: { value: 'New Name', source: 'manual' } }
    : n === 2 ? { updated: true, previous: { value: 'New Name', source: 'manual', sourcePresent: true }, post: { value: 'Old Name', source: 'manual' } }
      : n === 3 ? { updated: true, previous: { value: 'Old Name', source: 'manual', sourcePresent: true }, post: { value: '', source: 'general' } }
        : { updated: true, previous: { value: '', source: 'general', sourcePresent: false }, post: { value: 'Old Name', source: 'manual' } } });
  const ui = load([r], rpc);
  const section = (role) => find(ui.list, (e) => e.classList.contains('manual-current-role') && e.dataset.role === role);
  await action(section('composer'), 'edit').trigger('click');
  let form = formFor(ui.list, 'composer', 'edit'); let input = find(form, (e) => e.dataset.manualRoleInput === 'composer');
  input.value = 'New Name'; await input.trigger('input'); await action(form, 'save-edit').trigger('click');
  check('edit expected args, no restore', ui.counters.rpc[0].expectedCurrent === 'Old Name' && ui.counters.rpc[0].expectedSource === 'manual'
    && !Object.prototype.hasOwnProperty.call(ui.counters.rpc[0], 'restoreRoleSource'));
  await action(section('composer'), 'undo').trigger('click');
  check('undo edit restores previous source', ui.counters.rpc[1].value === 'Old Name' && ui.counters.rpc[1].expectedCurrent === 'New Name'
    && ui.counters.rpc[1].expectedSource === 'manual' && ui.counters.rpc[1].restoreRoleSource === 'manual');
  await action(section('composer'), 'cancel').trigger('click');
  check('cancel expects current manual and sends blank', ui.counters.rpc[2].value === '' && ui.counters.rpc[2].expectedCurrent === 'Old Name'
    && ui.counters.rpc[2].expectedSource === 'manual' && !Object.prototype.hasOwnProperty.call(ui.counters.rpc[2], 'restoreRoleSource'));
  await action(section('composer'), 'undo').trigger('click');
  check('undo cancel expects cancel post and restores manual', ui.counters.rpc[3].value === 'Old Name' && ui.counters.rpc[3].expectedCurrent === ''
    && ui.counters.rpc[3].expectedSource === 'general' && ui.counters.rpc[3].restoreRoleSource === 'manual');
  check('auto role has no manual controls', !action(section('lyricist'), 'edit') && !action(section('lyricist'), 'cancel') && !action(section('lyricist'), 'undo'));
}

async function testA11y() {
  console.log('a11y'); const ui = load([base('a11y', { composer: 'Known' })]);
  const controls = findAll(ui.manualView, (e) => e.tagName === 'BUTTON' || e.tagName === 'INPUT');
  check('native reachable buttons/inputs', controls.length >= 5 && controls.every((e) => ['BUTTON', 'INPUT'].includes(e.tagName) && e.tabIndex >= 0));
  const inputs = findAll(ui.manualView, (e) => e.tagName === 'INPUT' && e.dataset.manualRoleInput);
  const labels = findAll(ui.manualView, (e) => e.tagName === 'LABEL');
  check('inputs are labelled and described', inputs.every((i) => labels.some((l) => l.getAttribute('for') === i.id) && i.getAttribute('aria-describedby')));
  check('action buttons have aria-label', findAll(ui.manualView, (e) => e.tagName === 'BUTTON').every((b) => b.getAttribute('aria-label')));
  const markup = HTML.slice(HTML.indexOf('id="enrichAutoViewTab"'), HTML.indexOf('<div class="content" id="content">'));
  check('markup uses tabs/native input/inline SVG and no emoji', markup.includes('role="tab"') && markup.includes('<input')
    && markup.includes('<svg') && !/[\u{1F300}-\u{1FAFF}]/u.test(markup));
  const addedEmoji = /[\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3\u{1F300}-\u{1FAFF}]/u;
  check('actual modal markup excludes BMP symbols, variation/keycaps, and supplementary emoji', !addedEmoji.test(markup));
  const manualTabTag = HTML.match(/<([a-z][\w-]*)\b[^>]*\bid=["']enrichManualViewTab["'][^>]*>/i);
  check('real markup manual-review tab is a button with tab role', !!manualTabTag
    && manualTabTag[1].toLowerCase() === 'button' && /\brole=["']tab["']/i.test(manualTabTag[0]));
  const manualSearchInput = HTML.match(/<input\b[^>]*\bid=["']enrichManualSearch["'][^>]*>/i);
  const manualSearchLabel = HTML.match(/<label\b[^>]*\bfor=["']enrichManualSearch["'][^>]*>/i);
  check('real markup manual search input has matching label for association', !!manualSearchInput && !!manualSearchLabel);
  check('44px/focus/zoom/dark styles present', HTML.includes('min-height:44px') && HTML.includes(':focus-visible')
    && HTML.includes('@media (max-width:900px)') && HTML.includes('@media (prefers-color-scheme: dark)'));
}

// 実データ(13,475件)を一度に描くと JS 2.0秒 + レイアウト 10.5秒 ブラウザが固まったので、
// 自動候補タブと同じ分割描画を入れた。ここはその上限が効き続けることを見張る。
async function testManualPaging() {
  console.log('manual paging');
  const many = Array.from({ length: 130 }, (_, i) => base('page-' + String(i).padStart(3, '0')));
  const ui = load(many);
  const cards = () => findAll(ui.list, (e) => e.className === 'manual-video-card');
  const label = () => ui.doc.getElementById('enrichManualCount').textContent;

  check('manual view renders a first chunk instead of every row', cards().length === 50);
  check('count label keeps the real total and says how many are shown',
    label() === '対象 130件 / 不足 390役割（50件を表示中）');
  check('remaining rows are reachable by scrolling', !!ui.list.listeners.scroll);

  ui.controller.renderMoreManualRows();
  check('the next chunk is appended', cards().length === 100);
  ui.controller.renderMoreManualRows();
  check('paging stops at the total and drops the "shown" suffix',
    cards().length === 130 && label() === '対象 130件 / 不足 390役割');

  const search = ui.doc.getElementById('enrichManualSearch');
  search.value = 'page-';
  await search.trigger('input');
  check('changing the search starts from the first chunk again', cards().length === 50);

  // 保存すると pin される。pin は行の末尾へ回るので、上限で切ると
  // 「直した動画が消えた」に見える。上限より後ろでも必ず描くこと。
  const pinned = load(many);
  pinned.controller.manualPinnedVideoIds.add('page-120');
  pinned.controller.renderManualView();
  const ids = findAll(pinned.list, (e) => e.className === 'manual-video-card').map((e) => e.dataset.videoId);
  check('a row you already saved is never cut off by the cap',
    ids.length === 51 && ids.includes('page-120'));
}

async function main() {
  await testPure(); await testRowsValidation(); await testResults(); await testCopy(); await testGenerationPreCount();
  await testAutoCommitGuards();
  await testActions(); await testA11y(); await testManualPaging();
  console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
