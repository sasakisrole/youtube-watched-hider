// Commit B: pure helpers + DOM-level manual credit review UI verification.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'enrich_credits.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'history.html'), 'utf8');
const CT = require(path.join(ROOT, 'credit_target.js'));

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

function load(records = [], rpc, options = {}) {
  const dom = buildDoc(); const counters = {
    messages: 0, fetches: 0, clipboard: [], reloads: 0, rpc: [],
    runtime: [], confirms: [], opens: 0, tabs: 0,
  };
  const navigatorStub = { clipboard: { writeText: async (text) => counters.clipboard.push(text) } };
  const chromeStub = { runtime: { getURL: () => '', getManifest: () => ({ version: 'test' }), lastError: null,
    sendMessage: (message, cb) => {
      counters.messages++; counters.runtime.push(message);
      cb(options.runtime ? options.runtime(message, counters.runtime.length) : { success: false });
    } },
  tabs: {
    create: () => { counters.tabs++; throw new Error('chrome.tabs.create must not be called'); },
    update: () => { counters.tabs++; throw new Error('chrome.tabs.update must not be called'); },
  } };
  const fetchStub = async () => { counters.fetches++; return { ok: false }; };
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

async function main() {
  await testPure(); await testRowsValidation(); await testResults(); await testCopy(); await testAutoCommitGuards();
  await testActions(); await testA11y();
  console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
