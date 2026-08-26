// Synthetic verification for N4 Credit Review Center read-only UI.
// Run: node tests/verify_n4_credit_review_ui.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'credit_review.js'), 'utf8');
const HISTORY_SOURCE = fs.readFileSync(path.join(ROOT, 'history.js'), 'utf8');
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
    this.listeners = {}; this.hidden = false; this.value = ''; this._text = '';
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
  async trigger(type, extra = {}) {
    const event = { type, target: this, currentTarget: this, key: '', preventDefault() {}, ...extra };
    for (const handler of this.listeners[type] || []) await handler(event);
  }
  register(id, tag = 'div', parent = this.body) {
    const element = this.createElement(tag); element.id = id; element.attributes.id = id;
    this.ids.set(id, element); parent.appendChild(element); return element;
  }
}

function descendants(root) { return (root.children || []).flatMap((child) => [child, ...descendants(child)]); }
function matches(element, selector) {
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  const data = selector.match(/^\[data-([a-z0-9-]+)\]$/i);
  if (!data) return false;
  const key = data[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  return Object.prototype.hasOwnProperty.call(element.dataset, key);
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
    button.setAttribute('aria-pressed', state === 'all' ? 'true' : 'false');
    const count = doc.createElement('span'); count.dataset.creditReviewCount = state; count.textContent = '0';
    button.appendChild(count); filters.appendChild(button); filterButtons[state] = button;
  });
  const summary = doc.register('creditReviewSummary', 'p', modal);
  const list = doc.register('creditReviewList', 'div', modal);
  const empty = doc.register('creditReviewEmpty', 'div', modal); empty.hidden = true; empty.textContent = '該当なし';
  return { doc, opener, modal, filters, filterButtons, summary, list, empty };
}

function fixture() {
  const records = [
    { videoId: 'video-b', title: 'Mixed Roles', channel: 'Channel B', composer: 'Manual Composer',
      lyricist: '', arranger: 'Imported Arranger', creditRoleSources: { composer: 'manual', arranger: 'topic' } },
    { videoId: 'video-a', title: 'Conflict and Empty', channel: 'Channel A', composer: '', lyricist: '', arranger: '' },
  ];
  const materials = { candidates: [
    { videoId: 'video-b', lyricist: 'Rule Lyricist', source: 'rule', selected: true },
    { videoId: 'video-a', composer: 'Alice', source: 'rule', selected: true },
    { videoId: 'video-a', composer: 'Bob', source: 'same-song', selected: true },
  ] };
  return { records, materials };
}

function load(records, materials, limit = 20) {
  const dom = buildDoc();
  const win = { CreditTarget: CT };
  new Function('window', 'document', SOURCE)(win, dom.doc);
  const controller = win.CreditReview.create({ getRecords: () => records, getMaterials: () => materials, limit });
  return { ...dom, win, controller };
}

function cards(ui) { return findAll(ui.list, (element) => element.classList.contains('credit-review-item')); }
function countFor(ui, state) {
  return ui.filterButtons[state].querySelectorAll('[data-credit-review-count]')[0].textContent;
}

async function testMarkupAndIntegration() {
  console.log('markup / integration');
  check('history has a permanent opener and labelled modal dialog', HTML.includes('id="creditReviewOpen"')
    && HTML.includes('id="creditReviewModal"') && HTML.includes('aria-labelledby="creditReviewTitle"'));
  check('credit review script is loaded before history integration', HTML.indexOf('credit_review.js') > 0
    && HTML.indexOf('credit_review.js') < HTML.indexOf('history.js'));
  check('history integrates current records and in-memory candidates', HISTORY_SOURCE.includes('window.CreditReview.create')
    && HISTORY_SOURCE.includes('getRecords: () => allData') && HISTORY_SOURCE.includes('getAllCandidates()'));
  check('modal has scroll lock, focus, and 44px control styles', HTML.includes('body.credit-review-modal-open { overflow: hidden; }')
    && HTML.includes('.credit-review-filter { min-height: 44px') && HTML.includes('.credit-review-modal button:focus-visible'));
  const markup = HTML.slice(HTML.indexOf('id="creditReviewModal"'), HTML.indexOf('id="enrichModal"'));
  check('actual review markup contains no emoji', !/[\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3\u{1F300}-\u{1FAFF}]/u.test(markup));
}

async function testCountsFilteringAndRows() {
  console.log('counts / filtering / rows');
  const data = fixture(); const ui = load(data.records, data.materials);
  await ui.opener.trigger('click');
  check('opening renders all video-role rows and locks background scroll', !ui.modal.hidden
    && ui.doc.body.classList.contains('credit-review-modal-open') && cards(ui).length === 6);
  check('all five state counts are shown', STATES.slice(1).map((state) => countFor(ui, state)).join(',') === '1,1,1,2,1');
  check('one row exposes title, channel, role, current value, and candidates', ui.list.textContent.includes('Conflict and Empty')
    && ui.list.textContent.includes('Channel A') && ui.list.textContent.includes('作曲 / 競合')
    && ui.list.textContent.includes('現在値') && ui.list.textContent.includes('候補')
    && ui.list.textContent.includes('Alice / Bob'));
  const conflictCard = cards(ui).find((card) => card.dataset.creditReviewState === 'conflict');
  check('blank stored current value is not confused with a candidate', conflictCard.textContent.includes('現在値未設定')
    && conflictCard.textContent.includes('候補Alice / Bob'));
  await ui.filters.trigger('click', { target: ui.filterButtons.conflict });
  check('state filter leaves only matching rows', cards(ui).length === 1
    && cards(ui)[0].dataset.creditReviewState === 'conflict');
  check('active filter state is accessible', ui.filterButtons.conflict.getAttribute('aria-pressed') === 'true'
    && ui.filterButtons.all.getAttribute('aria-pressed') === 'false');
}

async function testTruncatedAndEmpty() {
  console.log('truncated / empty');
  const data = fixture(); const limited = load(data.records, data.materials, 3);
  await limited.opener.trigger('click');
  check('truncated list says N件中M件を表示', limited.summary.textContent.includes('6件中3件を表示'));
  await limited.filters.trigger('click', { target: limited.filterButtons.verified });
  check('a state omitted by the global limit is not presented as truly empty', !limited.empty.hidden
    && limited.empty.textContent === '表示上限内に該当なし' && countFor(limited, 'verified') === '1');
  const emptyUi = load([], {}, 3); await emptyUi.opener.trigger('click');
  check('zero items show 該当なし instead of a blank list', !emptyUi.empty.hidden
    && emptyUi.empty.textContent === '該当なし' && emptyUi.list.hidden);
}

async function testClosing() {
  console.log('Escape / backdrop closing');
  const data = fixture(); const ui = load(data.records, data.materials);
  ui.opener.focus(); await ui.opener.trigger('click'); await ui.doc.trigger('keydown', { key: 'Escape' });
  check('Escape closes, unlocks scroll, and restores focus', ui.modal.hidden
    && !ui.doc.body.classList.contains('credit-review-modal-open') && ui.doc.activeElement === ui.opener);
  await ui.opener.trigger('click'); await ui.modal.trigger('click', { target: ui.modal });
  check('backdrop click closes the modal', ui.modal.hidden && !ui.doc.body.classList.contains('credit-review-modal-open'));
}

async function main() {
  await testMarkupAndIntegration(); await testCountsFilteringAndRows(); await testTruncatedAndEmpty(); await testClosing();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((error) => { console.error(error); process.exit(1); });
