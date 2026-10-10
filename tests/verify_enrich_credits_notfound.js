const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const CT = require('../credit_target.js');
const dbSource = read('db.js');
const uiSource = read('enrich_credits.js');
const fakeSource = read('tests/verify_mb_cooldown.js');
const makeFake = new Function('setImmediate', fakeSource.slice(fakeSource.indexOf('function makeFake('), fakeSource.indexOf('async function testRecordMbLookup')) + '\nreturn makeFake;')(setImmediate);
const copy = value => JSON.parse(JSON.stringify(value));
const video = id => ({ videoId: id, title: 'Song ' + id, channel: 'Artist - Topic', composer: 'A', lyricist: '', arranger: 'A', creditsRaw: 'Composer: A' });

function harness(records, response = { success: true, reason: 'no-roles' }, api = CT) {
  const fakes = new Map(records.map(record => [record.videoId, makeFake(copy(record))]));
  const dbs = new Map([...fakes].map(([id, fake]) => [id, new Function('indexedDB', 'globalThis', dbSource + '\nreturn WatchedDB;')(fake.indexedDB, { CreditTarget: api })]));
  let calls = 0;
  const win = { CreditTarget: api };
  const doc = { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] };
  const chrome = { runtime: { lastError: null, sendMessage(message, done) {
    if (message.type === 'getEnrichCreditsConfig') return done({ success: true, rateLimitMs: 1 });
    if (message.op === 'RECORD_MB_LOOKUP') {
      return dbs.get(message.videoId).recordMbLookup(message.videoId, message)
        .then(result => done({ success: true, result }), error => done({ success: false, error: error.message }));
    }
    throw new Error('Unexpected message ' + JSON.stringify(message));
  } } };
  new Function('window', 'document', 'chrome', uiSource)(win, doc, chrome);
  const controller = win.EnrichCredits.create({ getRecords: () => records });
  controller.rules = [];
  controller.confirmGeneration = async () => ({ limit: null, ignoreCooldown: false });
  controller.fetchMb = async (...args) => {
    calls++;
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(controller, ...args) : response;
  };
  const saved = id => copy(fakes.get(id).watched.get(id));
  return { controller, hooks: win.EnrichCreditsTestHooks, saved, dbs, records, get calls() { return calls; } };
}

async function negative(id = 'negative', response) {
  const h = harness([video(id)], response);
  await h.controller.generateCandidates();
  assert.equal(h.calls, 1, 'lookup must actually run');
  assert.deepEqual(h.controller.errors, []);
  return { h, record: h.saved(id) };
}

const cases = {
  async 'REQ-1 no-result disappears from targets, estimates and limited slots'() {
    for (const response of [
      { success: true, reason: 'no-roles' },
      { success: true, reason: 'no-recording' },
      { success: true, candidate: { composer: 'A', arranger: 'A', mbTitle: 'Song negative', sim: 1 } },
    ]) {
      const { h, record } = await negative('negative', response);
      assert.equal(h.hooks.needsCreditEnrichment(record), false);
      assert.equal(h.hooks.getEnrichmentPreCount([record]).videoCount, 0);
      assert.equal(h.hooks.needsCreditEnrichment(h.records[0]), false, 'open page snapshot must also update');
      const fresh = video('fresh');
      const groups = h.controller.groupUnassigned([record, fresh]);
      const limited = h.hooks.limitEnrichmentGroupsByDue(groups, 1, h.hooks.createMbDueCheck(null, true, Date.now()));
      assert.deepEqual([...limited.values()].flat().map(r => r.videoId), ['fresh']);
      assert.equal(h.hooks.getMinimumEnrichmentRequestCount(h.controller.groupUnassigned([record]), [], new Map(), []), 0);
      await h.controller.generateCandidates();
      assert.equal(h.calls, 1);
      assert.equal(CT.shouldQueryMb(record, { ignoreCooldown: true, now: Date.now() + 100 * 86400000 }), false);
    }
  },
  async 'REQ-2 rule version invalidates the stamp and bypasses old cooldown'() {
    const { h: original, record } = await negative();
    const root = {};
    const source = read('credit_target.js').replace('var ENRICHMENT_RULE_VERSION = 1;', 'var ENRICHMENT_RULE_VERSION = 2;');
    new Function('globalThis', source)(root);
    const h = harness([record], undefined, root.CreditTarget);
    assert.equal(original.hooks.needsCreditEnrichment(record), false);
    assert.equal(h.hooks.needsCreditEnrichment(record), true);
    assert.equal(h.hooks.getEnrichmentPreCount([record]).videoCount, 1);
    await h.controller.generateCandidates();
    assert.equal(h.calls, 1, 'old cooldown must not prevent a new-version lookup');
    assert.equal(h.saved(record.videoId).mbLookup.notFound.version, 2);
  },
  async 'REQ-3 each stored field invalidates the stamp even inside cooldown'() {
    const { h: original, record } = await negative();
    assert.equal(original.hooks.needsCreditEnrichment(record), false);
    for (const field of ['composer', 'lyricist', 'arranger', 'creditsRaw']) {
      const changed = copy(record);
      changed[field] = field === 'lyricist' ? ' ' : changed[field] + ' changed';
      const h = harness([changed]);
      assert.equal(h.hooks.needsCreditEnrichment(changed), true, field);
      assert.equal(h.hooks.getEnrichmentPreCount([changed]).videoCount, 1, field);
      await h.controller.generateCandidates();
      assert.equal(h.calls, 1, field);
    }
  },
  async 'REQ-4 only completed zero-progress searches are excluded'() {
    const { h: control, record } = await negative();
    assert.equal(control.hooks.needsCreditEnrichment(record), false, 'negative control establishes selective exclusion');
    for (const response of [new Error('offline'), { success: true, candidate: { lyricist: 'B', mbTitle: 'Song partial', sim: 1 } }]) {
      const h = harness([{ ...video('partial'), arranger: '' }], response);
      await h.controller.generateCandidates();
      const saved = h.saved('partial');
      assert.equal(saved.mbLookup.notFound, undefined);
      assert.equal(h.hooks.needsCreditEnrichment(saved), true);
      assert.equal(h.hooks.getEnrichmentPreCount([saved]).videoCount, 1);
      if (!(response instanceof Error)) {
        assert.equal(h.controller.getAllCandidates().length, 1);
        await h.dbs.get('partial').updateCredits('partial', { lyricist: 'B' }, false, 'enrich:mb');
        assert.equal(h.saved('partial').lyricist, 'B');
        assert.equal(h.hooks.needsCreditEnrichment(h.saved('partial')), true, 'saved partial progress remains a target');
      }
    }
    const h = harness([{ ...video('local'), composer: '' }]);
    h.controller.rules = [{ channel: 'Artist - Topic', composer: 'Rule A' }];
    await h.controller.generateCandidates();
    assert.equal(h.saved('local').mbLookup.notFound, undefined, 'local partial progress must not be suppressed');
  },
  async 'cancellation, stale writes and failed persistence never exclude'() {
    const h = harness([video('cancel')], controller => { controller.abortRequested = true; return { success: true, reason: 'no-roles' }; });
    await h.controller.generateCandidates();
    assert.equal(h.saved('cancel').mbLookup, undefined);
    const stale = harness([video('stale')]);
    const original = stale.dbs.get('stale').recordMbLookup;
    stale.dbs.get('stale').recordMbLookup = async (id, details) => original(id, { ...details, notFound: { ...details.notFound, snapshot: 'stale' } });
    await stale.controller.generateCandidates();
    assert.equal(stale.saved('stale').mbLookup, undefined);
    assert.equal(stale.hooks.needsCreditEnrichment(stale.records[0]), true);
    const failed = harness([video('fail')]);
    failed.dbs.get('fail').recordMbLookup = async () => { throw new Error('write failed'); };
    await failed.controller.generateCandidates();
    assert.equal(failed.hooks.needsCreditEnrichment(failed.records[0]), true);
  },
  async 'identity edits reopen search; donor pass respects per-video exclusion'() {
    const { h, record } = await negative();
    for (const key of ['title', 'channel']) {
      const changed = { ...record, [key]: record[key] + ' changed' };
      assert.equal(h.hooks.needsCreditEnrichment(changed), true);
      assert.equal(CT.shouldQueryMb(changed, {}), true);
    }
    record.durationSec = 180;
    const donor = { ...record, videoId: 'donor', lyricist: 'B', mbLookup: undefined };
    const records = [record, donor];
    const index = h.hooks.createSameSongDonorIndex(records);
    assert.equal(h.hooks.collectSameSongDonorCandidates(records, index).length, 0);
    const changed = { ...record, creditsRaw: record.creditsRaw + ' changed' };
    assert.equal(h.hooks.collectSameSongDonorCandidates([changed, donor], index).length, 1);
    assert.equal(CT.getCreditReviewStates(record, {}).lyricist.state, 'unresolved');
  },
  async 'metadata survives import normalization without changing role values'() {
    const { h, record } = await negative();
    await h.dbs.get(record.videoId).importData([record]);
    const normalized = h.saved(record.videoId);
    assert.deepEqual(normalized.mbLookup.notFound, record.mbLookup.notFound);
    assert.equal(h.hooks.needsCreditEnrichment(normalized), false);
    const staleVersion = copy(record);
    staleVersion.mbLookup.notFound.version += 1;
    await h.dbs.get(record.videoId).importData([staleVersion]);
    assert.equal(h.hooks.needsCreditEnrichment(h.saved(record.videoId)), true);
    assert.equal(CT.shouldQueryMb(h.saved(record.videoId), {}), true, 'import preserves stale version to bypass old cooldown');
    for (const key of ['composer', 'lyricist', 'arranger', 'creditsRaw']) assert.equal(record[key], video('negative')[key]);
    assert.match(read('offscreen.js'), /notFound: message\.notFound/);
  },
};

(async () => {
  let failed = 0;
  for (const [name, run] of Object.entries(cases)) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`${Object.keys(cases).length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
