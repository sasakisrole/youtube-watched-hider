'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../official_search_filter_core.js');

const ROOT = path.join(__dirname, '..');
const SETTINGS_TEST_PATH = path.join(
  __dirname,
  'verify_official_search_filter_settings.js'
);
const settingsSource = fs.readFileSync(SETTINGS_TEST_PATH, 'utf8');
const helperSource = settingsSource.slice(
  0,
  settingsSource.lastIndexOf('\nasync function main() {')
);
const helpers = new Function(
  'require',
  '__dirname',
  `${helperSource}\nreturn { createStorageStub, boundSettings, makeRuntime, panel, settle };`
)(require, __dirname);
const {
  createStorageStub,
  boundSettings,
  makeRuntime,
  panel,
  settle,
} = helpers;

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

function installCreditRpc(storage, creditsByVideoId) {
  const calls = [];
  storage.chrome.runtime.sendMessage = (message, callback) => {
    calls.push(JSON.parse(JSON.stringify(message)));
    callback({ success: true, result: creditsByVideoId });
  };
  return calls;
}

function trackStorageWrites(storage) {
  let writes = 0;
  const originalSet = storage.chrome.storage.local.set;
  storage.chrome.storage.local.set = (...args) => {
    writes += 1;
    return originalSet(...args);
  };
  return () => writes;
}

function loadWatchedDbForCredits(records) {
  let transactions = 0;
  let gets = 0;
  const transactionModes = [];
  const db = {
    transaction(_storeName, mode) {
      transactions += 1;
      transactionModes.push(mode);
      const tx = {};
      let completionScheduled = false;
      const store = {
        get(videoId) {
          gets += 1;
          const request = {};
          setImmediate(() => {
            request.result = records[videoId];
            request.onsuccess?.();
            if (!completionScheduled) {
              completionScheduled = true;
              setImmediate(() => tx.oncomplete?.());
            }
          });
          return request;
        },
      };
      tx.objectStore = () => store;
      return tx;
    },
  };
  const indexedDB = {
    open() {
      const request = {};
      setImmediate(() => {
        request.result = db;
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const watchedDb = new Function(
    'indexedDB',
    'globalThis',
    `${dbSource}\nreturn WatchedDB;`
  )(indexedDB, {});
  return {
    watchedDb,
    counts: () => ({ transactions, gets, transactionModes }),
  };
}

async function main() {
  console.log('active and effective profile separation');
  {
    const activeOnly = boundSettings('official');
    activeOnly.queryBindings = {};
    const storage = createStorageStub(activeOnly);
    const rpcCalls = installCreditRpc(storage, {
      official: { composer: 'Artist' },
    });
    const runtime = makeRuntime(storage);
    await settle();
    await settle();

    check('REQ-1 unbound query uses active profile aliases for candidates',
      rpcCalls.length === 1 &&
      panel(runtime).querySelectorAll('[data-credit-candidate]').length === 1 &&
      panel(runtime).querySelector('[data-credit-candidate]')
        .textContent.includes('/@artist'));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const activeAndEffective = {
      ...boundSettings('official'),
      activeProfileId: 'alpha',
      profiles: {
        alpha: {
          id: 'alpha',
          displayName: 'Alpha',
          aliases: [],
          channels: [],
          mode: 'official',
        },
        beta: {
          id: 'beta',
          displayName: 'Beta',
          aliases: [],
          channels: [],
          mode: 'official',
        },
      },
      queryBindings: { 'artist - topic': 'beta' },
    };
    const storage = createStorageStub(activeAndEffective);
    const rpcCalls = installCreditRpc(storage, {
      official: { composer: 'Alpha' },
    });
    const runtime = makeRuntime(storage);
    await settle();
    await settle();

    check('REQ-2 active-only credit creates a candidate but not a related classification',
      panel(runtime).querySelectorAll('[data-credit-candidate]').length === 1 &&
      panel(runtime).querySelector('[data-count="credit-related"]')
        .textContent === '0');
    check('REQ-4 differing active and effective profiles use one credit RPC',
      rpcCalls.length === 1 &&
      rpcCalls[0].op === 'GET_CREDITS_FOR_VIDEO_IDS');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('batched credit lookup and candidate presentation');
  {
    const storage = createStorageStub(boundSettings('official'));
    const rpcCalls = installCreditRpc(storage, {
      official: { composer: 'ＡＲＴＩＳＴ' },
      other: { lyricist: 'Someone Else' },
    });
    const getWrites = trackStorageWrites(storage);
    const runtime = makeRuntime(storage);
    await settle();
    await settle();

    check('REQ-3 identical active and effective profiles use one credit RPC',
      rpcCalls.length === 1 &&
      rpcCalls[0].type === 'DB_RPC' &&
      rpcCalls[0].op === 'GET_CREDITS_FOR_VIDEO_IDS' &&
      JSON.stringify(rpcCalls[0].videoIds) ===
        JSON.stringify(['official', 'other', 'other-topic']));

    const candidate = panel(runtime).querySelector('[data-credit-candidate]');
    const reason = panel(runtime).querySelector('[data-credit-candidate-reason]');
    check('(b) NFKC-normalized creditAliases match is presented as a candidate',
      Boolean(candidate) &&
      candidate.textContent.includes('/@artist') &&
      reason.textContent.includes('正規化一致') &&
      reason.textContent.includes('ＡＲＴＩＳＴ'));
    check('(b) matched card is wired to CREDIT_RELATED classification',
      panel(runtime).querySelector('[data-count="credit-related"]').textContent === '1' &&
      !runtime.cards.official.classList.contains('ywh-osf-hidden'));

    const rawMatch = core.inferCreditChannelCandidates({
      items: [{
        videoId: 'raw',
        channel: {
          canonicalPath: '/@raw-candidate',
          displayName: 'Raw Credit Candidate',
        },
      }],
      creditsByVideoId: {
        raw: { creditsRaw: 'Someone Else · ＡＲＴＩＳＴ' },
      },
      creditAliases: ['artist'],
    });
    check('(b) creditsRaw is used as candidate evidence',
      rawMatch.candidates.length === 1 &&
      rawMatch.relatedVideoIds[0] === 'raw' &&
      rawMatch.candidates[0].reasons[0].includes('未割当クレジット'));

    let registrationCalls = 0;
    const inferredCandidate = core.inferCreditChannelCandidates({
      items: [{
        videoId: 'v1',
        channel: {
          canonicalPath: '/@candidate',
          displayName: 'Artist Official',
        },
      }],
      creditsByVideoId: { v1: { composer: 'Ａｒｔｉｓｔ' } },
      creditAliases: ['artist'],
    }).candidates[0];
    const adoptedWithoutConsent = core.adoptCreditCandidate({
      candidate: inferredCandidate,
      userAccepted: undefined,
      register: () => { registrationCalls += 1; },
    });
    check('REQ-5 userAccepted !== true calls the registration function zero times',
      adoptedWithoutConsent === false && registrationCalls === 0);

    panel(runtime).querySelector('[data-credit-candidate-prepare]')?.click();
    await settle();
    check('(c) viewing a candidate does not persist or register it',
      getWrites() === 0 &&
      storage.store.officialSearchFilter.profiles.artist.channels.length === 0 &&
      panel(runtime).querySelector('[data-channel-target]')
        .textContent.includes('根拠:'));

    const nameOnly = core.inferCreditChannelCandidates({
      items: [{
        videoId: 'name-only',
        channel: {
          canonicalPath: '/@artist-name-only',
          displayName: 'Artist Official Channel',
        },
      }],
      creditsByVideoId: { 'name-only': { composer: 'Different Person' } },
      creditAliases: ['artist'],
    });
    let nameOnlyRegistrationCalls = 0;
    const nameOnlyAdopted = core.adoptCreditCandidate({
      candidate: {
        channel: {
          canonicalPath: '/@artist-name-only',
          displayName: 'Artist Official Channel',
        },
        reasons: ['名前一致・検索クエリ部分一致だけ'],
      },
      userAccepted: false,
      register: () => { nameOnlyRegistrationCalls += 1; },
    });
    check('(d) name or partial-query match alone creates no credit candidate',
      nameOnly.candidates.length === 0 &&
      nameOnly.relatedVideoIds.length === 0);
    check('(d) name-only evidence is never auto-confirmed',
      nameOnlyAdopted === false && nameOnlyRegistrationCalls === 0);

    panel(runtime).querySelector('[data-channel-confirm]').click();
    await settle();
    check('explicit candidate confirmation is the only step that registers',
      getWrites() === 1 &&
      storage.store.officialSearchFilter.profiles.artist.channels.length === 1 &&
      storage.store.officialSearchFilter.profiles.artist.channels[0]
        .canonicalPath === '/@artist');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('no-credit regression');
  {
    const storage = createStorageStub(boundSettings('official'));
    const rpcCalls = installCreditRpc(storage, {});
    const getWrites = trackStorageWrites(storage);
    const runtime = makeRuntime(storage);
    await settle();
    await settle();

    check('(e) no-credit results still use one batch and yield no candidates',
      rpcCalls.length === 1 &&
      panel(runtime).querySelectorAll('[data-credit-candidate]').length === 0 &&
      panel(runtime).querySelector('[data-count="credit-related"]')
        .textContent === '0');
    check('(e) no-credit results preserve prior filtering and make no writes',
      runtime.cards.official.classList.contains('ywh-osf-hidden') &&
      runtime.cards.other.classList.contains('ywh-osf-hidden') &&
      runtime.cards.otherTopic.classList.contains('ywh-osf-hidden') &&
      getWrites() === 0 &&
      storage.store.officialSearchFilter.profiles.artist.channels.length === 0);
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('DB batch read');
  {
    const rawAtLimit = 'x'.repeat(4096);
    const rawOverLimit = 'y'.repeat(4097);
    const fixture = loadWatchedDbForCredits({
      v1: {
        videoId: 'v1',
        composer: ' Alice ',
        lyricist: '',
        arranger: 'Bob',
        creditsRaw: ' Carol · Dave ',
        title: 'not returned',
      },
      v2: {
        videoId: 'v2',
        composer: '',
        lyricist: '',
        arranger: '',
        creditsRaw: 'Raw Person',
      },
      v3: { videoId: 'v3', creditsRaw: rawAtLimit },
      v4: { videoId: 'v4', creditsRaw: rawOverLimit },
    });
    const result = await fixture.watchedDb.getCreditsForVideoIds([
      'v1',
      'v2',
      'v3',
      'v4',
      'v1',
      'missing',
    ]);
    const counts = fixture.counts();
    check('DB batch dedupes ids and uses one readonly transaction',
      counts.transactions === 1 &&
      counts.gets === 5 &&
      JSON.stringify(counts.transactionModes) === JSON.stringify(['readonly']));
    check('DB batch returns nonblank roles and creditsRaw keyed by videoId',
      JSON.stringify(result.v1) === JSON.stringify({
        composer: 'Alice',
        arranger: 'Bob',
        creditsRaw: 'Carol · Dave',
      }) &&
      JSON.stringify(result.v2) === JSON.stringify({
        creditsRaw: 'Raw Person',
      }));
    check('DB batch preserves creditsRaw at the 4096-unit boundary',
      result.v3.creditsRaw === rawAtLimit);
    check('DB batch truncates creditsRaw beyond the 4096-unit boundary',
      result.v4.creditsRaw === 'y'.repeat(4096));
  }

  const offscreenSource = fs.readFileSync(
    path.join(ROOT, 'offscreen.js'),
    'utf8'
  );
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  check('bulk RPC is routed to one DB batch method',
    offscreenSource.includes("case 'GET_CREDITS_FOR_VIDEO_IDS':") &&
    offscreenSource.includes(
      'WatchedDB.getCreditsForVideoIds(message.videoIds || [])'
    ) &&
    dbSource.includes('async function getCreditsForVideoIds(videoIds)'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
