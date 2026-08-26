// Synthetic verification for N4 Credit Review Center rejection and conflict resolution.
// Run: node tests/verify_n4_credit_review_reject.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'credit_review.js'), 'utf8');
const DB_SOURCE = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const OFFSCREEN_SOURCE = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
const CT = require(path.join(ROOT, 'credit_target.js'));

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

class ClassList {
  constructor(el) { this.el = el; }
  values() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  write(values) { this.el.className = [...values].join(' '); }
  add(...names) { const values = this.values(); names.forEach((name) => values.add(name)); this.write(values); }
  remove(...names) { const values = this.values(); names.forEach((name) => values.delete(name)); this.write(values); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    const values = this.values(); const active = force === undefined ? !values.has(name) : !!force;
    active ? values.add(name) : values.delete(name); this.write(values); return active;
  }
}

class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attributes = {}; this.dataset = {}; this.className = ''; this.classList = new ClassList(this);
    this.listeners = {}; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this._text = '';
  }
  set textContent(value) { this._text = String(value == null ? '' : value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent || '').join(''); }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') { [...child.children].forEach((item) => this.appendChild(item)); return child; }
    child.parentNode = this; this.children.push(child); return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async trigger(type, extra = {}) {
    const event = { type, target: this, currentTarget: this, key: '', preventDefault() {}, ...extra };
    for (const handler of this.listeners[type] || []) await handler(event);
  }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) { return descendants(this).filter((element) => matches(element, selector)); }
  closest(selector) {
    let current = this;
    while (current) { if (matches(current, selector)) return current; current = current.parentNode; }
    return null;
  }
}

class Doc {
  constructor() { this.ids = new Map(); this.listeners = {}; this.body = new El('body', this); this.activeElement = this.body; }
  createElement(tag) { return new El(tag, this); }
  createDocumentFragment() { return new El('#fragment', this); }
  getElementById(id) { return this.ids.get(id) || null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  register(id, tag = 'div', parent = this.body) {
    const element = this.createElement(tag); element.id = id; element.attributes.id = id;
    this.ids.set(id, element); parent.appendChild(element); return element;
  }
}

function descendants(root) { return (root.children || []).flatMap((child) => [child, ...descendants(child)]); }
function matches(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  const data = selector.match(/^\[data-([a-z0-9-]+)(?:="([^"]+)")?\]$/i);
  if (!data) return false;
  const key = data[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  return Object.prototype.hasOwnProperty.call(element.dataset, key)
    && (data[2] === undefined || element.dataset[key] === data[2]);
}
function findAll(root, predicate) { return [root, ...descendants(root)].filter(predicate); }

const STATES = ['all', 'conflict', 'needs_review', 'auto_candidate', 'unresolved', 'verified'];
function buildDoc() {
  const doc = new Doc();
  const opener = doc.register('creditReviewOpen', 'button');
  const modal = doc.register('creditReviewModal'); modal.hidden = true;
  doc.register('creditReviewClose', 'button', modal);
  const filters = doc.register('creditReviewFilters', 'div', modal);
  const filterButtons = {};
  STATES.forEach((state) => {
    const button = doc.createElement('button'); button.dataset.creditReviewState = state;
    const count = doc.createElement('span'); count.dataset.creditReviewCount = state; count.textContent = '0';
    button.appendChild(count); filters.appendChild(button); filterButtons[state] = button;
  });
  doc.register('creditReviewSummary', 'p', modal);
  const feedback = doc.register('creditReviewFeedback', 'div', modal); feedback.hidden = true;
  const list = doc.register('creditReviewList', 'div', modal);
  const empty = doc.register('creditReviewEmpty', 'div', modal); empty.hidden = true;
  return { doc, opener, modal, filters, filterButtons, feedback, list };
}

function roleSource(record, role) { return CT.effectiveRoleSource(record, role); }
function makeSave(records, options = {}) {
  const calls = [];
  const save = async (payload) => {
    calls.push({ ...payload });
    if (options.fail) return { error: 'disk_failure' };
    const record = records.find((item) => item.videoId === payload.videoId);
    if (!record) return { error: 'not_found' };
    const currentValue = record[payload.role];
    const currentSource = roleSource(record, payload.role);
    if ((currentValue || '') !== (payload.expectedCurrent || '') || currentSource !== (payload.expectedSource || '')) {
      return { conflict: true, current: { value: currentValue, source: currentSource } };
    }
    if (currentSource === 'manual' && (payload.adoptCandidate || payload.rejectCandidate
      || Object.prototype.hasOwnProperty.call(payload, 'restoreCandidateRejection'))) return { error: 'already_verified' };
    if (payload.rejectCandidate || Object.prototype.hasOwnProperty.call(payload, 'restoreCandidateRejection')) {
      const prior = record.creditReviewRejections || {};
      const rejectionPresent = Object.prototype.hasOwnProperty.call(prior, payload.role);
      const previous = { value: currentValue, source: currentSource,
        rejection: rejectionPresent ? prior[payload.role] : '', rejectionPresent };
      const next = { ...prior };
      if (payload.rejectCandidate) next[payload.role] = payload.rejectCandidate;
      else if (payload.restoreCandidateRejection) next[payload.role] = payload.restoreCandidateRejection;
      else delete next[payload.role];
      if (Object.keys(next).length) record.creditReviewRejections = next;
      else delete record.creditReviewRejections;
      return { updated: true, previous,
        post: { value: currentValue, source: currentSource, rejection: next[payload.role] || '' } };
    }
    if (payload.adoptCandidate && currentSource === 'manual') return { error: 'already_verified' };
    const sources = { ...(record.creditRoleSources || {}) };
    const sourcePresent = Object.prototype.hasOwnProperty.call(sources, payload.role);
    const previous = { value: currentValue, source: currentSource, sourcePresent };
    record[payload.role] = payload.value;
    sources[payload.role] = 'manual'; record.creditRoleSources = sources;
    return { updated: true, previous, post: { value: payload.value, source: 'manual' } };
  };
  return { save, calls };
}

function load(records, materials, options = {}) {
  const dom = buildDoc(); const win = { CreditTarget: CT }; const saver = makeSave(records, options);
  new Function('window', 'document', SOURCE)(win, dom.doc);
  const controller = win.CreditReview.create({
    getRecords: () => records, getMaterials: () => materials, saveCreditRole: saver.save, limit: 50,
  });
  return { ...dom, controller, saver };
}
function actionFor(ui, videoId, role, action) {
  return findAll(ui.list, (node) => node.dataset && node.dataset.videoId === videoId
    && node.dataset.role === role && node.dataset.creditReviewAction === action)[0] || null;
}
function choicesFor(ui, videoId, role) {
  return findAll(ui.list, (node) => node.dataset && node.dataset.videoId === videoId
    && node.dataset.role === role && Object.prototype.hasOwnProperty.call(node.dataset, 'creditReviewChoice'));
}

function fixture() {
  return {
    records: [
      { videoId: 'auto', title: 'Auto', composer: '', lyricist: '', arranger: '' },
      { videoId: 'review', title: 'Review', composer: '', lyricist: '', arranger: '' },
      { videoId: 'conflict', title: 'Conflict', composer: '', lyricist: '', arranger: '' },
      { videoId: 'verified', title: 'Verified', composer: 'Human', lyricist: '', arranger: '',
        creditRoleSources: { composer: 'manual' } },
    ],
    materials: { candidates: [
      { videoId: 'auto', composer: 'Alice', source: 'rule', selected: true },
      { videoId: 'review', lyricist: 'Bob', source: 'mb', selected: false },
      { videoId: 'conflict', arranger: 'Carol', source: 'rule', selected: true },
      { videoId: 'conflict', arranger: 'Dana', source: 'same-song', selected: true },
    ] },
  };
}

function loadRealDb(records) {
  const store = new Map(records.map((record) => [record.videoId, structuredClone(record)]));
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {}; let pending = 0; let issued = false;
      const complete = () => { if (issued && pending === 0) setImmediate(() => tx.oncomplete && tx.oncomplete()); };
      tx.objectStore = () => ({
        get(key) {
          const request = {}; pending++;
          setImmediate(() => {
            request.result = structuredClone(store.get(key)); if (request.onsuccess) request.onsuccess();
            pending--; complete();
          });
          return request;
        },
        put(value) { store.set(value.videoId, structuredClone(value)); },
      });
      setImmediate(() => { issued = true; complete(); }); return tx;
    },
  };
  const indexedDB = { open() {
    const request = {}; setImmediate(() => { request.result = db; if (request.onsuccess) request.onsuccess({ target: request }); });
    return request;
  } };
  const api = new Function('indexedDB', 'globalThis', `${DB_SOURCE}\nreturn WatchedDB;`)(indexedDB, { CreditTarget: CT });
  return { api, store };
}

async function testRejectUndoAndPersistence() {
  console.log('reject / undo / persistence');
  const data = fixture(); const ui = load(data.records, data.materials); await ui.opener.trigger('click');
  const before = structuredClone(data.records[0]);
  const rejected = await ui.controller.reject('auto', 'composer');
  check('rejection removes the candidate row without changing its value', rejected.updated === true
    && data.records[0].composer === before.composer && !ui.controller.findItem('auto', 'composer')
    && !!data.records[0].creditReviewRejections.composer);
  const reopened = load(data.records, data.materials); await reopened.opener.trigger('click');
  check('persisted rejection remains hidden after reopening the screen', !reopened.controller.findItem('auto', 'composer'));
  const undone = await ui.controller.undo('auto', 'composer');
  check('undo restores the original candidate state', undone.updated === true
    && !data.records[0].creditReviewRejections && ui.controller.findItem('auto', 'composer').state === 'auto_candidate'
    && !!actionFor(ui, 'auto', 'composer', 'reject'));
  const reviewValue = data.records[1].lyricist;
  const reviewRejected = await ui.controller.reject('review', 'lyricist');
  check('needs-review candidates can also be rejected without changing the value', reviewRejected.updated === true
    && data.records[1].lyricist === reviewValue && !ui.controller.findItem('review', 'lyricist'));
}

async function testRealDbRejection() {
  console.log('real DB rejection route');
  const env = loadRealDb([
    { videoId: 'candidate', composer: '', lyricist: '', arranger: '' },
    { videoId: 'verified', composer: 'Human', lyricist: '', arranger: '', creditRoleSources: { composer: 'manual' } },
  ]);
  const signature = '["Alice"]';
  const rejected = await env.api.setManualCreditRole({ videoId: 'candidate', role: 'composer', value: '',
    expectedCurrent: '', expectedSource: '', rejectCandidate: signature });
  check('existing DB transaction stores rejection metadata and preserves value', rejected.updated === true
    && env.store.get('candidate').composer === ''
    && env.store.get('candidate').creditReviewRejections.composer === signature);
  const restored = await env.api.setManualCreditRole({ videoId: 'candidate', role: 'composer', value: '',
    expectedCurrent: '', expectedSource: '', restoreCandidateRejection: null });
  check('existing DB transaction removes rejection metadata on undo', restored.updated === true
    && !env.store.get('candidate').creditReviewRejections);
  const blocked = await env.api.setManualCreditRole({ videoId: 'verified', role: 'composer', value: 'Human',
    expectedCurrent: 'Human', expectedSource: 'manual', rejectCandidate: signature });
  check('DB independently refuses rejection of an already verified role', blocked.error === 'already_verified'
    && env.store.get('verified').composer === 'Human');

  // 値が空でないレコードで試さないと「却下が値を消す」欠陥を検出できない
  // （既存ケースは composer:'' なので、値を消す変異をしても差が出なかった）。
  const filled = loadRealDb([
    { videoId: 'filled', composer: 'Auto Guess', lyricist: '', arranger: '',
      creditRoleSources: { composer: 'enrich:mb' } },
  ]);
  const keptValue = await filled.api.setManualCreditRole({ videoId: 'filled', role: 'composer',
    value: 'Auto Guess', expectedCurrent: 'Auto Guess', expectedSource: 'enrich:mb',
    rejectCandidate: signature });
  check('rejecting a non-blank unverified value leaves that value in the DB',
    keptValue.updated === true
    && filled.store.get('filled').composer === 'Auto Guess'
    && filled.store.get('filled').creditReviewRejections.composer === signature);
}

async function testConflictResolution() {
  console.log('conflict resolution');
  const data = fixture(); const ui = load(data.records, data.materials); await ui.opener.trigger('click');
  const choices = choicesFor(ui, 'conflict', 'arranger');
  check('conflict choices include candidates and none are selected by default', choices.length === 3
    && choices.every((input) => input.checked === false)
    && actionFor(ui, 'conflict', 'arranger', 'resolve').disabled === true);
  ui.controller.selectConflict('conflict', 'arranger', 'Carol');
  const resolved = await ui.controller.resolveConflict('conflict', 'arranger');
  check('explicitly selected conflict candidate becomes verified', resolved.updated === true
    && data.records[2].arranger === 'Carol' && roleSource(data.records[2], 'arranger') === 'manual'
    && ui.controller.findItem('conflict', 'arranger').state === 'verified');

  const unchangedData = fixture(); const unchangedUi = load(unchangedData.records, unchangedData.materials);
  await unchangedUi.opener.trigger('click'); unchangedUi.controller.selectConflict('conflict', 'arranger', '');
  const unchanged = await unchangedUi.controller.resolveConflict('conflict', 'arranger');
  check('choosing none leaves the conflict and stored value unchanged', unchanged.unchanged === true
    && unchangedData.records[2].arranger === ''
    && unchangedUi.controller.findItem('conflict', 'arranger').state === 'conflict'
    && unchangedUi.saver.calls.length === 0);
}

async function testVerifiedAndFailureGuards() {
  console.log('verified / save failure guards');
  const data = fixture(); const ui = load(data.records, data.materials); await ui.opener.trigger('click');
  const verifiedBefore = structuredClone(data.records[3]);
  const rejectResult = await ui.controller.reject('verified', 'composer');
  const resolveResult = await ui.controller.resolveConflict('verified', 'composer');
  check('verified roles expose neither action and direct calls cannot mutate them', !actionFor(ui, 'verified', 'composer', 'reject')
    && !actionFor(ui, 'verified', 'composer', 'resolve') && rejectResult.error === 'not_rejectable'
    && resolveResult.error === 'not_resolvable' && JSON.stringify(data.records[3]) === JSON.stringify(verifiedBefore));

  const rejectData = fixture(); const rejectUi = load(rejectData.records, rejectData.materials, { fail: true });
  await rejectUi.opener.trigger('click'); const rejectBefore = structuredClone(rejectData.records[0]);
  const failedReject = await rejectUi.controller.reject('auto', 'composer');
  check('failed rejection stays visible and is not applied optimistically', failedReject.error === 'disk_failure'
    && JSON.stringify(rejectData.records[0]) === JSON.stringify(rejectBefore)
    && !!rejectUi.controller.findItem('auto', 'composer') && !!actionFor(rejectUi, 'auto', 'composer', 'reject')
    && rejectUi.list.textContent.includes('却下の保存に失敗しました'));

  const conflictData = fixture(); const conflictUi = load(conflictData.records, conflictData.materials, { fail: true });
  await conflictUi.opener.trigger('click'); conflictUi.controller.selectConflict('conflict', 'arranger', 'Dana');
  const failedResolve = await conflictUi.controller.resolveConflict('conflict', 'arranger');
  check('failed conflict save remains unresolved and selected rather than looking complete', failedResolve.error === 'disk_failure'
    && conflictData.records[2].arranger === '' && conflictUi.controller.findItem('conflict', 'arranger').state === 'conflict'
    && choicesFor(conflictUi, 'conflict', 'arranger').some((input) => input.value === 'Dana' && input.checked)
    && conflictUi.list.textContent.includes('確定の保存に失敗しました'));
}

function testWiringAndNoBulkActions() {
  console.log('wiring / one-at-a-time safety');
  check('offscreen forwards both rejection save and undo fields', OFFSCREEN_SOURCE.includes('message.rejectCandidate')
    && OFFSCREEN_SOURCE.includes('message.restoreCandidateRejection'));
  check('no bulk rejection or conflict resolution control exists', !SOURCE.includes('rejectAll')
    && !SOURCE.includes('resolveAll') && !SOURCE.includes('一括却下') && !SOURCE.includes('一括解消'));
}

async function main() {
  await testRejectUndoAndPersistence();
  await testRealDbRejection();
  await testConflictResolution();
  await testVerifiedAndFailureGuards();
  testWiringAndNoBulkActions();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((error) => { console.error(error); process.exit(1); });
