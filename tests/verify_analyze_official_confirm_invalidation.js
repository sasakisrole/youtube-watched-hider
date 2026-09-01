#!/usr/bin/env node
'use strict';
// Behavioral verification: the Analyze official-profile confirmation must not
// survive an edit of the values it vouches for.
// Production UI and profile APIs run with fake DOM/storage/fetch; no real I/O.
// Run: node tests/verify_analyze_official_confirm_invalidation.js
const fs = require('fs');
const path = require('path');
const analyze = require('../analyze_official_profiles.js');
const store = require('../official_profile_store.js');
const analyzerSource = fs.readFileSync(path.join(__dirname, '..', 'analyzer.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = analyzerSource.indexOf(startMarker);
  if (start < 0) throw new Error('start marker not found: ' + startMarker);
  const end = analyzerSource.indexOf(endMarker, start);
  if (end < 0) throw new Error('end marker not found: ' + endMarker);
  return analyzerSource.slice(start, end);
}
const uiBlock = sliceBetween(
  'let currentOfficialCandidate = null;',
  String.fromCharCode(10) + '  async function runAnalysis()'
);
function makeUi(deps) {
  // eslint-disable-next-line no-eval
  return eval([
    '(function(deps) {',
    'const { window, document } = deps;',
    uiBlock,
    'return { renderOfficialProfileCandidates };',
    '})',
  ].join(String.fromCharCode(10)))(deps);
}

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this._text = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.oninput = null;
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeAttribute(name) {
    delete this[name];
  }
  async click() {
    for (const listener of this.listeners.get('click') || []) {
      await listener({ type: 'click', target: this });
    }
    if (typeof this.onclick === 'function') {
      return this.onclick({ type: 'click', target: this });
    }
  }
  // A person typing into the field: the value changes and the browser fires `input`.
  async type(value) {
    this.value = value;
    for (const listener of this.listeners.get('input') || []) {
      await listener({ type: 'input', target: this });
    }
    if (typeof this.oninput === 'function') {
      return this.oninput({ type: 'input', target: this });
    }
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
  }
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
  add(id, tagName = 'div') {
    const element = this.createElement(tagName);
    element.id = id;
    this.elements.set(id, element);
    return element;
  }
  getElementById(id) {
    return this.elements.get(id) || null;
  }
}

class FakeStorageArea {
  constructor(settings) {
    this.data = { [store.STORAGE_KEY]: structuredClone(settings) };
    this.setCalls = [];
  }
  get(key, callback) {
    callback({ [key]: structuredClone(this.data[key]) });
  }
  set(payload, callback) {
    const copy = structuredClone(payload);
    this.setCalls.push(copy);
    Object.assign(this.data, copy);
    callback();
  }
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

const CANDIDATE_CHANNEL = 'Confirm Artist - Topic';
const RESOLVED_ID = 'UCConfirmArtistTopic0001';
const RESOLVED_URL = 'https://www.youtube.com/channel/' + RESOLVED_ID;
const TAMPERED_URL = 'https://www.youtube.com/@someone-else';

function makeHarness() {
  const document = new FakeDocument();
  const elements = {
    candidates: document.add('azOfficialCandidates'),
    save: document.add('azOfficialSave', 'button'),
    review: document.add('azOfficialReview'),
    profileName: document.add('azOfficialProfileName', 'input'),
    channelUrl: document.add('azOfficialChannelUrl', 'input'),
    confirmed: document.add('azOfficialConfirmed', 'input'),
    bindQuery: document.add('azOfficialBindQuery', 'input'),
    bindQueryText: document.add('azOfficialBindQueryText', 'span'),
    sample: document.add('azOfficialSample', 'a'),
    target: document.add('azOfficialTarget', 'a'),
    status: document.add('azOfficialStatus'),
    hidden: document.add('azOfficialHidden'),
  };
  elements.review.hidden = true;
  const storageArea = new FakeStorageArea(store.createDefaultSettings());
  const window = {
    YWHAnalyzeOfficialProfiles: analyze,
    YWHOfficialProfileStore: store,
    confirm: () => true,
  };
  globalThis.chrome = { runtime: {}, storage: { local: storageArea } };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      author_url: RESOLVED_URL,
      author_name: CANDIDATE_CHANNEL,
    }),
  });
  return { elements, storageArea, ui: makeUi({ window, document }) };
}

function candidateData() {
  return [{ channel: CANDIDATE_CHANNEL, videoId: 'confirm-source-video' }];
}
function reviewButton(harness) {
  return find(
    harness.elements.candidates,
    (element) => element.dataset.officialReview === CANDIDATE_CHANNEL
  );
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

// Open the review panel and tick the confirmation, i.e. the state a person is in
// right after checking the auto-resolved link.
async function openConfirmedReview() {
  const harness = makeHarness();
  harness.ui.renderOfficialProfileCandidates(candidateData());
  await settle();
  await reviewButton(harness).click();
  await settle();
  harness.elements.confirmed.checked = true;
  return harness;
}

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed++;
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name);
  }
}

async function run() {
  console.log('Analyze official-profile confirmation — extracted UI with fake DOM/storage');

  const baseline = await openConfirmedReview();
  const resolvedUrl = baseline.elements.channelUrl.value;
  await baseline.elements.save.click();
  await settle();
  check('behavior: an untouched confirmed review still registers the resolved channel',
    resolvedUrl === RESOLVED_URL &&
    baseline.storageArea.setCalls.length === 1);

  const editedUrl = await openConfirmedReview();
  await editedUrl.elements.channelUrl.type(TAMPERED_URL);
  check('behavior: editing the channel URL drops the confirmation',
    editedUrl.elements.confirmed.checked === false);
  check('behavior: the verification link follows the edited URL instead of the old one',
    editedUrl.elements.target.href === TAMPERED_URL);
  await editedUrl.elements.save.click();
  await settle();
  check('behavior: saving after a URL edit persists nothing until re-confirmed',
    editedUrl.storageArea.setCalls.length === 0);

  const editedName = await openConfirmedReview();
  await editedName.elements.profileName.type('Someone Else');
  check('behavior: editing the profile name drops the confirmation',
    editedName.elements.confirmed.checked === false);
  await editedName.elements.save.click();
  await settle();
  check('behavior: saving after a name edit persists nothing until re-confirmed',
    editedName.storageArea.setCalls.length === 0);

  const reconfirmed = await openConfirmedReview();
  await reconfirmed.elements.channelUrl.type(TAMPERED_URL);
  reconfirmed.elements.confirmed.checked = true;
  await reconfirmed.elements.save.click();
  await settle();
  const savedChannel = reconfirmed.storageArea.setCalls[0]?.[store.STORAGE_KEY]
    ?.profiles?.['confirm-artist']?.channels?.[0];
  check('behavior: re-confirming the edited URL registers the edited channel, not the resolved one',
    reconfirmed.storageArea.setCalls.length === 1 &&
    savedChannel?.canonicalPath === '/@someone-else');

  console.log(String.fromCharCode(10) + 'Result: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

run().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
