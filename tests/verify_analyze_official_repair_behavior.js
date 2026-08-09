// Behavioral verification for the Analyze official-profile repair flow.
// Production UI and profile APIs run with fake DOM/storage/fetch; no real I/O.
// Run: node tests/verify_analyze_official_repair_behavior.js
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

function makeRepairSettings() {
  const channelId = 'UCAbCdEfGhIjKlMnOpQrStUv';
  const settings = store.createDefaultSettings();
  settings.profiles.repair = {
    id: 'repair',
    displayName: 'Repair Artist',
    aliases: [],
    mode: 'all',
    channels: [{
      channelId: channelId.toLowerCase(),
      canonicalPath: '/channel/' + channelId.toLowerCase(),
      sourceChannelName: 'Repair Artist - Topic',
      displayName: 'Repair Artist - Topic',
      enabled: true,
      channelIdMigration: store.CHANNEL_ID_MIGRATION_UNRESOLVED,
    }],
  };
  return { channelId, settings };
}

function makeHarness(fetchImpl) {
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
  const { channelId, settings } = makeRepairSettings();
  const storageArea = new FakeStorageArea(settings);
  const window = {
    YWHAnalyzeOfficialProfiles: analyze,
    YWHOfficialProfileStore: store,
    confirm: () => true,
  };
  globalThis.chrome = { runtime: {}, storage: { local: storageArea } };
  globalThis.fetch = fetchImpl;
  return {
    channelId,
    elements,
    storageArea,
    ui: makeUi({ window, document }),
  };
}

function repairData() {
  return [{ channel: 'Repair Artist - Topic', videoId: 'repair-source-video' }];
}
function reviewButton(harness) {
  return find(
    harness.elements.candidates,
    (element) => element.dataset.officialReview === 'Repair Artist - Topic'
  );
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
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

async function exerciseSuccess() {
  const expectedId = 'UCAbCdEfGhIjKlMnOpQrStUv';
  const harness = makeHarness(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      author_url: 'https://www.youtube.com/channel/' + expectedId,
      author_name: 'Repair Artist - Topic',
    }),
  }));
  harness.ui.renderOfficialProfileCandidates(repairData());
  await settle();
  const initialText = harness.elements.candidates.textContent;
  const initialButton = reviewButton(harness);

  await initialButton.click();
  await settle();
  const resolvedUrl = harness.elements.channelUrl.value;
  harness.elements.confirmed.checked = true;
  await harness.elements.save.click();
  await settle();

  const savedPayload = harness.storageArea.setCalls[0];
  return {
    ...harness,
    initialText,
    resolvedUrl,
    savedPayload,
    savedChannel: savedPayload?.[store.STORAGE_KEY]
      ?.profiles?.repair?.channels?.[0],
    buttonAfterSave: reviewButton(harness),
  };
}

async function exerciseFailure() {
  const harness = makeHarness(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ author_name: 'Repair Artist - Topic' }),
  }));
  harness.ui.renderOfficialProfileCandidates(repairData());
  await settle();

  await reviewButton(harness).click();
  await settle();
  harness.elements.confirmed.checked = true;
  await harness.elements.save.click();
  await settle();

  return { ...harness, remainingButton: reviewButton(harness) };
}

async function run() {
  console.log('Analyze official-profile repair — extracted UI with fake DOM/storage');
  const success = await exerciseSuccess();
  check('behavior: unresolved-lowercase candidate renders as a repair row',
    success.initialText.includes('要修復: 旧形式のチャンネルIDです'));
  check('behavior: repair review click restores the authoritative channel URL and profile fields',
    success.resolvedUrl === 'https://www.youtube.com/channel/' + success.channelId &&
    success.elements.target.href === success.resolvedUrl &&
    success.elements.profileName.value === 'Repair Artist');
  check('behavior: repair save click persists the authoritative channel through storage.set',
    success.storageArea.setCalls.length === 1 &&
    Boolean(success.savedPayload?.[store.STORAGE_KEY]) &&
    success.savedChannel?.channelId === success.channelId &&
    success.savedChannel?.canonicalPath === '/channel/' + success.channelId &&
    success.savedChannel?.sourceChannelName === 'Repair Artist - Topic' &&
    !Object.prototype.hasOwnProperty.call(
      success.savedChannel || {},
      'channelIdMigration'
    ));
  check('behavior: successful repair repaint removes the candidate from the repair list',
    success.buttonAfterSave === null &&
    !success.elements.candidates.textContent.includes(
      '要修復: 旧形式のチャンネルIDです'
    ));

  const failure = await exerciseFailure();
  check('behavior: missing confirmed URL saves no value and keeps the repair row visible',
    failure.elements.channelUrl.value === '' &&
    failure.storageArea.setCalls.length === 0 &&
    failure.remainingButton !== null &&
    failure.elements.candidates.textContent.includes(
      '要修復: 旧形式のチャンネルIDです'
    ));

  console.log(String.fromCharCode(10) + 'Result: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

run().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
