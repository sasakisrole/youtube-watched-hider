#!/usr/bin/env node
'use strict';

const analyze = require('../analyze_official_profiles.js');
const storeApi = require('../official_profile_store.js');

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

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
