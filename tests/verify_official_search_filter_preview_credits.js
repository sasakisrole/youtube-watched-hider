'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../official_search_filter_core.js');

const ROOT = path.join(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const filterSource = fs.readFileSync(path.join(ROOT, 'official_search_filter.js'), 'utf8');
const settingsSource = fs.readFileSync(
  path.join(__dirname, 'verify_official_search_filter_settings.js'),
  'utf8'
);
const helperSource = settingsSource.slice(
  0,
  settingsSource.lastIndexOf('\nasync function main() {')
);
const { createStorageStub, boundSettings, makeRuntime, panel, settle } = new Function(
  'require',
  '__dirname',
  `${helperSource}\nreturn { createStorageStub, boundSettings, makeRuntime, panel, settle };`
)(require, __dirname);

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

function youtubeResult(videoId, extra = {}) {
  return {
    videoId,
    ok: true,
    credits: { composer: '', lyricist: '', arranger: '', creditsRaw: '' },
    title: `Title ${videoId}`,
    artist: 'Artist - Topic',
    ...extra,
  };
}

function createService(overrides = {}) {
  const counters = { fetches: 0, writes: 0, watchedWrites: 0 };
  let cache = {};
  const service = core.createPreviewCreditsService({
    fetchYouTubeCredits: async (videoId, signal) => {
      counters.fetches += 1;
      return overrides.fetch
        ? overrides.fetch(videoId, signal, counters.fetches)
        : youtubeResult(videoId);
    },
    lookupMusicBrainz: overrides.musicbrainz,
    readCache: async () => ({ ...cache }),
    writeCache: async (next) => {
      counters.writes += 1;
      cache = JSON.parse(JSON.stringify(next));
    },
    now: overrides.now || (() => 1_000_000),
  });
  return { service, counters, cache: () => cache };
}

async function main() {
  console.log('explicit-only gate and UI');
  {
    const test = createService();
    const response = await test.service.start({
      videoIds: ['v1'],
      options: { persistToHistory: false },
      explicitUserAction: false,
    });
    check('without an explicit action, fetch and cache writes are both zero',
      response.reason === 'explicit-user-action-required' &&
      test.counters.fetches === 0 && test.counters.writes === 0);
  }
  {
    const storage = createStorageStub(boundSettings('official'));
    let storageWrites = 0;
    let previewCalls = 0;
    let previewMessage = null;
    const originalSet = storage.chrome.storage.local.set;
    storage.chrome.storage.local.set = (...args) => {
      storageWrites += 1;
      return originalSet(...args);
    };
    storage.chrome.runtime.sendMessage = (message, callback) => {
      if (message.type === 'DB_RPC') {
        callback({ success: true, result: {} });
        return;
      }
      if (message.type === 'PREVIEW_VIDEO_CREDITS') {
        previewCalls += 1;
        previewMessage = JSON.parse(JSON.stringify(message));
        callback({
          ok: true,
          processed: 1,
          total: 1,
          persistToHistory: false,
          results: {
            'other-topic': {
              status: 'partial',
              credits: { composer: 'Artist', lyricist: '', arranger: '', creditsRaw: '' },
              evidence: [],
            },
          },
        });
        return;
      }
      callback({ ok: false });
    };
    const runtime = makeRuntime(storage);
    await settle();
    await settle();
    const button = panel(runtime).querySelector('[data-preview-credits-start]');
    check('loading and scanning the panel never starts preview or writes storage',
      previewCalls === 0 && storageWrites === 0 &&
      button.textContent === '他Topic 1件をクレジット確認');
    button.click();
    await settle();
    await settle();
    check('the visible button click is the only path that sends PREVIEW_VIDEO_CREDITS',
      previewCalls === 1 &&
      previewMessage.options.userInitiated === true &&
      previewMessage.options.persistToHistory === false &&
      JSON.stringify(previewMessage.videoIds) === JSON.stringify(['other-topic']));
    check('preview response is rendered in the panel',
      panel(runtime).querySelector('[data-preview-credits-results]')
        .textContent.includes('composer: Artist'));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('batch limit, single flight, cancellation, and abnormal stop');
  {
    const test = createService();
    const ids = Array.from({ length: 25 }, (_, index) => `v${index + 1}`);
    const response = await test.service.start({
      videoIds: ids,
      options: { persistToHistory: false, sources: ['youtube'] },
      explicitUserAction: true,
    });
    check('25 requested videos are hard-capped at 20 processed fetches',
      response.total === 20 && response.processed === 20 && test.counters.fetches === 20);
  }
  {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const test = createService({
      fetch: (videoId, _signal, count) => count === 1 ? blocked : youtubeResult(videoId),
    });
    const first = test.service.start({ videoIds: ['one'], explicitUserAction: true });
    const second = await test.service.start({ videoIds: ['two'], explicitUserAction: true });
    check('a second active request is rejected and does not fetch',
      second.reason === 'already-running' && test.counters.fetches === 1);
    release(youtubeResult('one'));
    await first;
  }
  {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const test = createService({ fetch: () => blocked });
    const running = test.service.start({
      videoIds: ['one', 'two', 'three'],
      explicitUserAction: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const accepted = test.service.cancel();
    release(youtubeResult('one'));
    const response = await running;
    check('cancel prevents every later acquisition',
      accepted === true && response.aborted === true && test.counters.fetches === 1);
  }
  {
    const test = createService({
      fetch: (videoId, _signal, count) => count === 1
        ? { videoId, ok: false, reason: 'sorry-redirect' }
        : youtubeResult(videoId),
    });
    const response = await test.service.start({
      videoIds: ['one', 'two', 'three'],
      explicitUserAction: true,
    });
    check('sorry redirect is persisted by kind and stops the batch immediately',
      response.autoStopped === true && response.processed === 1 &&
      test.counters.fetches === 1 && test.counters.writes === 1 &&
      response.results.one.error.kind === 'sorry-redirect' &&
      test.cache().one.result.error.kind === 'sorry-redirect');
  }

  console.log('cache and watched-DB isolation');
  {
    const test = createService();
    const args = { videoIds: ['cached'], explicitUserAction: true };
    await test.service.start(args);
    const response = await test.service.start(args);
    check('a fresh cached result avoids a second fetch and storage rewrite',
      test.counters.fetches === 1 && test.counters.writes === 1 &&
      response.results.cached.cached === true);
  }
  {
    const handler = backgroundSource.slice(
      backgroundSource.indexOf("if (message.type === 'PREVIEW_VIDEO_CREDITS')"),
      backgroundSource.indexOf("if (message.type === 'V135_CONTENT_READY')")
    );
    const serviceWiring = backgroundSource.slice(
      backgroundSource.indexOf("const PREVIEW_CREDITS_CACHE_KEY"),
      backgroundSource.indexOf('async function fixDurationsBatch')
    );
    check('preview handler enforces non-persistence and has no watched DB call',
      handler.includes("options.persistToHistory !== false") &&
      handler.includes('options.userInitiated === true') &&
      !handler.includes('sendToOffscreenDb'));
    check('preview acquisition is wired only to existing shared queue/rate-limited helpers',
      serviceWiring.includes('fetchYouTubeCredits: fetchCreditsFromWatch') &&
      serviceWiring.includes('lookupMusicBrainz: enrichCreditsLookupMb') &&
      !serviceWiring.includes('sendToOffscreenDb') &&
      !serviceWiring.includes('fetch('));
    check('preview service response explicitly reports no history persistence',
      filterSource.includes('persistToHistory: false') &&
      backgroundSource.includes("type === 'PREVIEW_VIDEO_CREDITS'"));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
