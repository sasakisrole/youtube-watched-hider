#!/usr/bin/env node
'use strict';

const analyze = require('../analyze_official_profiles.js');
const storeApi = require('../official_profile_store.js');
const core = require('../official_search_filter_core.js');

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

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join('');
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

function createStorageStub(initialSettings) {
  const state = initialSettings
    ? { [storeApi.STORAGE_KEY]: initialSettings }
    : {};
  return {
    state,
    getCount: 0,
    setCount: 0,
    get(key, callback) {
      this.getCount += 1;
      const result = Object.prototype.hasOwnProperty.call(state, key)
        ? { [key]: state[key] }
        : {};
      callback?.(result);
      return Promise.resolve(result);
    },
    set(update, callback) {
      this.setCount += 1;
      Object.assign(state, update);
      callback?.();
      return Promise.resolve();
    },
  };
}

async function main() {
  console.log('Analyze candidate presentation');
  const records = [
    { videoId: 'topic-1', channel: 'Topic Artist - Topic' },
    { videoId: 'topic-2', channel: 'Topic Artist - Topic' },
    ...Array.from({ length: 5 }, (_, index) => ({
      videoId: `official-${index}`,
      channel: 'Credit Rich Official',
      composer: 'Composer',
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      videoId: `weak-${index}`,
      channel: 'Weak Name Match',
      composer: 'Composer',
    })),
  ];
  const candidates = analyze.buildCandidates(records);
  check('Topic aggregate is offered as a Topic candidate',
    candidates.some((candidate) =>
      candidate.kind === 'topic' &&
      candidate.profileName === 'Topic Artist' &&
      candidate.plays === 2));
  check('credit-rich non-Topic aggregate is offered as an official candidate',
    candidates.some((candidate) =>
      candidate.kind === 'official-candidate' &&
      candidate.channelName === 'Credit Rich Official' &&
      candidate.credited === 5));
  check('name alone and fewer than five credited records do not create a candidate',
    !candidates.some((candidate) => candidate.channelName === 'Weak Name Match'));

  const document = new FakeDocument();
  const container = document.createElement('div');
  const rendered = analyze.renderCandidateRows(container, candidates, () => {});
  check('candidate presentation renders every aggregate candidate',
    rendered === candidates.length &&
    container.children.length === candidates.length);
  check('rendered presentation identifies Topic and official candidates',
    container.textContent.includes('Topic候補') &&
    container.textContent.includes('公式候補') &&
    container.textContent.includes('登録内容を確認'));
  check('channel identity input accepts YouTube only',
    analyze.channelFromInput('https://www.youtube.com/@topic', 'Topic')?.canonicalPath === '/@topic' &&
    analyze.channelFromInput('https://example.com/@topic', 'Topic') === null);

  // 2026-07-30 実害の回帰ガード:
  // /channel/UC... は case-sensitive で、小文字化すると YouTube が 404 を返し
  // 「候補チャンネルを開く」がトップページへ戻る。さらに小文字IDを保存すると
  // 検索結果側の実IDと exact 比較で一致せず、登録した公式チャンネルが機能しない。
  const idChannel = analyze.channelFromInput(
    'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
    'Rick Astley'
  );
  check('channel id path keeps its original case (navigable URL)',
    idChannel?.canonicalPath === '/channel/UCuAXFkgsw1L7xaCfnd5JJOw');
  check('stored channelId keeps its original case (matches the live search-result id)',
    idChannel?.channelId === 'UCuAXFkgsw1L7xaCfnd5JJOw');
  check('handle path keeps its original case',
    analyze.channelFromInput('https://www.youtube.com/@RickAstleyYT', 'Rick')?.canonicalPath ===
      '/@RickAstleyYT');
  check('comparison normalizer still folds case (matching semantics unchanged)',
    core.normalizeChannelPath('/channel/UCuAXFkgsw1L7xaCfnd5JJOw') ===
      '/channel/ucuaxfkgsw1l7xacfnd5jjow' &&
    core.canonicalChannelPath('/channel/UCuAXFkgsw1L7xaCfnd5JJOw') ===
      '/channel/UCuAXFkgsw1L7xaCfnd5JJOw');
  check('saved profile with a preserved id matches the live channel',
    core.isSameChannel(
      { channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw', canonicalPath: idChannel?.canonicalPath },
      { channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw', canonicalPath: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw' }
    ) === true);

  // タブ→パネルの配線ドリフト検出（2026-07-30 別タブ化）。
  // タブを足してマップに書き忘れる／パネルidを書き間違えると、クリックしても何も出ない。
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(ROOT, 'history.html'), 'utf8');
  const analyzerSrc = fs.readFileSync(path.join(ROOT, 'analyzer.js'), 'utf8');
  const tabKeys = [...html.matchAll(/data-aztab="([^"]+)"/g)].map((m) => m[1]);
  const mapSrc = analyzerSrc.match(/const map = \{([^}]*)\};/);
  const mapKeys = mapSrc ? [...mapSrc[1].matchAll(/(\w+):\s*'([^']+)'/g)] : [];
  const mapped = new Map(mapKeys.map((m) => [m[1], m[2]]));

  check('every analyze tab is wired to a panel id',
    tabKeys.length > 0 && tabKeys.every((key) => mapped.has(key)));
  check('every mapped panel id exists in history.html',
    mapKeys.length > 0 && [...mapped.values()].every((id) => html.includes(`id="${id}"`)));
  // マーカーは markup 限定にする（'az-official-box' 単体は <style> のCSS定義にも出るため）。
  const SECTION_MARK = '<section class="az-official-box"';
  const artistsAt = html.indexOf('id="azArtistsPanel"');
  const officialAt = html.indexOf('id="azOfficialPanel"');
  const channelsAt = html.indexOf('id="azChannelsPanel"');
  const officialPanelHtml = html.slice(officialAt, channelsAt);

  check('official profile candidates live in their own tab, not the artists tab',
    mapped.get('official') === 'azOfficialPanel' &&
    artistsAt > 0 && officialAt > artistsAt && channelsAt > officialAt &&
    html.slice(artistsAt, officialAt).includes(SECTION_MARK) === false &&
    officialPanelHtml.includes(SECTION_MARK));
  check('the review controls moved together with the section',
    officialPanelHtml.includes('id="azOfficialCandidates"') &&
    officialPanelHtml.includes('id="azOfficialTarget"') &&
    officialPanelHtml.includes('id="azOfficialSave"'));

  console.log('mandatory confirmation gate');
  const storage = createStorageStub();
  const registration = {
    profileName: 'Topic Artist',
    channel: {
      channelId: 'UC_TOPIC',
      canonicalPath: '/channel/UC_TOPIC',
      displayName: 'Topic Artist - Topic',
    },
    bindQuery: false,
  };
  const skipped = await storeApi.registerConfirmed({
    ...registration,
    confirmed: false,
  }, storage);
  check('unconfirmed registration is rejected',
    skipped.saved === false &&
    skipped.reason === 'confirmation-required');
  check('unconfirmed path performs no storage read or write',
    storage.getCount === 0 &&
    storage.setCount === 0 &&
    Object.keys(storage.state).length === 0);

  console.log('confirmed profile and channel save');
  const saved = await storeApi.registerConfirmed({
    ...registration,
    confirmed: true,
  }, storage);
  const settings = storage.state[storeApi.STORAGE_KEY];
  const profile = settings?.profiles?.[saved.profileId];
  check('confirmed registration persists once',
    saved.saved === true &&
    storage.getCount === 1 &&
    storage.setCount === 1);
  check('confirmed registration uses the existing PR3b profile shape',
    settings.schemaVersion === 1 &&
    settings.activeProfileId === saved.profileId &&
    profile.displayName === 'Topic Artist' &&
    Array.isArray(profile.aliases) &&
    profile.mode === 'all');
  check('confirmed registration persists the authoritative channel identity',
    profile.channels.length === 1 &&
    profile.channels[0].channelId === 'UC_TOPIC' &&
    profile.channels[0].canonicalPath === '/channel/uc_topic' &&
    profile.channels[0].enabled === true);
  check('query binding remains off by default',
    Object.keys(settings.queryBindings).length === 0);

  console.log('candidate list state (registered / excluded / duplicate guard)');
  const baseChannel = {
    channelId: 'UC_STATE',
    canonicalPath: '/channel/UC_STATE',
    displayName: 'State Artist - Topic',
    sourceChannelName: 'State Artist - Topic',
  };
  const first = storeApi.mutateConfirmedRegistration(
    storeApi.createDefaultSettings(),
    { profileName: 'State Artist', channel: baseChannel, confirmed: true }
  );
  check('first registration creates exactly one profile',
    first.changed === true &&
    Object.keys(first.settings.profiles).length === 1);
  check('the source channel name is persisted for later matching',
    Object.values(first.settings.profiles)[0].channels[0].sourceChannelName ===
      'State Artist - Topic');

  const second = storeApi.mutateConfirmedRegistration(
    first.settings,
    { profileName: 'State Artist', channel: baseChannel, confirmed: true }
  );
  check('registering the same channel again is refused, not duplicated',
    second.changed === false &&
    second.reason === 'already-registered' &&
    Object.keys(second.settings.profiles).length === 1);

  const renamed = storeApi.mutateConfirmedRegistration(
    first.settings,
    { profileName: 'renamed retry', channel: baseChannel, confirmed: true }
  );
  check('a renamed retry of the same channel is still refused',
    renamed.changed === false &&
    renamed.reason === 'already-registered' &&
    Object.keys(renamed.settings.profiles).length === 1);

  check('registered candidates are detected by their source channel name',
    storeApi.findRegisteredProfileId(first.settings,
      { channelName: 'State Artist - Topic', profileName: 'State Artist' }) !== null);
  check('unrelated candidates are not treated as registered',
    storeApi.findRegisteredProfileId(first.settings,
      { channelName: 'Other Artist - Topic', profileName: 'Other Artist' }) === null);
  check('legacy rows without a source name still match by display name',
    storeApi.findRegisteredProfileId(
      {
        schemaVersion: 1,
        activeProfileId: null,
        globalMode: 'all',
        hideOtherGlobal: false,
        queryBindings: {},
        candidateExclusions: [],
        profiles: {
          legacy: {
            id: 'legacy',
            displayName: 'Legacy Artist',
            aliases: [],
            mode: 'all',
            channels: [{
              channelId: 'UC_L',
              canonicalPath: '/channel/UC_L',
              displayName: 'Legacy Artist - Topic',
            }],
          },
        },
      },
      { channelName: 'Legacy Artist - Topic', profileName: 'Legacy Artist' }
    ) === 'legacy');

  const excludedOnce = storeApi.setCandidateExcluded(first.settings, 'Release', true);
  const excludedTwice = storeApi.setCandidateExcluded(excludedOnce.settings, 'Release', true);
  const restored = storeApi.setCandidateExcluded(excludedOnce.settings, 'Release', false);
  check('manual exclusion is stored, idempotent and reversible',
    excludedOnce.changed === true &&
    excludedOnce.settings.candidateExclusions.includes('Release') &&
    excludedTwice.changed === false &&
    restored.changed === true &&
    restored.settings.candidateExclusions.includes('Release') === false);
  check('exclusions survive the settings sanitizer',
    storeApi.sanitizeSettings(excludedOnce.settings).candidateExclusions
      .includes('Release'));
  check('exclusion list rejects non-strings and duplicates',
    storeApi.sanitizeCandidateExclusions(['A', 'A', '', 42, null, ' B ']).length === 2);

  const pool = [
    { channelName: 'State Artist - Topic', profileName: 'State Artist' },
    { channelName: 'Release', profileName: 'Release' },
    { channelName: 'Fresh Artist - Topic', profileName: 'Fresh Artist' },
  ];
  const parts = analyze.partitionCandidates(pool, excludedOnce.settings, storeApi);
  check('the visible list drops both registered and excluded candidates',
    parts.visible.length === 1 &&
    parts.visible[0].channelName === 'Fresh Artist - Topic' &&
    parts.registered.length === 1 &&
    parts.excluded.length === 1);

  const stateDoc = new FakeDocument();
  const stateContainer = stateDoc.createElement('div');
  let excludedArg = null;
  analyze.renderCandidateRows(
    stateContainer,
    parts.visible,
    { onReview: () => {}, onExclude: (candidate) => { excludedArg = candidate; } }
  );
  const excludeButton = stateContainer.children[0].children
    .find((child) => child.dataset && child.dataset.officialExclude);
  if (excludeButton && excludeButton.listeners && excludeButton.listeners.click) {
    excludeButton.listeners.click();
  }
  check('each row offers a manual exclude action wired to the candidate',
    Boolean(excludeButton) && excludedArg === parts.visible[0]);

  const emptyContainer = stateDoc.createElement('div');
  analyze.renderCandidateRows(emptyContainer, [], { onReview: () => {} },
    { registeredCount: 1, excludedCount: 1 });
  check('the empty state explains what is hidden instead of claiming none exist',
    emptyContainer.textContent.includes('登録済み 1 件') &&
    emptyContainer.textContent.includes('除外 1 件'));

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
