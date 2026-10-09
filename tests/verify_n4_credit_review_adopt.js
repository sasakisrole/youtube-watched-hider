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
  check('bulk adoption is wired only into the recheck screen', !HISTORY_SOURCE.includes('adoptAll'));
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


async function testVerifiedCorrections() {
  const maintenance = require('../credit_corrections.js');
  const roles = ['composer', 'lyricist', 'arranger'];
  const records = ['anyVideo001', 'anyVideo002'].map(videoId => ({videoId, title:'Example Remix', composer:'Old', lyricist:'Old', arranger:'Old', creditsSource:'general', watchedAt:123, playCount:9}));
  const original = structuredClone(records);
  const results = records.map(r => ({ok:true,title:r.title,maintenance:{credits:{composer:'Alice',lyricist:'Bob',arranger:'Guest'},evidence:{composer:'Composer: Alice',lyricist:'Lyrics: Bob',arranger:'Arranger: Guest'}}}));
  const getCandidates = () => records.flatMap((r,i) => maintenance.candidates(r,results[i],CT));
  const env = loadRealDb(records);
  const ui = load(records, {});
  ui.controller.env.getMaterials = () => ({candidates:getCandidates()});
  ui.controller.env.filterItem = item => item.candidates.some(c => c.source === 'description-recheck');
  ui.controller.env.saveCreditRole = payload => env.api.setManualCreditRole(payload);
  ui.controller.env.allowReject = false;
  await ui.opener.trigger('click');
  check('generic source-derived changes display six role rows',ui.controller.reviewList.totalCount===6);
  check('source links and exact evidence lines are visible',findAll(ui.list,e=>e.tagName==='A').length===6 && ui.list.textContent.includes('Composer: Alice'));
  for (const record of records) for (const role of roles) {
    const result=await ui.controller.adopt(record.videoId,role);
    check('adopt arbitrary video '+record.videoId+'/'+role,result.updated===true);
  }
  check('adoption retains all undo cards',getCandidates().length===0 && ui.controller.reviewList.counts.verified===6);
  for (const record of records) for (const role of roles) {
    const result=await ui.controller.undo(record.videoId,role);
    check('undo arbitrary video '+record.videoId+'/'+role,result.updated===true);
  }
  check('undo restores all fields',JSON.stringify([...env.store.values()])===JSON.stringify(original));
  env.store.get(records[0].videoId).composer='Concurrent Edit';
  const result=await ui.controller.adopt(records[0].videoId,'composer');
  check('stale scan cannot overwrite concurrent edit',result.conflict===true && env.store.get(records[0].videoId).composer==='Concurrent Edit');
}

async function testInvalidValueUndo() {
  const before={videoId:'invalid-old',title:'Example',composer:'https://example.com',creditsSource:'general'};
  const env=loadRealDb([before]);
  const result=await env.api.setManualCreditRole({videoId:before.videoId,role:'composer',value:'Alice',expectedCurrent:before.composer,expectedSource:'general',adoptCandidate:true});
  check('invalid saved values can be replaced',result.updated===true);
  const wrong=await env.api.setManualCreditRole({videoId:before.videoId,role:'composer',value:'https://other.example.com',expectedCurrent:'Alice',expectedSource:'manual',restoreRoleSource:null});
  check('undo cannot forge an invalid value',wrong.error==='invalid_value');
  const restored=await env.api.setManualCreditRole({videoId:before.videoId,role:'composer',value:before.composer,expectedCurrent:'Alice',expectedSource:'manual',restoreRoleSource:null});
  check('recorded invalid original can be restored with exact provenance',restored.updated===true && JSON.stringify(env.store.get(before.videoId))===JSON.stringify(before));
}

async function testAdoptAll() {
  console.log('adopt all');
  const data = fixture(); const ui = load(data.records, data.materials);
  await ui.opener.trigger('click');
  const skipped = await ui.controller.adoptAll((item) => item.videoId !== 'review');
  check('accept filter limits bulk adoption', skipped.targets === 1 && skipped.adopted === 1 && data.records[1].lyricist === '');
  const rest = await ui.controller.adoptAll();
  check('bulk adoption takes remaining single-value candidates only', rest.adopted === 1 && rest.failed === 0
    && data.records[0].composer === 'Alice' && data.records[1].lyricist === 'Bob' && data.records[2].arranger === '');
  check('every bulk adoption keeps its own undo', !!actionFor(ui, 'auto', 'composer', 'undo') || ui.controller.undoActions.has('auto:composer'));
  const stale = fixture(); const ui2 = load(stale.records, stale.materials);
  await ui2.opener.trigger('click');
  ui2.saver.stored.get('auto').composer = 'Changed elsewhere';
  const guarded = await ui2.controller.adoptAll();
  check('stored-value check still guards each bulk adoption', guarded.failed === 1 && guarded.adopted === 1
    && ui2.saver.stored.get('auto').composer === 'Changed elsewhere');
  const before = structuredClone(data.records);
  const third = fixture(); const ui3 = load(third.records, third.materials);
  await ui3.opener.trigger('click');
  const snapshot = structuredClone(third.records);
  await ui3.controller.adoptAll();
  const again = await ui3.controller.adoptAll();
  check('an empty bulk run keeps the previous batch undo', again.targets === 0 && ui3.controller.lastBatch.length === 2
    && ui3.controller.adoptable().length === 0);
  const undone = await ui3.controller.undoBatch();
  check('batch undo restores every bulk adoption', undone.undone === 2 && undone.failed === 0
    && JSON.stringify(third.records) === JSON.stringify(snapshot) && ui3.controller.lastBatch.length === 0 && before.length === 4);
}

async function main() {
  await testAdoptAll();
  await testInvalidValueUndo();
  await testVerifiedCorrections();
  await testAdoptUndoAndCounts();
  await testSafetyGuards();
  await testDatabaseAdoptionGuard();
  await testSaveFailureIsNotOptimistic();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((error) => { console.error(error); process.exit(1); });
