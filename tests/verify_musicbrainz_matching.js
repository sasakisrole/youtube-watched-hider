// Regression verification for PENDING id:vcdz (MusicBrainz credit matching).
// Uses captured MusicBrainz response fixtures only; no external requests or user DB writes.
// Run: node verify_musicbrainz_matching.js
const fs = require('fs');
const path = require('path');

const projectDir = path.join(__dirname, '..');
const backgroundSrc = fs.readFileSync(path.join(projectDir, 'background.js'), 'utf8');
const enrichSrc = fs.readFileSync(path.join(projectDir, 'enrich_credits.js'), 'utf8');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'musicbrainz_matching.json'), 'utf8'));

function loadBackgroundHooks(mockMbGet, manifestVersion = '1.42.14') {
  const helperStart = backgroundSrc.indexOf('function getEnrichMbUserAgent');
  const start = helperStart >= 0 ? helperStart : backgroundSrc.indexOf('function normalizeCreditLookupText');
  const end = backgroundSrc.indexOf('// Generate backup filename');
  if (start < 0 || end < 0 || end <= start) throw new Error('MusicBrainz helper block not found');
  let block = backgroundSrc.slice(start, end);
  block = block.replace(
    /async function mbGet\(path, params\) \{[\s\S]*?\n\}(?=\n\nfunction collectMbRole)/,
    'async function mbGet(path, params) { return mockMbGet(path, params); }'
  );
  const make = new Function('self', 'chrome', 'mockMbGet', `${block}\nreturn {
    normalizeCreditLookupText,
    sequenceRatio,
    cleanMbTitle,
    mbArtistMatches,
    parseMbTitle: typeof parseMbTitle === 'function' ? parseMbTitle : null,
    getEnrichMbUserAgent: typeof getEnrichMbUserAgent === 'function' ? getEnrichMbUserAgent : null,
    enrichCreditsLookupMb,
  };`);
  return make(
    { CreditTarget: { stripTopicChannelSuffix: (value) => String(value || '').replace(/\s*-\s*(?:Topic|トピック)\s*$/iu, '').trim() } },
    { runtime: { getManifest: () => ({ version: manifestVersion }) } },
    mockMbGet
  );
}

function loadEnrichHooks() {
  const win = {};
  const doc = {
    getElementById: () => null,
    addEventListener: () => {},
    querySelectorAll: () => [],
    createElement: () => ({ appendChild() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} }, style: {} }),
    createDocumentFragment: () => ({ appendChild() {} }),
    body: { classList: { add() {}, remove() {} } },
  };
  const chromeStub = { runtime: { getURL: () => '', getManifest: () => ({ version: 'test' }), sendMessage: () => {}, lastError: null } };
  new Function('window', 'document', 'chrome', enrichSrc)(win, doc, chromeStub);
  return win.EnrichCreditsTestHooks;
}

function mockForFixture(fixture) {
  return async (requestPath, params) => {
    if (requestPath === 'recording/') {
      return String(params.query || '').includes('artist:') ? fixture.strict : fixture.titleOnly;
    }
    if (requestPath.startsWith('recording/')) {
      const id = decodeURIComponent(requestPath.slice('recording/'.length));
      return fixture.recordings[id] || { relations: [] };
    }
    if (requestPath.startsWith('work/')) return { relations: [] };
    throw new Error(`Unexpected MusicBrainz path: ${requestPath}`);
  };
}

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

(async () => {
  console.log('artist identity');
  const pure = loadBackgroundHooks(async () => ({ recordings: [] }));
  for (const pair of fixtures.shortArtistPairs) {
    const recording = { 'artist-credit': [{ name: pair.candidate, artist: { name: pair.candidate } }] };
    check(`${pair.target} does not match different artist ${pair.candidate}`,
      pure.mbArtistMatches(pair.target, recording) === false);
  }
  check('exact short artist Eve still matches',
    pure.mbArtistMatches('Eve', { 'artist-credit': [{ name: 'Eve', artist: { name: 'Eve' } }] }) === true);

  console.log('title/version parsing');
  check('parseMbTitle helper exists', typeof pure.parseMbTitle === 'function');
  if (pure.parseMbTitle) {
    const remix = pure.parseMbTitle('Signal - Remix');
    check('Remix keeps base work title separately', remix.baseWorkTitle === 'Signal', JSON.stringify(remix));
    check('Remix records its version qualifier', remix.recordingVersion === 'Remix', JSON.stringify(remix));
    check('Cover is separated from its base work title',
      pure.parseMbTitle('Signal (Cover)').baseWorkTitle === 'Signal'
        && pure.parseMbTitle('Signal (Cover)').recordingVersion === 'Cover');
    check('Live recording is manual-review version metadata',
      pure.parseMbTitle('Signal - Live 2024').recordingVersion === 'Live'
        && pure.parseMbTitle('Signal - Live 2024').requiresManualReview === true);
    check('Instrumental recording is manual-review version metadata',
      pure.parseMbTitle('Signal - Instrumental').recordingVersion === 'Instrumental'
        && pure.parseMbTitle('Signal - Instrumental').requiresManualReview === true);
    check('plain recording has no manual-review version flag', pure.parseMbTitle('Last Dance').requiresManualReview === false);

    // 実データ由来の版表記（2026-07-21 実MusicBrainz応答の検証で判明した取りこぼし）。
    // \blive\b は "Live2022" に一致しない（"e" と "2" が共に word 文字＝境界が立たない）ため、
    // Live版が通常版として自動採用されていた。
    const realLive = pure.parseMbTitle('劣等上等 (Encore) - Live2022『藍の華』 -');
    check('real title: Live with attached year is detected as Live',
      realLive.recordingVersion === 'Live', JSON.stringify(realLive));
    check('real title: Live with attached year requires manual review',
      realLive.requiresManualReview === true, JSON.stringify(realLive));
    check('real title: base work title drops the live suffix',
      realLive.baseWorkTitle === '劣等上等', JSON.stringify(realLive));
    check('Live directly followed by a year digit is detected',
      pure.parseMbTitle('Signal - Live2024').recordingVersion === 'Live');
    check('parenthesised Live from real data is detected',
      pure.parseMbTitle('Decade (20th Anniversary Festival) (Live)').recordingVersion === 'Live');
    check('Live Ver. notation is detected',
      pure.parseMbTitle('Signal - Live Ver.').recordingVersion === 'Live');

    // 単語の一部に live を含むだけの通常タイトルを Live版と誤判定しない
    for (const plain of ['Stayin Alive', 'Lively Days', 'Olive Branch', 'Delivery Man']) {
      check(`plain title is not misread as Live: ${plain}`,
        pure.parseMbTitle(plain).recordingVersion === '', JSON.stringify(pure.parseMbTitle(plain)));
    }
    check('real plain title stays version-free',
      pure.parseMbTitle('完全無欠の無重力ダイブ').requiresManualReview === false);
  }

  console.log('lookup selection');
  const byId = new Map(fixtures.lookups.map((fixture) => [fixture.id, fixture]));

  const titleOnlyFixture = byId.get('title-only-other-artist');
  const titleOnlyResult = await loadBackgroundHooks(mockForFixture(titleOnlyFixture))
    .enrichCreditsLookupMb(titleOnlyFixture.artist, titleOnlyFixture.title);
  check('title-only other-artist result is not exposed as a credit candidate',
    titleOnlyResult.candidate === null, JSON.stringify(titleOnlyResult.candidate));

  const wrongStrictFixture = byId.get('strict-score-wrong-artist');
  const wrongStrictResult = await loadBackgroundHooks(mockForFixture(wrongStrictFixture))
    .enrichCreditsLookupMb(wrongStrictFixture.artist, wrongStrictFixture.title);
  check('score 100 strict result still requires artist identity',
    wrongStrictResult.candidate === null, JSON.stringify(wrongStrictResult.candidate));

  const fuzzyFixture = byId.get('fuzzy-exact-artist');
  const fuzzyResult = await loadBackgroundHooks(mockForFixture(fuzzyFixture))
    .enrichCreditsLookupMb(fuzzyFixture.artist, fuzzyFixture.title);
  check('artist-matched title-search result remains available for review',
    fuzzyResult.candidate && fuzzyResult.candidate.stage === 'fuzzy', JSON.stringify(fuzzyResult.candidate));
  check('fuzzy result is never auto-eligible',
    fuzzyResult.candidate && fuzzyResult.candidate.autoEligible === false, JSON.stringify(fuzzyResult.candidate));

  const mismatchFixture = byId.get('remix-version-mismatch');
  const mismatchResult = await loadBackgroundHooks(mockForFixture(mismatchFixture))
    .enrichCreditsLookupMb(mismatchFixture.artist, mismatchFixture.title);
  check('Remix vs original is marked for manual review',
    mismatchResult.candidate && mismatchResult.candidate.requiresManualReview === true, JSON.stringify(mismatchResult.candidate));
  check('version-mismatched recording does not supply arranger',
    mismatchResult.candidate && mismatchResult.candidate.arranger === '', JSON.stringify(mismatchResult.candidate));
  check('version metadata distinguishes requested Remix from original recording',
    mismatchResult.candidate && mismatchResult.candidate.recordingVersion === 'Remix'
      && mismatchResult.candidate.mbRecordingVersion === ''
      && mismatchResult.candidate.versionMatch === false,
    JSON.stringify(mismatchResult.candidate));

  const matchingVersionFixture = byId.get('remix-version-match');
  const matchingVersionResult = await loadBackgroundHooks(mockForFixture(matchingVersionFixture))
    .enrichCreditsLookupMb(matchingVersionFixture.artist, matchingVersionFixture.title);
  check('matching Remix recording keeps its recording-level arranger',
    matchingVersionResult.candidate && matchingVersionResult.candidate.arranger === 'Remix Arranger', JSON.stringify(matchingVersionResult.candidate));
  check('matching Remix remains manual-review only',
    matchingVersionResult.candidate && matchingVersionResult.candidate.autoEligible === false
      && matchingVersionResult.candidate.requiresManualReview === true,
    JSON.stringify(matchingVersionResult.candidate));

  const exactFixture = byId.get('strict-exact-normal');
  const exactResult = await loadBackgroundHooks(mockForFixture(exactFixture))
    .enrichCreditsLookupMb(exactFixture.artist, exactFixture.title);
  check('exact normal strict match remains a candidate',
    exactResult.candidate && exactResult.candidate.stage === 'strict', JSON.stringify(exactResult.candidate));
  check('exact normal strict match is auto-eligible',
    exactResult.candidate && exactResult.candidate.autoEligible === true, JSON.stringify(exactResult.candidate));
  check('exact normal strict match preserves all roles',
    exactResult.candidate && exactResult.candidate.composer === 'Eve'
      && exactResult.candidate.lyricist === 'Eve'
      && exactResult.candidate.arranger === 'Numa',
    JSON.stringify(exactResult.candidate));

  console.log('UI auto-selection boundary');
  const ui = loadEnrichHooks();
  const record = { videoId: 'v1', title: 'Home', channel: 'Eve' };
  const song = { title: 'Home', composer: 'Wrong Composer', arranger: 'Wrong Arranger' };
  const titleOnlyUi = ui.candidateFromSong(record, song, 1, 'mb', 'title-only', {
    autoEligible: false,
    requiresManualReview: true,
  });
  check('UI does not auto-select title-only even at similarity 1.0', titleOnlyUi && titleOnlyUi.selected === false);
  const fuzzyUi = ui.candidateFromSong(record, song, 1, 'mb', 'fuzzy', {
    autoEligible: false,
    requiresManualReview: true,
  });
  check('UI does not auto-select fuzzy even at similarity 1.0', fuzzyUi && fuzzyUi.selected === false);
  const strictUi = ui.candidateFromSong(record, song, 1, 'mb', 'strict', {
    autoEligible: true,
    requiresManualReview: false,
  });
  check('UI auto-selects only explicitly eligible strict match', strictUi && strictUi.selected === true);
  const legacyStrictUi = ui.candidateFromSong(record, song, 1, 'mb', 'strict');
  check('UI fails closed when old MB response omits eligibility metadata', legacyStrictUi && legacyStrictUi.selected === false);

  console.log('MusicBrainz User-Agent');
  check('User-Agent helper exists', typeof pure.getEnrichMbUserAgent === 'function');
  if (pure.getEnrichMbUserAgent) {
    check('User-Agent uses current manifest version',
      pure.getEnrichMbUserAgent().startsWith('yt-watched-hider/1.42.14 '), pure.getEnrichMbUserAgent());
  }
  check('background has no hard-coded stale 1.40.0 User-Agent',
    !backgroundSrc.includes("yt-watched-hider/1.40.0 (https://github.com/sasakisrole/youtube-watched-hider)"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
