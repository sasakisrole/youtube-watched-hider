// Behavioral verification for composer_rules.json and its live enrichment path.
// Uses synthetic watched-video records; no user data or network access is required.
// Run: node tests/verify_composer_rules.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'enrich_credits.js'), 'utf8');
const rulesDocument = JSON.parse(fs.readFileSync(path.join(root, 'composer_rules.json'), 'utf8'));

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  click() {
    for (const listener of this.listeners.get('click') || []) {
      listener({ preventDefault() {}, stopPropagation() {} });
    }
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  querySelectorAll() {
    return [];
  }

  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.body = new FakeElement('body', this);
    this.modal = new FakeElement('div', this);
  }

  getElementById(id) {
    return id === 'enrichModal' ? this.modal : null;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createDocumentFragment() {
    return new FakeElement('#fragment', this);
  }

  addEventListener() {}
}

async function waitFor(findValue) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = findValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('confirmation dialog did not appear');
}

function makeRecord(videoId, channel) {
  return {
    videoId,
    channel,
    title: `Synthetic ${videoId}`,
    creditsRaw: 'synthetic credit hint',
    composer: '',
    lyricist: 'Existing Lyricist',
    arranger: 'Existing Arranger',
  };
}

async function generate(records) {
  const document = new FakeDocument();
  let mbCalls = 0;
  const chrome = {
    runtime: {
      lastError: null,
      getURL: () => 'fake-extension://composer_rules.json',
      getManifest: () => ({ version: 'test' }),
      sendMessage(message, callback) {
        if (message.type === 'getEnrichCreditsConfig') {
          callback({ success: true, rateLimitMs: 1 });
          return;
        }
        if (message.type === 'enrichCreditsMb') {
          mbCalls++;
          callback({ success: true, candidate: null });
          return;
        }
        throw new Error(`unexpected runtime message: ${message.type}`);
      },
    },
  };
  const window = { CreditTarget: { stripTopicChannelSuffix: (channel) => channel } };
  const fakeFetch = async () => ({ ok: true, json: async () => rulesDocument });

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', 'fetch', src)(window, document, chrome, fakeFetch);
  const controller = window.EnrichCredits.create({
    getRecords: () => records,
    beginMaintenance: () => true,
    endMaintenance() {},
  });

  const generation = controller.generateCandidates();
  const start = await waitFor(() => document.modal.find(
    (element) => element.dataset.enrichPrecountAction === 'start'));
  start.click();
  await generation;
  return { candidates: controller.getAllCandidates(), mbCalls };
}

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

async function main() {
  const expectedExistingRules = [
    ['fripSide - Topic', 'Satoshi Yaginuma'],
    ['Nobuo Uematsu - Topic', 'Nobuo Uematsu'],
    ['YOASOBI - Topic', 'Ayase'],
    ['Berlinist - Topic', 'Marco Albano, Luigi Gervasi'],
  ];
  const actualRules = rulesDocument.rules || [];
  check('REQ-1 composer_rules.json keeps the four established rules unchanged',
    expectedExistingRules.every(([channel, composer], index) => {
      const rule = actualRules[index];
      return rule && rule.channel === channel && rule.composer === composer;
    }));
  check('REQ-5 DOVA-SYNDROME has no channel-wide composer rule',
    !actualRules.some((rule) => rule.channel === 'DOVA-SYNDROME'));

  const matchingRule = { channel: 'fripSide - Topic', composer: 'Satoshi Yaginuma' };
  const unmatchedChannel = matchingRule.channel.toLocaleLowerCase();
  const result = await generate([
    makeRecord('matching', matchingRule.channel),
    makeRecord('unmatched', unmatchedChannel),
  ]);
  const matchingCandidate = result.candidates.find((candidate) => candidate.videoId === 'matching');
  const unmatchedCandidate = result.candidates.find((candidate) => candidate.videoId === 'unmatched');

  check('REQ-2 exact channel text reaches the live rule candidate path',
    matchingCandidate && matchingCandidate.source === 'rule'
      && matchingCandidate.composer === matchingRule.composer
      && matchingCandidate.selected === true);
  check('REQ-3 an unlisted case variant does not receive a rule candidate',
    !unmatchedCandidate && result.mbCalls === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
