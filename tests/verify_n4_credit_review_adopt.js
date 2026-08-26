// Synthetic verification for N4 Credit Review Center role-unit adoption.
// Run: node tests/verify_n4_credit_review_adopt.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'credit_review.js'), 'utf8');
const DB_SOURCE = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const OFFSCREEN_SOURCE = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
const HISTORY_SOURCE = fs.readFileSync(path.join(ROOT, 'history.js'), 'utf8');
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
    this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this._text = '';
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
  const modal = doc.register('creditReviewModal'); modal.hidden = true; modal.setAttribute('aria-hidden', 'true');
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
            request.result = structuredClone(store.get(key));
            if (request.onsuccess) request.onsuccess();
            pending--; complete();
          });
          return request;
        },
        put(value) { store.set(value.videoId, structuredClone(value)); },
      });
      setImmediate(() => { issued = true; complete(); });
      return tx;
    },
  };
  const indexedDB = { open() {
    const request = {};
    setImmediate(() => { request.result = db; if (request.onsuccess) request.onsuccess({ target: request }); });
    return request;
  } };
  const api = new Function('indexedDB', 'globalThis', `${DB_SOURCE}\nreturn WatchedDB;`)(indexedDB, { CreditTarget: CT });
  return { api, store };
}

function makeSave(records, options = {}) {
  const calls = [];
  const stored = new Map(records.map((record) => [record.videoId, structuredClone(record)]));
  const save = async (payload) => {
    calls.push({ ...payload });
    if (options.fail) return { error: 'disk_failure' };
    const record = stored.get(payload.videoId);
    if (!record) return { error: 'not_found' };
    const currentSource = roleSource(record, payload.role);
    const currentValue = record[payload.role];
    if ((currentValue || '') !== (payload.expectedCurrent || '') || currentSource !== (payload.expectedSource || '')) {
      return { conflict: true, current: { value: currentValue, source: currentSource } };
    }
    if (payload.adoptCandidate === true && currentSource === 'manual') return { error: 'already_verified' };
    const priorSources = record.creditRoleSources;
    const sourcePresent = !!(priorSources && Object.prototype.hasOwnProperty.call(priorSources, payload.role));
    const previous = { value: currentValue, source: currentSource, sourcePresent };
    const sources = priorSources ? { ...priorSources } : {};
    record[payload.role] = payload.value || '';
    if (Object.prototype.hasOwnProperty.call(payload, 'restoreRoleSource')) {
      if (payload.restoreRoleSource === null) delete sources[payload.role];
      else sources[payload.role] = payload.restoreRoleSource;
    } else {
      sources[payload.role] = 'manual';
    }
    if (Object.keys(sources).length) record.creditRoleSources = sources;
    else delete record.creditRoleSources;
    return { updated: true, previous, post: { value: record[payload.role], source: roleSource(record, payload.role) } };
  };
  return { save, calls, stored };
}

function load(records, materials, saveOptions) {
  const dom = buildDoc();
  const win = { CreditTarget: CT };
  const saver = makeSave(records, saveOptions);
  new Function('window', 'document', SOURCE)(win, dom.doc);
  const controller = win.CreditReview.create({
    getRecords: () => records, getMaterials: () => materials, saveCreditRole: saver.save, limit: 50,
  });
  return { ...dom, controller, saver };
}
function cards(ui) { return findAll(ui.list, (element) => element.classList.contains('credit-review-item')); }
function cardFor(ui, videoId, role) {
  return cards(ui).find((card) => card.dataset.videoId === videoId
    && findAll(card, (node) => node.dataset && node.dataset.role === role).length > 0);
}
function actionFor(ui, videoId, role, action) {
  return findAll(ui.list, (node) => node.dataset && node.dataset.videoId === videoId
    && node.dataset.role === role && node.dataset.creditReviewAction === action)[0] || null;
}
function countFor(ui, state) {
  return ui.filterButtons[state].querySelectorAll('[data-credit-review-count]')[0].textContent;
}

function fixture() {
  const records = [
    { videoId: 'auto', title: 'Auto', channel: 'A', composer: '', lyricist: '', arranger: '' },
    { videoId: 'review', title: 'Review', channel: 'B', composer: '', lyricist: '', arranger: '' },
    { videoId: 'conflict', title: 'Conflict', channel: 'C', composer: '', lyricist: '', arranger: '' },
    { videoId: 'verified', title: 'Verified', channel: 'D', composer: 'Human', lyricist: '', arranger: '',
      creditRoleSources: { composer: 'manual' } },
  ];
  const materials = { candidates: [
    { videoId: 'auto', composer: 'Alice', source: 'rule', selected: true },
    { videoId: 'review', lyricist: 'Bob', source: 'rule', selected: false },
    { videoId: 'conflict', arranger: 'Carol', source: 'rule', selected: true },
    { videoId: 'conflict', arranger: 'Dana', source: 'same-song', selected: true },
  ] };
  return { records, materials };
}

async function testAdoptUndoAndCounts() {
  console.log('adopt / undo / counts');
  const data = fixture(); const ui = load(data.records, data.materials);
  await ui.opener.trigger('click');
  const before = structuredClone(data.records[0]);
  const autoBefore = Number(countFor(ui, 'auto_candidate'));
  const verifiedBefore = Number(countFor(ui, 'verified'));
  const adopted = await ui.controller.adopt('auto', 'composer');
  check('adoption writes candidate through manual route and becomes verified', adopted.updated === true
    && data.records[0].composer === 'Alice' && roleSource(data.records[0], 'composer') === 'manual'
    && CT.getCreditReviewStates(data.records[0], { candidates: data.materials.candidates.filter((c) => c.videoId === 'auto') }).composer.state === 'verified');
  check('adoption uses CAS and explicit candidate guard on existing route', ui.saver.calls[0].adoptCandidate === true
    && ui.saver.calls[0].expectedCurrent === '' && ui.saver.calls[0].expectedSource === ''
    && HISTORY_SOURCE.includes("sendHistoryDbRpc('SET_MANUAL_CREDIT_ROLE', payload)")
    && OFFSCREEN_SOURCE.includes('message.adoptCandidate === true'));
  check('counts move one role from candidate to verified after save', Number(countFor(ui, 'auto_candidate')) === autoBefore - 1
    && Number(countFor(ui, 'verified')) === verifiedBefore + 1);
  check('successful adoption exposes role-unit undo', !!actionFor(ui, 'auto', 'composer', 'undo'));
  await ui.filters.trigger('click', { target: ui.filterButtons.auto_candidate });
  check('immediate undo remains reachable after the adopted row leaves a filtered list', !ui.feedback.hidden
    && findAll(ui.feedback, (node) => node.dataset && node.dataset.creditReviewAction === 'undo').length === 1);

  const undone = await ui.controller.undo('auto', 'composer');
  check('undo fully restores the pre-adoption value, source presence, and state', undone.updated === true
    && JSON.stringify(data.records[0]) === JSON.stringify(before)
    && CT.getCreditReviewStates(data.records[0], { candidates: data.materials.candidates.filter((c) => c.videoId === 'auto') }).composer.state === 'auto_candidate');
  check('undo restores original counts', Number(countFor(ui, 'auto_candidate')) === autoBefore
    && Number(countFor(ui, 'verified')) === verifiedBefore);
}

async function testSafetyGuards() {
  console.log('conflict / verified guards');
  const data = fixture(); const ui = load(data.records, data.materials);
  await ui.opener.trigger('click');
  const conflictCard = cards(ui).find((card) => card.dataset.creditReviewState === 'conflict');
  check('conflict explains disagreement and has no adoption control', conflictCard.textContent.includes('値が食い違っています')
    && !actionFor(ui, 'conflict', 'arranger', 'adopt'));
  const verifiedBefore = structuredClone(data.records[3]);
  const result = await ui.controller.adopt('verified', 'composer');
  check('verified roles have no adoption path and cannot be overwritten', !actionFor(ui, 'verified', 'composer', 'adopt')
    && result.error === 'not_adoptable' && JSON.stringify(data.records[3]) === JSON.stringify(verifiedBefore));
  check('database adoption branch independently rejects manual current source', DB_SOURCE.includes("currentSource === 'manual'")
    && DB_SOURCE.includes("'already_verified'"));
  check('no bulk adoption control or implementation is present', !SOURCE.includes('adoptAll') && !SOURCE.includes('一括採用'));
}

async function testDatabaseAdoptionGuard() {
  console.log('database adoption guard');
  const env = loadRealDb([
    { videoId: 'candidate', title: 'Candidate', composer: 'Imported', lyricist: '', arranger: '',
      creditsSource: 'topic', creditRoleSources: { composer: 'topic' } },
    { videoId: 'manual', title: 'Manual', composer: 'Human', lyricist: '', arranger: '',
      creditsSource: '', creditRoleSources: { composer: 'manual' } },
  ]);
  const adopted = await env.api.setManualCreditRole({
    videoId: 'candidate', role: 'composer', value: 'Reviewed', expectedCurrent: 'Imported',
    expectedSource: 'topic', adoptCandidate: true,
  });
  check('real DB route adopts an unverified candidate as manual', adopted.updated === true
    && env.store.get('candidate').composer === 'Reviewed'
    && roleSource(env.store.get('candidate'), 'composer') === 'manual');
  const rejected = await env.api.setManualCreditRole({
    videoId: 'manual', role: 'composer', value: 'Intruder', expectedCurrent: 'Human',
    expectedSource: 'manual', adoptCandidate: true,
  });
  check('real DB route refuses to overwrite an already verified role', rejected.error === 'already_verified'
    && env.store.get('manual').composer === 'Human');
}

async function testSaveFailureIsNotOptimistic() {
  console.log('save failure');
  const data = fixture(); const ui = load(data.records, data.materials, { fail: true });
  await ui.opener.trigger('click');
  const before = structuredClone(data.records[0]);
  const autoBefore = countFor(ui, 'auto_candidate');
  const verifiedBefore = countFor(ui, 'verified');
  const result = await ui.controller.adopt('auto', 'composer');
  check('failed save leaves record and review state unadopted', result.error === 'disk_failure'
    && JSON.stringify(data.records[0]) === JSON.stringify(before)
    && !!actionFor(ui, 'auto', 'composer', 'adopt') && !actionFor(ui, 'auto', 'composer', 'undo'));
  check('failed save leaves counts unchanged and surfaces an error', countFor(ui, 'auto_candidate') === autoBefore
    && countFor(ui, 'verified') === verifiedBefore && ui.list.textContent.includes('採用の保存に失敗しました'));
}

async function main() {
  await testAdoptUndoAndCounts();
  await testSafetyGuards();
  await testDatabaseAdoptionGuard();
  await testSaveFailureIsNotOptimistic();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((error) => { console.error(error); process.exit(1); });
