const CT = require('../credit_target');
const DB_SOURCE = require('fs').readFileSync(require.resolve('../db.js'), 'utf8');
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


module.exports = { buildDoc, loadRealDb };
