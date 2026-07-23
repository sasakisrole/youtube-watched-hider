'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../official_search_filter_core.js');

const STORAGE_KEY = 'officialSearchFilter';
const SETTINGS_TEST_PATH = path.join(
  __dirname,
  'verify_official_search_filter_settings.js'
);
const settingsTestSource = fs.readFileSync(SETTINGS_TEST_PATH, 'utf8');
const helperSource = settingsTestSource.slice(
  0,
  settingsTestSource.lastIndexOf('\nasync function main() {')
);
const helpers = new Function(
  'require',
  '__dirname',
  `${helperSource}\nreturn {
    createStorageStub,
    loadRuntime,
    createCard,
    MutationObserverStub,
    settle,
  };`
)(require, __dirname);
const {
  createStorageStub,
  loadRuntime,
  createCard,
  MutationObserverStub,
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function settings({
  alphaMode = 'official',
  betaMode = 'official',
  globalMode = 'all',
  queryBindings = {
    'matrix query': 'alpha',
    'second query': 'alpha',
  },
} = {}) {
  return {
    schemaVersion: 1,
    activeProfileId: 'alpha',
    globalMode,
    profiles: {
      alpha: {
        id: 'alpha',
        displayName: 'Alpha',
        aliases: [],
        channels: [{
          channelId: 'UC_OFFICIAL',
          canonicalPath: '/channel/UC_OFFICIAL',
          displayName: 'Official Source',
          enabled: true,
        }],
        mode: alphaMode,
      },
      beta: {
        id: 'beta',
        displayName: 'Beta',
        aliases: [],
        channels: [],
        mode: betaMode,
      },
    },
    queryBindings,
  };
}

const runtimeCore = {
  ...core,
  classifyChannel(args) {
    if (args.channel?.channelId === 'UC_CREDIT') {
      return core.CATEGORY.CREDIT_RELATED;
    }
    return core.classifyChannel(args);
  },
};

function setQuery(runtime, query) {
  runtime.location.pathname = '/results';
  runtime.location.href =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function makeRuntime(storage, query = 'matrix query') {
  const runtime = loadRuntime();
  runtime.context.chrome = storage.chrome;
  runtime.context.YWHOfficialSearchFilterCore = runtimeCore;
  setQuery(runtime, query);

  const results = runtime.document.createElement('main');
  runtime.document.body.appendChild(results);
  const cards = {
    [core.CATEGORY.OFFICIAL]: createCard(
      runtime.document,
      'official',
      '/channel/UC_OFFICIAL',
      'Official Source'
    ),
    [core.CATEGORY.CREDIT_RELATED]: createCard(
      runtime.document,
      'credit',
      '/channel/UC_CREDIT',
      'Credit Source'
    ),
    [core.CATEGORY.OTHER_TOPIC]: createCard(
      runtime.document,
      'topic',
      '/channel/UC_TOPIC',
      'Release - Topic'
    ),
    [core.CATEGORY.OTHER]: createCard(
      runtime.document,
      'other',
      '/channel/UC_OTHER',
      'Other Source'
    ),
    [core.CATEGORY.PENDING]: createCard(
      runtime.document,
      'pending',
      '',
      ''
    ),
  };
  Object.values(cards).forEach((card) => results.appendChild(card));
  runtime.run();
  return { ...runtime, results, cards };
}

function panel(runtime) {
  return runtime.document.getElementById('ywh-osf-panel');
}

function control(runtime, selector) {
  return panel(runtime)?.querySelector(selector) || null;
}

function isShown(card) {
  return !card.classList.contains('ywh-osf-hidden');
}

function count(runtime, category) {
  return Number(control(runtime, `[data-count="${category}"]`).textContent);
}

function countSnapshot(runtime) {
  return JSON.stringify({
    categories: Object.fromEntries(
      Object.values(core.CATEGORY).map((category) => [
        category,
        count(runtime, category),
      ])
    ),
    visible: control(runtime, '[data-count-visible]').textContent,
    total: control(runtime, '[data-count-total]').textContent,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function main() {
  console.log('exact three-mode matrix');
  const expected = {
    [core.MODE.OFFICIAL]: {
      [core.CATEGORY.OFFICIAL]: true,
      [core.CATEGORY.CREDIT_RELATED]: true,
      [core.CATEGORY.OTHER_TOPIC]: false,
      [core.CATEGORY.OTHER]: false,
      [core.CATEGORY.PENDING]: true,
    },
    [core.MODE.DISCOVERY]: {
      [core.CATEGORY.OFFICIAL]: true,
      [core.CATEGORY.CREDIT_RELATED]: true,
      [core.CATEGORY.OTHER_TOPIC]: true,
      [core.CATEGORY.OTHER]: false,
      [core.CATEGORY.PENDING]: true,
    },
    [core.MODE.ALL]: {
      [core.CATEGORY.OFFICIAL]: true,
      [core.CATEGORY.CREDIT_RELATED]: true,
      [core.CATEGORY.OTHER_TOPIC]: true,
      [core.CATEGORY.OTHER]: true,
      [core.CATEGORY.PENDING]: true,
    },
  };
  for (const mode of Object.values(core.MODE)) {
    for (const category of Object.values(core.CATEGORY)) {
      check(
        `core matrix ${mode} / ${category}`,
        core.shouldShowCategory(category, mode) === expected[mode][category]
      );
    }
  }

  {
    const storage = createStorageStub(settings());
    const runtime = makeRuntime(storage);
    await settle();
    for (const mode of Object.values(core.MODE)) {
      control(runtime, `[data-mode="${mode}"]`).click();
      await settle();
      check(
        `runtime ${mode} exactly follows core.shouldShowCategory`,
        Object.entries(runtime.cards).every(([category, card]) =>
          isShown(card) === core.shouldShowCategory(category, mode)
        )
      );
    }
    check('all five runtime classifications are counted independently',
      Object.values(core.CATEGORY).every((category) =>
        count(runtime, category) === 1
      ));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('labels, note, and OTHER_TOPIC count');
  {
    const storage = createStorageStub(settings());
    const runtime = makeRuntime(storage);
    await settle();
    const modeButtons = panel(runtime).querySelectorAll('[data-mode]');
    check('panel exposes exactly three mode buttons', modeButtons.length === 3);
    check('official button is renamed to 公式優先',
      control(runtime, '[data-mode="official"]').textContent === '公式優先');
    check('discovery button is labelled 発掘',
      control(runtime, '[data-mode="discovery"]').textContent === '発掘');
    check('fail-open note text is visible in the panel',
      panel(runtime).querySelectorAll('.ywh-osf-panel__note').some((note) =>
        note.textContent === '判定できない動画は安全のため表示します'
      ));
    const topicCount = control(runtime, '[data-count="other-topic"]');
    check('未登録Topic count is surfaced with the correct initial value',
      topicCount.parentNode.children[0].textContent === '未登録Topic' &&
      topicCount.textContent === '1');

    const addedTopic = createCard(
      runtime.document,
      'added-topic',
      '/channel/UC_ADDED_TOPIC',
      'Added - Topic'
    );
    runtime.results.appendChild(addedTopic);
    MutationObserverStub.instances[0].emit([{
      type: 'childList',
      target: runtime.results,
      addedNodes: [addedTopic],
    }]);
    await delay(80);
    check('未登録Topic count is correct after a mutation re-scan',
      count(runtime, core.CATEGORY.OTHER_TOPIC) === 2);
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('unbound contract and binding re-scan');
  {
    const initial = settings({
      alphaMode: 'discovery',
      globalMode: 'official',
      queryBindings: {},
    });
    const storage = createStorageStub(initial);
    const getWrites = trackStorageWrites(storage);
    const runtime = makeRuntime(storage, 'unbound query');
    await settle();
    const official = control(runtime, '[data-mode="official"]');
    const discovery = control(runtime, '[data-mode="discovery"]');
    check('unbound query forces ALL selected',
      control(runtime, '[data-mode="all"]').getAttribute('aria-pressed') ===
        'true' && Object.values(runtime.cards).every(isShown));
    check('unbound 公式優先 is disabled and aria-disabled',
      official.disabled === true &&
      official.getAttribute('aria-disabled') === 'true');
    check('unbound 発掘 is disabled and aria-disabled',
      discovery.disabled === true &&
      discovery.getAttribute('aria-disabled') === 'true');
    check('unbound hint shows the required guidance',
      control(runtime, '[data-unbound-hint]').hidden === false &&
      control(runtime, '[data-unbound-hint]').textContent ===
        'この検索語をプロフィールへ紐付けると利用できます');
    const savedBeforeDisabledClicks = clone(storage.store[STORAGE_KEY]);
    official.click();
    discovery.click();
    await settle();
    check('disabled mode clicks perform no storage write', getWrites() === 0);
    check('disabled clicks preserve globalMode and every per-profile mode',
      JSON.stringify(storage.store[STORAGE_KEY]) ===
        JSON.stringify(savedBeforeDisabledClicks));

    const bindingSelect = control(runtime, '[data-binding-profile-select]');
    bindingSelect.value = 'alpha';
    control(runtime, '[data-binding-save]').click();
    await settle();
    check('binding enables both profile-dependent mode buttons',
      official.disabled === false && discovery.disabled === false &&
      official.getAttribute('aria-disabled') === 'false' &&
      discovery.getAttribute('aria-disabled') === 'false');
    check('binding applies the saved per-profile discovery mode',
      discovery.getAttribute('aria-pressed') === 'true');
    check('binding triggers a fresh discovery scan',
      isShown(runtime.cards[core.CATEGORY.OTHER_TOPIC]) &&
      !isShown(runtime.cards[core.CATEGORY.OTHER]) &&
      count(runtime, core.CATEGORY.OTHER_TOPIC) === 1);
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('temporary reveal lifecycle');
  {
    const initial = settings();
    const storage = createStorageStub(initial);
    const getWrites = trackStorageWrites(storage);
    const runtime = makeRuntime(storage);
    await settle();
    const watched = runtime.cards[core.CATEGORY.OTHER];
    watched.style.display = 'none';
    watched.dataset.watchedHidden = 'true';
    watched.dataset.watchedVideoId = 'other';
    const watchedSnapshot = JSON.stringify({
      style: watched.style,
      dataset: watched.dataset,
    });
    const countsBeforeReveal = countSnapshot(runtime);
    const reveal = control(runtime, '[data-temporary-reveal]');
    check('official mode initially hides only OTHER_TOPIC and OTHER cards',
      isShown(runtime.cards[core.CATEGORY.OFFICIAL]) &&
      isShown(runtime.cards[core.CATEGORY.CREDIT_RELATED]) &&
      isShown(runtime.cards[core.CATEGORY.PENDING]) &&
      !isShown(runtime.cards[core.CATEGORY.OTHER_TOPIC]) &&
      !isShown(runtime.cards[core.CATEGORY.OTHER]));

    reveal.click();
    check('temporary reveal removes every owned hidden class',
      Object.values(runtime.cards).every(isShown));
    check('temporary reveal does not touch watched style or dataset',
      JSON.stringify({ style: watched.style, dataset: watched.dataset }) ===
        watchedSnapshot);
    check('temporary reveal performs no chrome.storage write', getWrites() === 0);
    check('temporary reveal has a clear active UI state',
      reveal.getAttribute('aria-pressed') === 'true' &&
      reveal.textContent === '一時表示を解除' &&
      control(runtime, '[data-temporary-reveal-status]').hidden === false &&
      control(runtime, '[data-temporary-reveal-status]').textContent ===
        '一時表示: 有効');
    check('temporary reveal leaves category and visible aggregations unchanged',
      countSnapshot(runtime) === countsBeforeReveal);

    const addedOther = createCard(
      runtime.document,
      'added-other',
      '/channel/UC_ADDED_OTHER',
      'Added Other'
    );
    runtime.results.appendChild(addedOther);
    MutationObserverStub.instances[0].emit([{
      type: 'childList',
      target: runtime.results,
      addedNodes: [addedOther],
    }]);
    await delay(80);
    check('same-query infinite-scroll cards follow active temporary reveal',
      isShown(addedOther) && reveal.getAttribute('aria-pressed') === 'true');
    check('same-query scan still aggregates the new card without changing categories',
      count(runtime, core.CATEGORY.OTHER) === 2 &&
      control(runtime, '[data-count-visible]').textContent === '3' &&
      control(runtime, '[data-count-total]').textContent === '6');

    reveal.click();
    check('release reapplies the saved official mode',
      !isShown(runtime.cards[core.CATEGORY.OTHER_TOPIC]) &&
      !isShown(runtime.cards[core.CATEGORY.OTHER]) &&
      !isShown(addedOther) &&
      isShown(runtime.cards[core.CATEGORY.PENDING]));
    check('release clears the active UI without persisting',
      reveal.getAttribute('aria-pressed') === 'false' &&
      control(runtime, '[data-temporary-reveal-status]').hidden === true &&
      getWrites() === 0);

    reveal.click();
    setQuery(runtime, 'second query');
    runtime.document.dispatch('yt-navigate-finish');
    check('query change clears temporary reveal and reapplies filtering',
      control(runtime, '[data-temporary-reveal]').getAttribute('aria-pressed') ===
        'false' && !isShown(runtime.cards[core.CATEGORY.OTHER]));
    const afterQueryOther = createCard(
      runtime.document,
      'after-query-other',
      '/channel/UC_AFTER_QUERY',
      'After Query Other'
    );
    runtime.results.appendChild(afterQueryOther);
    MutationObserverStub.instances[0].emit([{
      type: 'childList',
      target: runtime.results,
      addedNodes: [afterQueryOther],
    }]);
    await delay(80);
    check('temporary reveal does not leak to cards added after query change',
      !isShown(afterQueryOther));

    control(runtime, '[data-temporary-reveal]').click();
    const betaBound = clone(storage.store[STORAGE_KEY]);
    betaBound.queryBindings['second query'] = 'beta';
    storage.externalUpdate(betaBound);
    check('effective profile change clears temporary reveal',
      control(runtime, '[data-temporary-reveal]').getAttribute('aria-pressed') ===
        'false' &&
      control(runtime, '[data-effective-profile]').textContent.includes('Beta') &&
      !isShown(runtime.cards[core.CATEGORY.OFFICIAL]));

    control(runtime, '[data-temporary-reveal]').click();
    control(runtime, '[data-mode="discovery"]').click();
    await settle();
    check('mode change clears temporary reveal and applies the new saved mode',
      control(runtime, '[data-temporary-reveal]').getAttribute('aria-pressed') ===
        'false' &&
      storage.store[STORAGE_KEY].profiles.beta.mode === 'discovery' &&
      isShown(runtime.cards[core.CATEGORY.OTHER_TOPIC]) &&
      !isShown(runtime.cards[core.CATEGORY.OTHER]));

    control(runtime, '[data-temporary-reveal]').click();
    runtime.location.pathname = '/watch';
    runtime.location.href = 'https://www.youtube.com/watch?v=official';
    runtime.document.dispatch('yt-navigate-finish');
    check('leaving results removes owned UI/classes and preserves watched hiding',
      !panel(runtime) &&
      [...runtime.results.children].every(isShown) &&
      watched.style.display === 'none' &&
      watched.dataset.watchedHidden === 'true');

    setQuery(runtime, 'second query');
    runtime.document.dispatch('yt-navigate-finish');
    check('returning to results has no temporary-reveal leak',
      control(runtime, '[data-temporary-reveal]').getAttribute('aria-pressed') ===
        'false' &&
      isShown(runtime.cards[core.CATEGORY.OTHER_TOPIC]) &&
      !isShown(runtime.cards[core.CATEGORY.OTHER]));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
