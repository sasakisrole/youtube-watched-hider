// Behavioral verification for credit-enrichment estimates (enrich_credits.js).
// Evaluates the real browser IIFE with a fake DOM/Chrome runtime, clicks the
// real confirmation dialog, and runs generateCandidates() without networking.
// Run: node tests/verify_enrich_credits_estimate_behavior.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'enrich_credits.js'), 'utf8');

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

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  click() {
    this.dispatch('click', { preventDefault() {}, stopPropagation() {} });
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

function mbResponse(record, arranger) {
  return {
    success: true,
    candidate: {
      mbTitle: record.title,
      composer: '',
      lyricist: '',
      arranger,
      sim: 1,
      stage: 'strict',
      autoEligible: true,
      requiresManualReview: false,
      versionMatch: true,
    },
  };
}

function makeRecord(videoId, channel, title) {
  return {
    videoId,
    channel,
    title,
    creditsRaw: 'arrangement credit present',
    composer: 'Existing Composer',
    lyricist: 'Existing Lyricist',
    arranger: '',
  };
}

async function waitFor(findValue) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const value = findValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('confirmation dialog did not appear');
}

async function exerciseGeneration({ records, rules, cachedVideoIds = [], ruleLoadFails = false }) {
  const document = new FakeDocument();
  const calls = { config: 0, mb: 0, localRuleFetch: 0 };
  const byTitle = new Map(records.map((record) => [record.title, record]));
  const chrome = {
    runtime: {
      lastError: null,
      getURL: () => 'fake-extension://composer_rules.json',
      getManifest: () => ({ version: 'test' }),
      sendMessage(message, callback) {
        if (message.type === 'getEnrichCreditsConfig') {
          calls.config++;
          callback({ success: true, rateLimitMs: 60000 });
          return;
        }
        if (message.type === 'enrichCreditsMb') {
          calls.mb++;
          const record = byTitle.get(message.title);
          callback(mbResponse(record, `Network Arranger ${record.videoId}`));
          return;
        }
        throw new Error(`unexpected runtime message: ${message.type}`);
      },
    },
  };
  const fakeFetch = async (url) => {
    calls.localRuleFetch++;
    if (url !== 'fake-extension://composer_rules.json') throw new Error(`unexpected fetch: ${url}`);
    if (ruleLoadFails) throw new Error('simulated local rule load failure');
    return { ok: true, json: async () => ({ rules }) };
  };
  const window = {
    CreditTarget: { stripTopicChannelSuffix: (channel) => channel },
  };

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', 'fetch', src)(window, document, chrome, fakeFetch);
  const controller = window.EnrichCredits.create({
    getRecords: () => records,
    beginMaintenance: () => true,
    endMaintenance() {},
  });

  for (const record of records) {
    if (!cachedVideoIds.includes(record.videoId)) continue;
    controller.fetchCache.mb.set(`${record.channel}\n${record.title}`,
      mbResponse(record, `Cached Arranger ${record.videoId}`));
  }

  const groups = controller.groupUnassigned(records);
  const minimumRequestCount = window.EnrichCreditsTestHooks
    .getMinimumEnrichmentRequestCount(groups, rules, controller.fetchCache.mb);
  const hooks = window.EnrichCreditsTestHooks;
  const expectedEstimate = hooks.buildEnrichmentConfirmText(
    hooks.getEnrichmentPreCount(records),
    60000,
    null,
    minimumRequestCount,
  );
  const generation = controller.generateCandidates();
  const start = await waitFor(() => document.modal.find(
    (element) => element.dataset.enrichPrecountAction === 'start'));
  const panel = document.modal.find(
    (element) => element.className === 'enrich-message enrich-precount-confirm');

  if (ruleLoadFails) {
    await waitFor(() => calls.localRuleFetch === 1);
    const description = panel.find((element) => element.id === 'enrichPreCountDescription');
    const cancel = panel.find((element) => element.dataset.enrichPrecountAction === 'cancel');
    const displayedEstimate = description && description.textContent;
    const confirmationShown = panel.role === 'alertdialog' && !!start && !!cancel;
    cancel.click();
    await generation;
    return { calls, controller, hooks, minimumRequestCount, displayedEstimate, confirmationShown };
  }

  const description = await waitFor(() => {
    const element = document.modal.find(
      (candidate) => candidate.id === 'enrichPreCountDescription');
    return element && element.textContent === expectedEstimate ? element : null;
  });
  const displayedEstimate = description.textContent;
  start.click();
  await generation;

  return { calls, controller, hooks, minimumRequestCount, displayedEstimate };
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

async function runCase(name, body) {
  try {
    check(name, await body());
  } catch (error) {
    fail++;
    console.log(`  FAIL ${name} (${error.message})`);
  }
}

async function run() {
  console.log('cache-hit generation path');
  const cacheRecords = [
    makeRecord('cache-1', 'Cache Channel 1', 'Cached Song 1'),
    makeRecord('cache-2', 'Cache Channel 2', 'Cached Song 2'),
  ];
  const cache = await exerciseGeneration({
    records: cacheRecords,
    rules: [],
    cachedVideoIds: cacheRecords.map((record) => record.videoId),
  });
  check('REQ-1 cache-hit generation has minimum 0 and actual MusicBrainz communication 0',
    cache.minimumRequestCount === 0 && cache.calls.mb === 0);
  check('REQ-1 cache-hit values came from the real cached MB candidate path',
    cache.controller.getAllCandidates().length === 2
      && cache.controller.getAllCandidates().every((candidate) => candidate.source === 'mb'));
  check('REQ-5 cache-hit confirmation displays a 0-side duration lower bound',
    cache.displayedEstimate.includes('推定所要時間 約0〜12分'));

  console.log('\nrule-only generation path');
  const ruleRecords = [
    makeRecord('rule-1', 'Rule Channel', 'Rule Song 1'),
    makeRecord('rule-2', 'Rule Channel', 'Rule Song 2'),
  ];
  const ruleOnly = await exerciseGeneration({
    records: ruleRecords,
    rules: [{ channel: 'Rule Channel', arranger: 'Local Rule Arranger', evidence: 'test rule' }],
  });
  check('REQ-2 rule-only generation has minimum 0 and actual MusicBrainz communication 0',
    ruleOnly.minimumRequestCount === 0 && ruleOnly.calls.mb === 0);
  check('REQ-2 rule-only values came from the real local-rule candidate path',
    ruleOnly.controller.getAllCandidates().length === 2
      && ruleOnly.controller.getAllCandidates().every((candidate) => candidate.source === 'rule'));
  check('REQ-5 rule-only confirmation displays a 0-side duration lower bound',
    ruleOnly.displayedEstimate.includes('推定所要時間 約0〜12分'));

  console.log('\nmixed generation paths');
  const mixedRecords = [
    makeRecord('mixed-rule', 'Mixed Rule Channel', 'Mixed Rule Song'),
    makeRecord('mixed-cache', 'Mixed Cache Channel', 'Mixed Cached Song'),
    makeRecord('mixed-network', 'Mixed Network Channel', 'Mixed Network Song'),
  ];
  const mixed = await exerciseGeneration({
    records: mixedRecords,
    rules: [{ channel: 'Mixed Rule Channel', arranger: 'Mixed Rule Arranger' }],
    cachedVideoIds: ['mixed-cache'],
  });
  check('REQ-3 mixed generation minimum equals the one actual MusicBrainz communication',
    mixed.minimumRequestCount === 1 && mixed.calls.mb === 1);
  check('REQ-3 mixed generation ran rule, cached-MB, and network-MB candidate paths',
    mixed.controller.getAllCandidates().length === 3
      && mixed.controller.getAllCandidates().filter((candidate) => candidate.source === 'rule').length === 1
      && mixed.controller.getAllCandidates().filter((candidate) => candidate.source === 'mb').length === 2);
  check('REQ-3 mixed confirmation uses the communicating-video count for its lower bound',
    mixed.displayedEstimate.includes('推定所要時間 約1〜18分'));

  const legacyBounds = mixed.hooks.estimateEnrichmentMinutes(3, 60000);
  const adjustedBounds = mixed.hooks.estimateEnrichmentMinutes(3, 60000, 1);
  check('REQ-4 maximum duration is unchanged between legacy/default and adjusted minimum inputs',
    legacyBounds.maxMinutes === 18 && adjustedBounds.maxMinutes === 18);
  check('REQ-4 confirmation keeps the unchanged maximum request count and maximum duration',
    mixed.displayedEstimate.includes('約1〜18分')
      && mixed.displayedEstimate.includes('最大 約18 回の通信'));

  check('all generation cases loaded local rules once and requested config once',
    [cache, ruleOnly, mixed].every((result) => result.calls.localRuleFetch === 1 && result.calls.config === 1));

  console.log('\nfailed local-rule load confirmation path');
  let failedRuleLoad = null;
  await runCase('REQ-D failed rule load still shows the accessible confirmation dialog', async () => {
    failedRuleLoad = await exerciseGeneration({
      records: [makeRecord('rules-fail', 'Unavailable Rule Channel', 'Fallback Estimate Song')],
      rules: [],
      ruleLoadFails: true,
    });
    return failedRuleLoad.confirmationShown === true && failedRuleLoad.calls.localRuleFetch === 1;
  });
  if (failedRuleLoad) {
    check('REQ-D failed rule load keeps the legacy one-request-per-video estimate lower bound',
      failedRuleLoad.displayedEstimate.includes('推定所要時間 約1〜6分'));
    check('REQ-D failed rule load confirmation remains cancelable without MusicBrainz communication',
      failedRuleLoad.calls.mb === 0 && failedRuleLoad.controller.confirmingGeneration === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

run().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 1;
});
