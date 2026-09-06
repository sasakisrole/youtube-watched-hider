// Synthetic verification for liked-sync robustness fixes.
// v1.42.5: H1 unknown-account guard, M1 partial detection, M2 dedup guard, L1 channel.
// v1.42.6: H1 source scoping (scoped vs loose items), M1 persistent partial note,
//          M2 loadLiked generation guard, L1 syncLikedPlaylist body-mock execution.
// Extracts the real functions from background.js and exercises them so a
// regression in the extraction / scoping / partial logic fails loudly.
// Run: node verify_liked_sync_robustness.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// Extract a top-level function by name (they don't touch chrome.*). Slices from
// "function NAME(" to the next top-level "\nfunction " — robust against regex
// literals containing braces/quotes. Preserves a leading "async ".
function extractFn(name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('fn not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const next = src.indexOf('\nfunction ', start + 1);
  const end = next === -1 ? src.length : next;
  return src.slice(start, end);
}

// Brace-matched extraction for functions whose next sibling is NOT another
// top-level `function` (syncLikedPlaylist is followed by chrome.runtime...).
// String/comment aware so braces inside strings/comments don't miscount.
function extractBracedFn(name, source) {
  // v1.42.12 (M2): optional `source` lets us brace-extract a function from analyzer.js
  // too (its IIFE-nested, indented functions defeat extractFn's `\nfunction ` slice, but
  // brace matching is indentation-agnostic). Defaults to background.js `src`.
  const s = source || src;
  let start = s.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('fn not found: ' + name);
  if (s.slice(start - 6, start) === 'async ') start -= 6;
  // Close the parameter list first (its destructuring `{...} = {}` must not be
  // mistaken for the body's opening brace), then find the body's `{`.
  let p = s.indexOf('(', start), pd = 0, k = p;
  for (; k < s.length; k++) {
    if (s[k] === '(') pd++;
    else if (s[k] === ')') { pd--; if (pd === 0) { k++; break; } }
  }
  let j = s.indexOf('{', k);
  let depth = 0, inS = null, inLine = false, inBlock = false;
  for (; j < s.length; j++) {
    const c = s[j], n = s[j + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; j++; } continue; }
    if (inS) { if (c === '\\') { j++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inLine = true; j++; continue; }
    if (c === '/' && n === '*') { inBlock = true; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return s.slice(start, j);
}

// Build the pure extractor with its helper + the container-name consts in scope.
// extractFn('findFirstContinuationToken') slices up to the next top-level
// `function`, which sweeps in the LL_PRIMARY_RENDERERS / LL_CONTINUATION_ENVELOPES
// consts declared between the two helpers — so they are in scope for
// extractItemsAndContinuation (v1.42.9 split the former single LL_ITEM_CONTAINERS set).
//
// Watch Later scan (2026-08-07): findFirstSetVideoId now sits between the two, so it must be spliced in
// as well — and because extractFn slices up to the NEXT top-level `function`, it is
// the findFirstSetVideoId slice that now carries those consts. Dropping it here
// would make extractItemsAndContinuation throw ReferenceError on the first item.
const harness = extractFn('findFirstContinuationToken') + '\n'
  + extractFn('findFirstSetVideoId') + '\n'
  + extractFn('extractItemsAndContinuation');
// eslint-disable-next-line no-eval
const extractItemsAndContinuation = eval('(function(){ ' + harness + '\n return extractItemsAndContinuation; })()');

// v1.42.10 (M1): pure HTML/identity extractors. extractYtInitialData depends on the
// shared matchBalancedJsonObject; extractOwnerIdentity is standalone.
// eslint-disable-next-line no-eval
const extractYtInitialData = eval('(function(){ '
  + extractFn('matchBalancedJsonObject') + '\n'
  + extractFn('extractYtInitialData') + '\n return extractYtInitialData; })()');
// eslint-disable-next-line no-eval
const extractOwnerIdentity = eval('(function(){ '
  + extractFn('extractOwnerIdentity') + '\n return extractOwnerIdentity; })()');

// v1.42.12 (M2): pull the pure prompt-note builder out of analyzer.js so the copied-prompt
// weak-identity warnings can be asserted without a full renderPrompt DOM harness.
const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'analyzer.js'), 'utf8');
// eslint-disable-next-line no-eval
const likedPromptNotes = eval('(function(){ '
  + extractBracedFn('likedPromptNotes', analyzerSrc) + '\n return likedPromptNotes; })()');

// v1.42.13 (M1, Codex 2026-07-11 wrapup-review_9): the pure confirmation-escalation
// driver. resolveLikedSync must confirm account-unknown and account-changed SEPARATELY
// so approving an unidentified-account save never silently approves a known→unknown
// account change.
// eslint-disable-next-line no-eval
const resolveLikedSync = eval('(function(){ '
  + extractBracedFn('resolveLikedSync', analyzerSrc) + '\n return resolveLikedSync; })()');

function makeImportedMetaHarness(initialMeta = null) {
  const store = { likedSyncMeta: initialMeta };
  const storageLocalGet = async (defaults) => Object.assign({}, defaults, store);
  const storageLocalSet = async (values) => { Object.assign(store, values); };
  const storageLocalSetChecked = storageLocalSet;
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'storageLocalGet', 'storageLocalSet', 'storageLocalSetChecked',
    extractBracedFn('getImportedLikedCount') + '\n'
      + extractBracedFn('getUnverifiedImportedLikedMeta') + '\n'
      + extractBracedFn('storeImportedMeta') + '\n'
      + extractBracedFn('storeImportedMetaIfAbsent') + '\n'
      + extractBracedFn('getReplaceImportedLikedMeta') + '\n'
      + 'return { storeImportedMeta, storeImportedMetaIfAbsent, getReplaceImportedLikedMeta };'
  );
  return {
    store,
    ...factory(storageLocalGet, storageLocalSet, storageLocalSetChecked),
  };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// --- M2 (v1.42.5): continuationSource tracks structured vs regex fallback ---
const structured = {
  contents: [
    { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'vidA',
      metadata: { lockupMetadataViewModel: { title: { content: 'Title A' },
        metadata: { contentMetadataViewModel: { metadataRows: [
          { metadataParts: [ { text: { content: 'Chan A',
            commandRuns: [ { onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCxyz' } } } } ] } } ] } ] } } } } } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN_STRUCT' } } } },
  ],
};
const r1 = extractItemsAndContinuation(structured);
check('M2 structured token found', r1.continuation === 'TOKEN_STRUCT');
check('M2 source=structured', r1.continuationSource === 'structured');
check('L1 UC-linked channel captured', r1.items[0] && r1.items[0].channel === 'Chan A');

// Regex-only fallback: token exists but not via continuationItemRenderer walker.
const regexOnly = { blob: { some: { continuationCommand: { token: 'TOKEN_REGEX' } } } };
const r2 = extractItemsAndContinuation(regexOnly);
check('M2 regex fallback token found', r2.continuation === 'TOKEN_REGEX');
check('M2 source=regex', r2.continuationSource === 'regex');
check('M2 regex token is unscoped', r2.continuationScoped === false);

// --- L1 (v1.42.5): no UC-linked part => channel stays empty ---
const noChannelLink = {
  contents: [
    { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'vidB',
      metadata: { lockupMetadataViewModel: { title: { content: 'Title B' },
        metadata: { contentMetadataViewModel: { metadataRows: [
          { metadataParts: [ { text: { content: '12万 回視聴' } } ] } ] } } } } } },
  ],
};
const r3 = extractItemsAndContinuation(noChannelLink);
check('L1 no-UC-part => channel empty', r3.items[0] && r3.items[0].channel === '');
check('L1 no-UC-part => videoId still captured', r3.items[0] && r3.items[0].videoId === 'vidB');

// --- H1 (v1.42.9): scoped vs loose source tagging in a mixed response ---
// The scoped items live under a playlist-SPECIFIC renderer (the structural anchor);
// a loose item lives in an unrelated recommendation shelf sharing the payload. The
// anchor makes the body the primary container and its co-located token the proven
// continuation. (v1.42.7 put the scoped items under a generic appendContinuationItems
// Action envelope, which v1.42.9 no longer treats as evidence — a real playlist-specific
// renderer is now required to name a container.)
const mixed = {
  contents: { playlistVideoListRenderer: { contents: [
    { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'vidScoped',
      metadata: { lockupMetadataViewModel: { title: { content: 'Scoped' } } } } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOK_SCOPED' } } } },
  ] } },
  sidebarPollution: {
    recommendationShelfRenderer: { contents: [
      { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'vidLoose',
        metadata: { lockupMetadataViewModel: { title: { content: 'Loose' } } } } },
    ] },
  },
};
const rm = extractItemsAndContinuation(mixed);
const mScoped = rm.items.find((i) => i.videoId === 'vidScoped');
const mLoose = rm.items.find((i) => i.videoId === 'vidLoose');
check('H1 scoped item tagged source=scoped', !!mScoped && mScoped.source === 'scoped');
check('H1 loose item tagged source=loose', !!mLoose && mLoose.source === 'loose');
check('H1 continuation taken from scoped container', rm.continuation === 'TOK_SCOPED' && rm.continuationScoped === true);

// --- H1/M2 (v1.42.9, Codex 2026-07-10): the playlist-specific renderer anchor must
// beat a LARGER generic-envelope sibling. On the pre-v1.42.9 code the generic
// `appendContinuationItemsAction` was also "named", so the 3-item sibling out-counted
// the 2-item real body and hijacked primary — this fixture is RED there (real items
// tagged loose, sibling scoped). This is the direct H1 regression test.
const anchorVsCount = {
  contents: { playlistVideoListRenderer: { contents: [
    lockup('vidBody1', 'b1'), lockup('vidBody2', 'b2'),
  ] } },
  onResponseReceivedActions: [ { appendContinuationItemsAction: { continuationItems: [
    lockup('vidSib1', 's1'), lockup('vidSib2', 's2'), lockup('vidSib3', 's3'),
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'SIB_TOKEN' } } } },
  ] } } ],
};
const rav = extractItemsAndContinuation(anchorVsCount);
const avScoped = rav.items.filter((i) => i.source === 'scoped').map((i) => i.videoId).sort();
const avLoose = rav.items.filter((i) => i.source === 'loose').map((i) => i.videoId).sort();
check('M2 anchor beats item-count: playlist-renderer body is primary',
  avScoped.join(',') === 'vidBody1,vidBody2');
check('M2 anchor beats item-count: larger generic-envelope sibling is loose',
  avLoose.join(',') === 'vidSib1,vidSib2,vidSib3');
check('M2 anchor: generic-envelope sibling token is not trusted (out of primary)',
  rav.continuationScoped === false && rav.rejectedTokenCount === 1);
check('M2 anchor: not flagged uncertain (a named anchor exists)', rav.primaryUncertain === false);

// --- M2 (v1.42.9): two same-size UNNAMED containers (both generic envelopes, no
// playlist-specific renderer) is genuinely ambiguous — the LL body can't be proven.
// The extractor must flag primaryUncertain and refuse the token rather than trust a
// coin-flip. Pre-v1.42.9 both were "named", so it decisively (wrongly) trusted one.
const ambiguousTie = {
  onResponseReceivedActions: [
    { appendContinuationItemsAction: { continuationItems: [
      lockup('vidTieA', 'a'),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TIE_TOKEN' } } } },
    ] } },
    { reloadContinuationItemsCommand: { continuationItems: [ lockup('vidTieB', 'b') ] } },
  ],
};
const rti = extractItemsAndContinuation(ambiguousTie);
check('M2 ambiguous tie flags primaryUncertain', rti.primaryUncertain === true);
check('M2 ambiguous tie refuses the token (not trusted as scoped)', rti.continuationScoped === false);

// --- H1 (v1.42.9, Codex 2026-07-11 R): a shelf nested DEEP under a playlist-specific
// renderer (e.g. `richGridRenderer.header.shelfRenderer.contents`) must NOT inherit the
// anchor's `named` flag. If `named` floods every descendant, a larger nested shelf
// hijacks primary from inside the renderer — the H1 bug re-entering via a descendant.
// The real body is `richGridRenderer.contents` (a direct item array); only that stays
// named. This is RED on the flood-propagation version (the 3-item nested shelf wins).
const nestedShelf = {
  contents: { richGridRenderer: {
    contents: [
      lockup('vidNL1', 'n1'), lockup('vidNL2', 'n2'),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'LL_NEXT' } } } },
    ],
    header: { shelfRenderer: { contents: [
      lockup('vidNS1', 's1'), lockup('vidNS2', 's2'), lockup('vidNS3', 's3'),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'SIDE_NEXT' } } } },
    ] } },
  } },
};
const rns = extractItemsAndContinuation(nestedShelf);
check('M2 nested-shelf: richGridRenderer body is primary (not the deeper header shelf)',
  rns.items.filter((i) => i.source === 'scoped').map((i) => i.videoId).sort().join(',') === 'vidNL1,vidNL2');
check('M2 nested-shelf: larger nested header shelf is loose',
  rns.items.filter((i) => i.source === 'loose').map((i) => i.videoId).sort().join(',') === 'vidNS1,vidNS2,vidNS3');
check('M2 nested-shelf: body token trusted, deeper shelf token rejected',
  rns.continuation === 'LL_NEXT' && rns.continuationScoped === true && rns.rejectedTokenCount === 1);

// playlistVideoRenderer (classic) inside playlistVideoListRenderer is scoped too.
const classic = {
  contents: { playlistVideoListRenderer: { contents: [
    { playlistVideoRenderer: { videoId: 'vidClassic', title: { simpleText: 'C' },
      shortBylineText: { runs: [ { text: 'Chan C' } ] }, index: { simpleText: '1' } } },
  ] } },
};
const rc = extractItemsAndContinuation(classic);
check('H1 classic playlistVideoRenderer scoped', rc.items[0] && rc.items[0].source === 'scoped' && rc.items[0].videoId === 'vidClassic');

// --- N1 real-structure fixture (2026-07-11 live smoke test of browseId:'VLLL'):
// the ACTUAL Liked-videos body ships under a GENERIC envelope, not a playlist-specific
// renderer. Verified path from ytInitialData:
//   contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content
//     .sectionListRenderer.contents[0].itemSectionRenderer.contents  -> [ lockupViewModel... ]
// No playlistVideoListRenderer / richGridRenderer appears anywhere in the real response,
// so the LL_PRIMARY_RENDERERS structural anchor does NOT fire on live data. Selection
// falls to the count fallback, which is safe HERE only because the body is the SOLE item
// array (strict max => certain, not a tie). Every other scoped fixture above uses the
// imagined playlistVideoListRenderer/richGridRenderer shape; this one locks in the real
// shape so a future refactor can't silently break handling of what YouTube actually sends.
const realLL = {
  contents: { twoColumnBrowseResultsRenderer: { tabs: [
    { tabRenderer: { content: { sectionListRenderer: { contents: [
      { itemSectionRenderer: { contents: [
        lockup('vidR1', 'r1'), lockup('vidR2', 'r2'), lockup('vidR3', 'r3'),
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'LL_REAL_NEXT' } } } },
      ] } },
    ] } } } },
  ] } },
};
const rr = extractItemsAndContinuation(realLL);
check('N1 real-structure: 3 lockups scoped via itemSectionRenderer body (count fallback, no anchor)',
  rr.items.filter((i) => i.source === 'scoped').map((i) => i.videoId).sort().join(',') === 'vidR1,vidR2,vidR3');
check('N1 real-structure: sole item array => strict max => not uncertain',
  rr.primaryUncertain === false);
check('N1 real-structure: body token trusted + scoped, nothing rejected',
  rr.continuation === 'LL_REAL_NEXT' && rr.continuationScoped === true && rr.rejectedTokenCount === 0);

// --- M1 (v1.42.10): ytInitialData extraction survives assignment-form / wrapper
// variance. The old end-anchored regex only matched `var? ytInitialData = {...};</script>`
// and lost the object (and owner identity) under any other wrapper. ---
const ytObj = '{"header":{"playlistHeaderRenderer":{"ownerText":{"runs":[{"text":"Ken","navigationEndpoint":{"browseEndpoint":{"browseId":"UCken","canonicalBaseUrl":"/@kenhandle"}}}]}}},"contents":{}}';
function assertOwner(tag, html) {
  const r = extractYtInitialData(html);
  check(tag + ' data parsed', !!r.data && r.matched === true);
  const o = r.data ? extractOwnerIdentity(r.data) : {};
  check(tag + ' owner recovered', o.ownerChannelId === 'UCken' && o.ownerHandle === '@kenhandle' && o.ownerName === 'Ken');
}
// Classic form the OLD regex handled (control):
assertOwner('M1 classic var form', 'foo; var ytInitialData = ' + ytObj + ';</script> more');
// Bare assignment without the ;</script> anchor (regex needed the trailing boundary):
assertOwner('M1 bare no-anchor form', 'x = 1; ytInitialData = ' + ytObj + ' ; window.foo = 2;');
// window["..."] wrapper (regex could not match this at all):
assertOwner('M1 window-bracket form', 'window["ytInitialData"] = ' + ytObj + ';');
// window.ytInitialData wrapper:
assertOwner('M1 window-dot form', 'window.ytInitialData = ' + ytObj + ';');
// A decoy earlier mention that is not a real object still finds the real one:
assertOwner('M1 decoy then real', '// ytInitialData = null placeholder\nvar ytInitialData = ' + ytObj + ';</script>');
// Genuinely absent => matched=false => no-ytInitialData (not parse-failed):
{
  const r = extractYtInitialData('<html>no data here</html>');
  check('M1 absent => matched=false', r.data === null && r.matched === false);
}
// Present marker but corrupt braces => matched=true => parse-failed signal:
{
  const r = extractYtInitialData('var ytInitialData = {"broken": ;</script>');
  check('M1 corrupt => matched=true, data null', r.data === null && r.matched === true);
}
// pageHeaderRenderer variant handle recovery:
{
  const phObj = { header: { pageHeaderRenderer: { content: { pageHeaderViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [ { metadataParts: [ { text: { content: '@newhandle' } } ] } ] } } } } } } };
  const o = extractOwnerIdentity(phObj);
  check('M1 pageHeaderRenderer handle recovered', o.ownerHandle === '@newhandle');
}
// Missing header tolerated (browse response without owner):
check('M1 owner extraction tolerates empty', (() => { const o = extractOwnerIdentity({ contents: {} }); return o.ownerName === '' && o.ownerHandle === '' && o.ownerChannelId === ''; })());
// v1.42.11 (M2): ownerText with text but NO navigationEndpoint.browseEndpoint => a
// bare display name, no strong id. This is the fixture the M2 confidence logic keys on.
{
  const nameOnly = { header: { playlistHeaderRenderer: { ownerText: { runs: [ { text: 'Ken' } ] } } } };
  const o = extractOwnerIdentity(nameOnly);
  check('M2 name-only owner: name captured, no channelId/handle',
    o.ownerName === 'Ken' && o.ownerHandle === '' && o.ownerChannelId === '');
}

// --- Drift guard: mirrors of inline logic inside syncLikedPlaylist (which
// touches chrome.* — full body-mock is exercised below, these keep the wiring). ---
const syncSrc = extractFn('syncLikedPlaylist');
check('drift: partial predicate present in body',
  syncSrc.includes('/^(page-\\d+|init-browse)/'));
check('drift: H1 unknown guard present in body',
  syncSrc.includes("accountId === 'unknown' && !confirmUnknownAccount"));
check('drift: M2 dedup guard present in body',
  syncSrc.includes('if (newOnPage === 0)'));
check('drift: H1 selectUsable scoped filter present in body',
  syncSrc.includes("it.source !== 'loose'"));
check('drift: H1 no-scoped-items guard present in body',
  syncSrc.includes('no-scoped-items'));
// v1.42.7: the token-provenance gate is the actual H1 fix. If someone reintroduces
// an unconditional `continuation = ext.continuation`, these go red.
check('drift: H1 token provenance gate present in body',
  syncSrc.includes('ext.continuationScoped') && syncSrc.includes('ext0.continuationScoped'));
check('drift: H1 refused token flags partial (unproven-continuation)',
  syncSrc.includes('unproven-continuation') && syncSrc.includes('rejectedTokenCount'));
// v1.42.9: an ambiguous primary pick must surface as partial. If someone drops the
// primary-uncertain wiring, this goes red.
check('drift: H1 primary-uncertain flags partial in body',
  syncSrc.includes('primaryUncertain') && syncSrc.includes('primary-uncertain'));
// v1.42.10 (M1): degraded owner recovery + identity-confidence marker. If someone
// reverts to reading identity straight off `parsed.*` or drops the confidence tag,
// these go red.
check('drift: M1 browse owner recovery present in body',
  syncSrc.includes('extractOwnerIdentity(initResp.data)') && syncSrc.includes("identitySource = 'browse-upgraded'"));
// v1.42.12 (M1): the upgrade must be strength-ranked (strict rank increase), not gated on
// "HTML gave nothing". If someone reverts to the `!ownerChannelId && !ownerHandle && !ownerName`
// guard, a weak html-name-only identity stops upgrading to a strong browse channelId/handle.
check('drift: M1 strength-ranked upgrade present in body',
  syncSrc.includes('identityRank(bo.ownerChannelId, bo.ownerHandle, bo.ownerName)')
  && syncSrc.includes('identityRank(ownerChannelId, ownerHandle, ownerName)'));
check('drift: M1 identityConfidence persisted in body',
  syncSrc.includes('identityConfidence') && syncSrc.includes("'unknown-confirmed'"));
// v1.42.11 (M2): a bare display name must be weak-identity ('name-only'), gated on the
// absence of a strong channelId/handle. If someone drops the name-only branch or the
// strong-identity test, name-only again reads like a normal fully-identified sync.
check('drift: M2 name-only weak-identity confidence present in body',
  syncSrc.includes("'name-only'") && syncSrc.includes('ownerChannelId || ownerHandle'));
// §8.1: all fetches after the initial context selection must use one fixed session,
// and the content-side InnerTube header must come from that session (never literal 0).
check('drift: §8.1 fixed-tab sender has a no-fallback branch',
  extractBracedFn('sendToYouTubeTab').includes('chrome.tabs.sendMessage(fixedTabId, message)'));
check('drift: §8.1 sync fetches route through the fixed session sender',
  syncSrc.includes('sendInSyncSession') && !syncSrc.includes("sendToYouTubeTab({ type: 'FETCH_PLAYLIST_HTML'"));
check('drift: §8.1 final session check precedes DB upsert',
  syncSrc.indexOf("sendInSyncSession({ type: 'GET_YOUTUBE_SYNC_CONTEXT' })")
    < syncSrc.indexOf("sendToOffscreenDb('UPSERT_LIKED'"));
check('drift: §8.1 content uses the captured authUser header',
  contentSrc.includes("'X-Goog-AuthUser': authUser")
    && !contentSrc.includes("'X-Goog-AuthUser': '0'"));

// --- v1.42.12 (M2, Codex 2026-07-11 wrapup-review_10): weak-identity warning survives into
// the COPIED prompt's 高評価Top30 section (the data carried out to an external recommender).
// likedPromptNotes is the pure builder renderPrompt feeds; assert it directly. ---
check('M2 prompt-note: name-only emits a weak-identity warning',
  likedPromptNotes({ identityConfidence: 'name-only' }).some((n) => n.includes('表示名のみ') && n.includes('弱識別')));
check('M2 prompt-note: unknown-confirmed emits an unidentified-account warning',
  likedPromptNotes({ identityConfidence: 'unknown-confirmed' }).some((n) => n.includes('アカウント未識別')));
check('M2 prompt-note: strong identity (html) emits NO identity warning',
  !likedPromptNotes({ identityConfidence: 'html' }).some((n) => n.includes('識別')));
check('M2 prompt-note: browse-recovered (strong) emits NO identity warning',
  !likedPromptNotes({ identityConfidence: 'browse-recovered' }).some((n) => n.includes('識別')));
check('M2 prompt-note: partial warned independently of identity',
  likedPromptNotes({ partial: true, identityConfidence: 'html' }).some((n) => n.includes('部分同期')));
check('M2 prompt-note: partial + name-only both present', (() => {
  const ns = likedPromptNotes({ partial: true, identityConfidence: 'name-only' });
  return ns.some((n) => n.includes('部分同期')) && ns.some((n) => n.includes('表示名のみ'));
})());
check('M2 prompt-note: no meta => no notes', likedPromptNotes(null).length === 0);
// drift: renderPrompt must actually feed likedPromptNotes into the exported prompt (not
// re-inline a partial-only check that drops the identity warning again).
check('drift: M2 renderPrompt feeds likedPromptNotes into the exported prompt',
  extractBracedFn('renderPrompt', analyzerSrc).includes('likedPromptNotes(likedMeta)'));

// --- M1 (v1.42.13, Codex 2026-07-11 wrapup-review_9): the account-unknown re-run must
// NOT pre-confirm the account CHANGE. The pre-fix handler passed
// `{ confirmUnknownAccount: true, confirmAccountChange: true }` on the unknown re-run,
// so a known→unknown change was approved by the single unknown prompt. The re-run must
// carry only confirmUnknownAccount and let the account-changed guard surface on its own. ---
{
  const resolveSrc = extractBracedFn('resolveLikedSync', analyzerSrc);
  check('drift: M1 unknown re-run carries confirmUnknownAccount',
    resolveSrc.includes('flags.confirmUnknownAccount = true'));
  check('drift: M1 account-change confirmed separately, not bundled into the unknown prompt',
    resolveSrc.includes('flags.confirmAccountChange = true')
    && !resolveSrc.includes('confirmUnknownAccount: true, confirmAccountChange: true'));
  // The escalation must actually branch on BOTH guard reasons (not short-circuit one).
  check('drift: M1 escalation handles both account-unknown and account-changed',
    resolveSrc.includes("reason === 'account-unknown'")
    && resolveSrc.includes("reason === 'account-changed'"));
  // v1.42.13 (M2, Codex 2026-07-12 wrapup-review): the sync button handler must route
  // through resolveLikedSync as its SOLE escalation path. If a future UI refactor re-inlines
  // the SYNC_LIKED re-run (while leaving the pure function intact), the drift guards above
  // still pass but the bug re-enters. Pin the handler→pure-function wiring so that regresses loudly.
  check('drift: M2 sync handler routes through resolveLikedSync (sole escalation path)',
    analyzerSrc.includes('resolveLikedSync({ doSync, confirm: confirmGuard })'));
}

// --- M1: partial predicate (mirror of syncLikedPlaylist) ---
function partialOf(continuation, errors) {
  const hasMore = !!continuation;
  return hasMore || errors.some((e) => /^(page-\d+|init-browse)/.test(e));
}
check('M1 clean finish => not partial', partialOf('', []) === false);
check('M1 cap hit (continuation remains) => partial', partialOf('TOK', []) === true);
check('M1 page failure => partial', partialOf('', ['page-3: fetch-failed']) === true);
check('M1 empty-page => partial', partialOf('TOK', ['page-4: empty-page']) === true);
check('M1 all-duplicate => partial', partialOf('TOK', ['page-5: all-duplicate']) === true);
check('M1 no-scoped-items (diverged continuation) => partial', partialOf('', ['page-6: no-scoped-items']) === true);
check('M1 refused unproven token => partial', partialOf('', ['page-6: unproven-continuation']) === true);
check('M1 refused unproven token at init-browse => partial', partialOf('', ['init-browse: unproven-continuation']) === true);
check('M1 init-browse failure => partial', partialOf('', ['init-browse: unknown']) === true);
check('M1 non-page warning only => not partial', partialOf('', ['some-other-note']) === false);

// --- H1: unknown-account guard predicate ---
function blocksUnknown(accountId, confirmUnknownAccount) {
  return accountId === 'unknown' && !confirmUnknownAccount;
}
check('H1 unknown + no confirm => blocked', blocksUnknown('unknown', false) === true);
check('H1 unknown + confirm => allowed', blocksUnknown('unknown', true) === false);
check('H1 known account => allowed', blocksUnknown('UCabc', false) === false);

// --- M2 (v1.42.6): loadLiked generation guard — a superseded (older) response
// must not clobber a newer load's rows. Faithful simulation of the mySeq gate. ---
(function testSeqGuard() {
  let loadLikedSeq = 0;
  let likedRecords = ['stale-init'];
  function loadLikedSim() {
    const mySeq = ++loadLikedSeq;
    return (rows) => { if (mySeq !== loadLikedSeq) return; likedRecords = rows; };
  }
  const applyOld = loadLikedSim(); // seq 1 (initial slow load)
  const applyNew = loadLikedSim(); // seq 2 (post-sync fresh load)
  applyNew(['fresh']);             // newest resolves first
  applyOld(['stale']);             // older resolves later — must be ignored
  check('M2 stale response ignored', likedRecords.length === 1 && likedRecords[0] === 'fresh');
})();

// --- l1cm: execute analyzer.js's real >3s late callbacks with a manual clock. ---
// The production loaders, shared refresh, panel renderer, and prompt renderer all run;
// advancing past 3000ms is synchronous, so these regressions never sleep.
function makeLateLikedViewHarness() {
  class FakeElement {
    constructor() {
      this._text = '';
      this.children = [];
      this.textWriteCount = 0;
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      };
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; this.textWriteCount++; }
    appendChild(child) {
      this.children.push(...(child && child.isFragment ? child.children : [child]));
      return child;
    }
  }
  const elements = new Map();
  const selectors = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const document = {
    getElementById: getElement,
    querySelector: (selector) => {
      if (!selectors.has(selector)) selectors.set(selector, new FakeElement());
      return selectors.get(selector);
    },
    createElement: () => new FakeElement(),
    createDocumentFragment: () => Object.assign(new FakeElement(), { isFragment: true }),
  };
  const window = { CreditTarget: {
    isTopicChannelName: () => false,
    stripTopicChannelSuffix: (name) => String(name).replace(/\s*-\s*Topic$/i, ''),
    isValidCreditValue: () => true,
  } };

  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const fakeSetTimeout = (fn, delay) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + Number(delay || 0), fn });
    return id;
  };
  const fakeClearTimeout = (id) => timers.delete(id);
  const advanceBy = (ms) => {
    now += ms;
    [...timers.entries()].filter(([, t]) => t.at <= now).forEach(([id, t]) => {
      if (timers.delete(id)) t.fn();
    });
  };

  const pending = new Map();
  const chrome = { runtime: { sendMessage: (message, callback) => {
    const queue = pending.get(message.type) || [];
    queue.push(callback);
    pending.set(message.type, queue);
  } } };
  const respond = (type, index, response) => {
    const callback = (pending.get(type) || [])[index];
    if (!callback) throw new Error(`missing ${type} callback ${index}`);
    callback(response);
  };

  const fnNames = [
    'appendCell', 'getDurationSec', 'addDurationStat', 'sortByCountThenName',
    'buildChannelCount', 'splitCreditField', 'sourceOf', 'buildCreditCount',
    'buildChannelMusicScore', 'isCleanCreditName', 'topCredits', 'loadLikedMeta',
    'loadLiked', 'refreshLikedViews', 'setPromptCopyStale', 'reloadLikedAfterSync',
    'buildLikedArtistCount', 'renderLikedPanel', 'topLikedArtists', 'displayAccountName',
    'likedPromptNotes', 'renderPrompt',
  ];
  const body = [
    'let likedRecords = [], likedMeta = null, loadLikedMetaSeq = 0, loadLikedSeq = 0;',
    ...fnNames.map((name) => extractBracedFn(name, analyzerSrc)),
    'return { loadLiked, loadLikedMeta, refreshLikedViews, reloadLikedAfterSync, getRows: () => likedRecords.slice() };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'chrome', 'document', 'window', 'setTimeout', 'clearTimeout', 'allData', body);
  return {
    ...factory(chrome, document, window, fakeSetTimeout, fakeClearTimeout, []),
    advanceBy, respond, element: getElement,
  };
}

async function runLateLikedViewTests() {
  {
    const h = makeLateLikedViewHarness();
    const timedOut = h.loadLiked(h.refreshLikedViews);
    h.advanceBy(3001);
    await timedOut;
    h.respond('GET_LIKED', 0, { success: true, rows: [
      { channel: 'Late Artist' }, { channel: 'Late Artist' },
    ] });
    check('l1cm late rows: >3s response re-renders liked panel',
      h.element('azLikedTotal').textContent === '2');
    check('l1cm late rows: >3s response updates copied prompt source',
      h.element('azPromptText').textContent.includes('Late Artist (2回)'));
  }
  {
    const h = makeLateLikedViewHarness();
    const rowsLoaded = h.loadLiked(h.refreshLikedViews);
    h.respond('GET_LIKED', 0, { success: true, rows: [{ channel: 'Meta Artist' }] });
    await rowsLoaded;
    h.refreshLikedViews();
    const metaTimedOut = h.loadLikedMeta(h.refreshLikedViews);
    h.advanceBy(3001);
    await metaTimedOut;
    h.respond('GET_LIKED_META', 0, { meta: {
      ownerHandle: '@late', count: 1, lastSyncedAt: 1, partial: true,
      identityConfidence: 'html',
    } });
    check('l1cm late meta: >3s response re-renders partial warning in panel',
      h.element('azLikedAccount').textContent.includes('部分同期'));
    check('l1cm late meta: >3s response updates copied prompt note',
      h.element('azPromptText').textContent.includes('高評価データは**部分同期**'));
  }
  {
    const h = makeLateLikedViewHarness();
    const metaTimedOut = h.loadLikedMeta(h.refreshLikedViews);
    h.advanceBy(3001);
    await metaTimedOut;
    h.respond('GET_LIKED_META', 0, { meta: {
      ownerHandle: '@meta-only', count: 4, lastSyncedAt: 1, partial: true,
      identityConfidence: 'html',
    } });
    const panelPartial = h.element('azLikedAccount').textContent.includes('部分同期');
    const prompt = h.element('azPromptText').textContent;
    const promptPartial = prompt.includes('高評価データは**部分同期**')
      && prompt.includes('まだ読み込まれていません（同期メタ情報では4件）');
    check('l1cm meta-only late: empty rows still show partial state in panel and prompt',
      panelPartial && promptPartial);
  }
  {
    const h = makeLateLikedViewHarness();
    const syncCompletePos = analyzerSrc.indexOf('msg.textContent = `同期完了:');
    const reloadCallPos = analyzerSrc.indexOf('await reloadLikedAfterSync();', syncCompletePos);
    const wiredAfterSyncComplete = syncCompletePos !== -1 && reloadCallPos > syncCompletePos;
    const reload = h.reloadLikedAfterSync();
    const disabledDuringReload = h.element('azCopyPrompt').disabled === true;
    h.advanceBy(3001);
    await reload;
    const disabledAfterTimeout = h.element('azCopyPrompt').disabled === true
      && h.element('azCopyMsg').textContent.includes('コピーできません');
    h.respond('GET_LIKED', 0, { success: true, rows: [{ channel: 'Fresh After Sync' }] });
    const disabledAfterOneLateResponse = h.element('azCopyPrompt').disabled === true;
    h.respond('GET_LIKED_META', 0, { meta: {
      ownerHandle: '@fresh', count: 1, lastSyncedAt: 1, partial: false,
      identityConfidence: 'html',
    } });
    const enabledAfterBothResponses = h.element('azCopyPrompt').disabled === false;
    check('l1cm post-sync reload: copy stays disabled through timeout until both late responses arrive',
      wiredAfterSyncComplete && disabledDuringReload && disabledAfterTimeout
      && disabledAfterOneLateResponse && enabledAfterBothResponses);
  }
  {
    const h = makeLateLikedViewHarness();
    const oldTimedOut = h.loadLiked(h.refreshLikedViews);
    h.advanceBy(3001);
    await oldTimedOut;
    const freshLoad = h.loadLiked(h.refreshLikedViews);
    h.respond('GET_LIKED', 1, { success: true, rows: [{ channel: 'Fresh Artist' }] });
    await freshLoad;
    h.refreshLikedViews();
    const writesBeforeStale = h.element('azLikedTotal').textWriteCount;
    h.respond('GET_LIKED', 0, { success: true, rows: [{ channel: 'Stale Artist' }] });
    check('l1cm stale late rows: superseded generation is ignored without re-render',
      h.getRows()[0].channel === 'Fresh Artist'
      && h.element('azPromptText').textContent.includes('Fresh Artist (1回)')
      && !h.element('azPromptText').textContent.includes('Stale Artist')
      && h.element('azLikedTotal').textWriteCount === writesBeforeStale);
  }
}

// --- L1 (v1.42.6): run syncLikedPlaylist body with mocked I/O ---
// Injects sendToYouTubeTab / sendToOffscreenDb / chrome / parse+ytcfg mocks and
// the real extractItemsAndContinuation so scoping is exercised end-to-end.
function makeSync(deps) {
  const body = extractBracedFn('syncLikedPlaylist');
  const sessionAwareSend = async (message, fixedTabId) => {
    if (message.type === 'GET_YOUTUBE_SYNC_CONTEXT') {
      if (deps.getSyncContext) return deps.getSyncContext(message, fixedTabId);
      return { success: true, tabId: Number.isInteger(fixedTabId) ? fixedTabId : 101,
        authUser: '0', accountId: 'stable-test-account' };
    }
    return deps.sendToYouTubeTab(message, fixedTabId);
  };
  const syncDbSend = async (op, payload) => {
    if (op === 'GET_LIKED_STATS') {
      return deps.getLikedStats ? deps.getLikedStats() : { total: 0, accounts: [] };
    }
    return deps.sendToOffscreenDb(op, payload);
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'sendToYouTubeTab', 'sendToOffscreenDb', 'chrome', 'parseLikedPlaylistHtml', 'extractYtcfg', 'extractItemsAndContinuation', 'extractOwnerIdentity',
    body + '\nreturn syncLikedPlaylist;'
  );
  return factory(sessionAwareSend, syncDbSend, deps.chrome,
    deps.parseLikedPlaylistHtml, deps.extractYtcfg, deps.extractItemsAndContinuation, deps.extractOwnerIdentity);
}

function lockup(id, title) {
  return { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: id,
    metadata: { lockupMetadataViewModel: { title: { content: title } } } } };
}
function contPage(items, token) {
  const ci = items.map((it) => it);
  if (token) ci.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  return { onResponseReceivedActions: [ { appendContinuationItemsAction: { continuationItems: ci } } ] };
}
function makeChrome() {
  const store = {};
  return { store, chrome: { storage: { local: {
    get: (defaults, cb) => cb(Object.assign({}, defaults, store)),
    set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
  } } } };
}
const baseDeps = () => ({
  parseLikedPlaylistHtml: () => ({ items: [], continuation: '', ownerName: 'Owner', ownerHandle: '@owner', ownerChannelId: 'UCowner' }),
  extractYtcfg: () => ({ apiKey: 'k', clientVersion: '1', context: { client: {} } }),
  extractItemsAndContinuation,
  extractOwnerIdentity,
});

function makeStoredOwnerSyncHarness(likedSyncMeta, likedTotal) {
  const { chrome, store } = makeChrome();
  store.likedSyncMeta = likedSyncMeta;
  const state = { dbWrites: 0, statsReads: 0 };
  const deps = Object.assign(baseDeps(), {
    chrome,
    parseLikedPlaylistHtml: () => ({
      items: [{ videoId: 'vid-owner-guard', title: 'guard', source: 'scoped' }],
      continuation: '',
      ownerName: 'Owner',
      ownerHandle: '@owner',
      ownerChannelId: 'UCowner',
    }),
  });
  deps.sendToYouTubeTab = async (msg) => {
    if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
    if (msg.type === 'FETCH_INNERTUBE_BROWSE') return { success: true, data: {} };
    return { success: false, reason: 'unexpected' };
  };
  deps.getLikedStats = async () => {
    state.statsReads++;
    return { total: likedTotal, accounts: [] };
  };
  deps.sendToOffscreenDb = async (op, payload) => {
    if (op !== 'UPSERT_LIKED') throw new Error('unexpected DB op: ' + op);
    state.dbWrites++;
    return { added: payload.items.length };
  };
  return { syncLikedPlaylist: makeSync(deps), store, state };
}

async function restoreOwnerlessMeta(mode) {
  const initialMeta = mode === 'safe-merge' ? { accountId: 'UCprevious' } : null;
  const harness = makeImportedMetaHarness(initialMeta);
  const result = { liked: { imported: 2 }, likedSyncMeta: null };
  if (mode === 'backup-merge') {
    await harness.storeImportedMeta(result);
  } else if (mode === 'safe-merge') {
    await harness.storeImportedMetaIfAbsent(result);
  } else if (mode === 'replace') {
    harness.store.likedSyncMeta = harness.getReplaceImportedLikedMeta(result);
  } else {
    throw new Error('unknown import mode: ' + mode);
  }
  return harness.store.likedSyncMeta;
}

async function runSyncTests() {
  // Scenario A: out-of-scope lockup mixed into the init browse must NOT be saved.
  {
    let saved = null;
    const { chrome } = makeChrome();
    const initData = {
      onResponseReceivedActions: [ { appendContinuationItemsAction: { continuationItems: [
        lockup('vidA', 'A'), lockup('vidB', 'B'),
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'PAGE2' } } } },
      ] } } ],
      pollutionShelf: { shelfRenderer: { content: [ lockup('vidPOLLUTION', 'ad') ] } },
    };
    const sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.continuation === 'PAGE2') {
        return { success: true, data: contPage([lockup('vidC', 'C')], '') };
      }
      return { success: false, reason: 'unexpected' };
    };
    const sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(Object.assign(baseDeps(), { sendToYouTubeTab, sendToOffscreenDb, chrome }));
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-A sync succeeds', resp.success === true);
    check('L1-A scoped items saved (vidA/B/C)', ids.includes('vidA') && ids.includes('vidB') && ids.includes('vidC'));
    check('L1-A loose pollution NOT saved', !ids.includes('vidPOLLUTION'));
    check('L1-A droppedLoose counted', resp.diagnostics && resp.diagnostics.droppedLoose >= 1);
    check('L1-A saved records carry no source tag', (saved || []).every((x) => !('source' in x)));
  }

  // Scenario B (v1.42.7): the init-browse items sit in a container whose NAME we do
  // not recognize. Structural primary-container selection accepts them anyway, so the
  // sync is complete and NON-partial — no name allowlist, no fallback machinery.
  // (v1.42.6 needed a `scope-fallback` rescue here, which then misfired as a false
  // "部分同期". Do NOT reintroduce either.)
  {
    let saved = null;
    const { chrome } = makeChrome();
    // Unnamed container: lockups sit under a plain `contents` array.
    const initData = { contents: [ lockup('vidLooseOnly1', 'x'), lockup('vidLooseOnly2', 'y') ] };
    const sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      return { success: false, reason: 'unexpected' };
    };
    const sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(Object.assign(baseDeps(), { sendToYouTubeTab, sendToOffscreenDb, chrome }));
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-B unnamed container accepted structurally (no name allowlist needed)',
      resp.success === true && ids.includes('vidLooseOnly1') && ids.includes('vidLooseOnly2'));
    check('L1-B unnamed container is NOT partial (it IS the primary container)', resp.partial === false);
    check('L1-B nothing dropped and no scope-fallback machinery',
      resp.diagnostics.droppedLoose === 0
      && !(resp.errors || []).some((e) => /scope-fallback/.test(e))
      && resp.diagnostics.scopeFallbacks === undefined);
  }

  // zn5r: a tie between same-size unnamed containers leaves the real liked-list body
  // unknown. None of that page's guessed items may reach UPSERT_LIKED, and the result
  // must retain the existing partial/error signal instead of reading as a clean sync.
  {
    let dbWrites = 0;
    const { chrome } = makeChrome();
    const initData = {
      onResponseReceivedActions: [
        { appendContinuationItemsAction: { continuationItems: [ lockup('vidGuessA', 'ga') ] } },
        { reloadContinuationItemsCommand: { continuationItems: [ lockup('vidGuessB', 'gb') ] } },
      ],
    };
    const sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') {
        return { success: true, data: initData };
      }
      return { success: false, reason: 'unexpected' };
    };
    const sendToOffscreenDb = async () => {
      dbWrites++;
      return { added: 0 };
    };
    const syncLikedPlaylist = makeSync(Object.assign(baseDeps(), { sendToYouTubeTab, sendToOffscreenDb, chrome }));
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('zn5r ambiguous init: DB write is zero',
      dbWrites === 0);
    check('zn5r ambiguous init: reported incomplete with primary-uncertain',
      resp.success === false && resp.reason === 'no-items' && resp.partial === true
      && (resp.errors || []).some((e) => e === 'init-browse: primary-uncertain'));
  }

  // zn5r regression: a non-tied single container remains the normal save path.
  {
    let saved = null;
    let dbWrites = 0;
    const { chrome } = makeChrome();
    const initData = { contents: [ lockup('vidCertain', 'certain') ] };
    const sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') {
        return { success: true, data: initData };
      }
      return { success: false, reason: 'unexpected' };
    };
    const sendToOffscreenDb = async (op, payload) => {
      dbWrites++;
      saved = payload.items;
      return { added: payload.items.length };
    };
    const syncLikedPlaylist = makeSync(Object.assign(baseDeps(), { sendToYouTubeTab, sendToOffscreenDb, chrome }));
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('zn5r certain init: normal item is still saved',
      resp.success === true && resp.partial === false && dbWrites === 1
      && saved && saved.length === 1 && saved[0].videoId === 'vidCertain');
  }

  // The same guard is shared by continuation pages: keep earlier proven rows but
  // discard every item from the first ambiguous continuation page.
  {
    let saved = null;
    const { chrome } = makeChrome();
    const initData = contPage([lockup('vidCertainPage1', 'p1')], 'AMBIGUOUS_PAGE');
    const ambiguousPage = {
      onResponseReceivedActions: [
        { appendContinuationItemsAction: { continuationItems: [ lockup('vidPageGuessA', 'pga') ] } },
        { reloadContinuationItemsCommand: { continuationItems: [ lockup('vidPageGuessB', 'pgb') ] } },
      ],
    };
    const sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') {
        return { success: true, data: initData };
      }
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.continuation === 'AMBIGUOUS_PAGE') {
        return { success: true, data: ambiguousPage };
      }
      return { success: false, reason: 'unexpected' };
    };
    const sendToOffscreenDb = async (op, payload) => {
      saved = payload.items;
      return { added: payload.items.length };
    };
    const syncLikedPlaylist = makeSync(Object.assign(baseDeps(), { sendToYouTubeTab, sendToOffscreenDb, chrome }));
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    const ids = (saved || []).map((x) => x.videoId);
    check('zn5r ambiguous continuation: guessed page items are not saved',
      resp.success === true && resp.partial === true
      && ids.join(',') === 'vidCertainPage1'
      && (resp.errors || []).some((e) => e === 'page-2: primary-uncertain'));
  }

  // Scenario C (v1.42.7 — THE H1 regression test, Codex 2026-07-10):
  // A continuation token that lives OUTSIDE the primary container (here: a
  // recommendation shelf's own continuationItemRenderer) must never be fetched.
  // This is the divergence *source*: once such a token is followed, its response is
  // structurally identical to a real LL page (same generic appendContinuationItemsAction
  // envelope) and no downstream check can tell them apart — which is exactly the hole
  // v1.42.6 left open. Refusing the token also flags partial, so a refused (possibly
  // legit) token can never masquerade as a clean, complete sync.
  {
    let saved = null;
    const fetchedContinuations = [];
    const { chrome } = makeChrome();
    // Primary container: 2 real liked items, NO token of its own.
    // Sibling shelf: fewer items + a token. The token must be ignored.
    const initData = {
      onResponseReceivedActions: [
        { appendContinuationItemsAction: { continuationItems: [
          lockup('vidReal1', 'r1'), lockup('vidReal2', 'r2'),
        ] } },
      ],
      sidebar: { shelfRenderer: { content: [
        lockup('vidReco', 'reco'),
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'RECO_TOKEN' } } } },
      ] } },
    };
    const recoPage = contPage([lockup('vidRecoPage2', 'reco2')], '');
    const sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.continuation) {
        fetchedContinuations.push(msg.body.continuation);
        return { success: true, data: recoPage }; // would look like a legit LL page
      }
      return { success: false, reason: 'unexpected' };
    };
    const sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(Object.assign(baseDeps(), { sendToYouTubeTab, sendToOffscreenDb, chrome }));
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-C real (primary-container) items kept', ids.includes('vidReal1') && ids.includes('vidReal2'));
    check('L1-C sibling-shelf item NOT saved', !ids.includes('vidReco'));
    check('L1-C out-of-container token NEVER fetched', fetchedContinuations.length === 0);
    check('L1-C its would-be page never reached the DB', !ids.includes('vidRecoPage2'));
    check('L1-C refusing a token flags partial (no false "complete")', resp.partial === true);
    check('L1-C partial reason is unproven-continuation',
      (resp.errors || []).some((e) => /unproven-continuation/.test(e)));
  }

  // Scenario D: static HTML yields loose-only items => dropped at the html phase
  // (no fallback, no `html: scope-fallback` warning), browse backfills. Mirrors the
  // 2026-07 smoke where LL static HTML embedded items in an unrecognized container.
  {
    let saved = null;
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      // Override: HTML parse returns loose-only items (no LL container match).
      parseLikedPlaylistHtml: () => ({ items: [{ videoId: 'vidHtmlLoose', title: 'h', channel: '', playlistIndex: 0, source: 'loose' }],
        continuation: '', ownerName: 'Owner', ownerHandle: '@owner', ownerChannelId: 'UCowner' }),
    });
    deps.chrome = chrome;
    const initData = contPage([lockup('vidX', 'X'), lockup('vidY', 'Y')], '');
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(deps);
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-D browse backfills html-dropped set', ids.includes('vidX') && ids.includes('vidY'));
    check('L1-D loose html item NOT saved', !ids.includes('vidHtmlLoose'));
    check('L1-D no html: scope-fallback warning', !(resp.errors || []).some((e) => /^html/.test(e)));
    check('L1-D not partial (html drop is silent)', resp.partial === false);
    check('L1-D droppedLoose counts the html drop', resp.diagnostics && resp.diagnostics.droppedLoose >= 1);
  }

  // Scenario E (v1.42.8 — THE M3 regression test, Codex 2026-07-10):
  // ytInitialData parse failure must NOT stop the sync. Since v1.42.7 the static HTML
  // is only a prelude (the authoritative VLLL browse supplies both items and token),
  // so the sole casualty is the owner identity — and that already has a guard. Under
  // the old code this returned {success:false, reason:'no-ytInitialData'} and nothing
  // was ever fetched, so this scenario fails on the pre-v1.42.8 implementation.
  {
    let saved = null;
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      // ytInitialData missing => skeleton with an error and no owner identity.
      parseLikedPlaylistHtml: () => ({ items: [], continuation: '', ownerName: '', ownerHandle: '',
        ownerChannelId: '', error: 'no-ytInitialData' }),
    });
    deps.chrome = chrome;
    const initData = contPage([lockup('vidDeg1', 'd1'), lockup('vidDeg2', 'd2')], '');
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(deps);

    // Without confirmation the owner-unknown guard must still fire (degraded mode does
    // NOT weaken the account guard — it delegates to it).
    const guarded = await syncLikedPlaylist({});
    check('L1-E degraded still hits account-unknown guard',
      guarded.success === false && guarded.reason === 'account-unknown' && guarded.degraded === 'no-ytInitialData');
    check('L1-E guard reports the items it did fetch', guarded.fetched === 2);

    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-E parse failure no longer stops the sync', resp.success === true);
    check('L1-E browse items still harvested', ids.includes('vidDeg1') && ids.includes('vidDeg2'));
    check('L1-E parse error surfaces as a warning, not a stop',
      (resp.errors || []).some((e) => e === 'html: no-ytInitialData'));
    check('L1-E degraded flag exposed', resp.degraded === 'no-ytInitialData' && resp.diagnostics.degraded === 'no-ytInitialData');
    // The item set came from the authoritative browse and paginated to exhaustion,
    // so it is complete: a degraded parse must not be mislabelled a partial sync.
    check('L1-E degraded is NOT partial', resp.partial === false);
  }

  // Scenario F (v1.42.8): the degraded path has a floor. If neither the API key nor the
  // InnerTube context survives, the HTML is not a usable YouTube page (consent wall /
  // error page) — browse cannot run, so fail with the original reason instead of
  // prompting the user to save an unidentified account.
  {
    let dbCalled = false;
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      parseLikedPlaylistHtml: () => ({ items: [], continuation: '', ownerName: '', ownerHandle: '',
        ownerChannelId: '', error: 'parse-failed' }),
      extractYtcfg: () => ({ apiKey: '', clientVersion: '', context: null }),
    });
    deps.chrome = chrome;
    let browseAttempts = 0;
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      browseAttempts++;
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async () => { dbCalled = true; return { added: 0 }; };
    const syncLikedPlaylist = makeSync(deps);
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('L1-F unusable HTML still hard-fails with the parse reason',
      resp.success === false && resp.reason === 'parse-failed' && resp.degraded === true);
    check('L1-F no browse attempted, nothing persisted', browseAttempts === 0 && dbCalled === false);
  }

  // Scenario G (v1.42.9 — THE H1/M2 regression test, Codex 2026-07-10):
  // A recommendation sibling under a GENERIC continuation envelope carries MORE lockups
  // (and its own token) than the real liked body under a playlist-specific renderer. The
  // structural anchor must keep the body primary: the larger sibling must NOT hijack
  // primary, its items must NOT be saved, and its token must NEVER be fetched. On the
  // pre-v1.42.9 code the generic envelope counted as a known LL name, so the larger
  // sibling won and both polluted the DB and diverged pagination — this scenario is RED
  // there. (M2 asked for an end-to-end "don't fetch the wrong primary's token" check.)
  {
    let saved = null;
    const fetchedContinuations = [];
    const { chrome } = makeChrome();
    const initData = {
      contents: { playlistVideoListRenderer: { contents: [
        lockup('vidLiked1', 'l1'), lockup('vidLiked2', 'l2'),
      ] } },
      onResponseReceivedActions: [ { appendContinuationItemsAction: { continuationItems: [
        lockup('vidReco1', 'r1'), lockup('vidReco2', 'r2'), lockup('vidReco3', 'r3'),
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'RECO_BIG_TOKEN' } } } },
      ] } } ],
    };
    const sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.continuation) {
        fetchedContinuations.push(msg.body.continuation);
        return { success: true, data: contPage([lockup('vidRecoPage2', 'rp2')], '') };
      }
      return { success: false, reason: 'unexpected' };
    };
    const sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(Object.assign(baseDeps(), { sendToYouTubeTab, sendToOffscreenDb, chrome }));
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-G named body kept as primary despite smaller count',
      ids.includes('vidLiked1') && ids.includes('vidLiked2'));
    check('L1-G larger generic-envelope sibling NOT saved',
      !ids.includes('vidReco1') && !ids.includes('vidReco2') && !ids.includes('vidReco3'));
    check('L1-G sibling token NEVER fetched', fetchedContinuations.length === 0);
    check('L1-G sibling page never reached the DB', !ids.includes('vidRecoPage2'));
  }

  // Scenario H (v1.42.10 — M1 owner recovery from the authoritative browse):
  // The static HTML lost owner identity (degraded parse), but the VLLL browse carries
  // the playlist header. We must adopt that owner so the sync succeeds WITHOUT ever
  // hitting the account-unknown prompt, and mark identityConfidence='browse-recovered'.
  {
    let saved = null;
    const { chrome, store } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      // Degraded: no owner from HTML, parse error present.
      parseLikedPlaylistHtml: () => ({ items: [], continuation: '', ownerName: '', ownerHandle: '',
        ownerChannelId: '', error: 'no-ytInitialData' }),
    });
    deps.chrome = chrome;
    const initData = {
      header: { playlistHeaderRenderer: { ownerText: { runs: [ { text: 'Ken',
        navigationEndpoint: { browseEndpoint: { browseId: 'UCkenrec', canonicalBaseUrl: '/@kenrec' } } } ] } } },
      onResponseReceivedActions: [ { appendContinuationItemsAction: { continuationItems: [
        lockup('vidH1', 'h1'), lockup('vidH2', 'h2'),
      ] } } ],
    };
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(deps);
    // NOTE: no confirmUnknownAccount — recovery must make the prompt unnecessary.
    const resp = await syncLikedPlaylist({});
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-H recovered owner avoids account-unknown prompt', resp.success === true && resp.reason === undefined);
    check('L1-H accountId came from browse header', resp.accountId === 'UCkenrec' && resp.ownerHandle === '@kenrec');
    check('L1-H items still harvested', ids.includes('vidH1') && ids.includes('vidH2'));
    check('L1-H identityConfidence=browse-recovered', resp.identityConfidence === 'browse-recovered'
      && resp.diagnostics.identitySource === 'browse-upgraded');
    check('L1-H meta persists the recovered confidence',
      store.likedSyncMeta && store.likedSyncMeta.identityConfidence === 'browse-recovered'
      && store.likedSyncMeta.accountId === 'UCkenrec');
  }

  // Scenario I (v1.42.10 — M1 unknown-confirmed marker):
  // Owner is unrecoverable (HTML degraded AND the browse carries no header). Saving
  // still requires explicit confirmUnknownAccount, and the persisted meta must record
  // identityConfidence='unknown-confirmed' + unknownConfirmedAt so the next open does
  // not look like a normal, fully-identified sync.
  {
    let saved = null;
    const { chrome, store } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      parseLikedPlaylistHtml: () => ({ items: [], continuation: '', ownerName: '', ownerHandle: '',
        ownerChannelId: '', error: 'no-ytInitialData' }),
    });
    deps.chrome = chrome;
    // Browse has items but NO header => owner stays unknown.
    const initData = contPage([lockup('vidI1', 'i1'), lockup('vidI2', 'i2')], '');
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(deps);
    // Without confirmation the guard still fires (recovery found nothing).
    const guarded = await syncLikedPlaylist({});
    check('L1-I unrecoverable owner still hits account-unknown guard',
      guarded.success === false && guarded.reason === 'account-unknown');
    const resp = await syncLikedPlaylist({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('L1-I confirmed save succeeds with unknown account',
      resp.success === true && resp.accountId === 'unknown');
    check('L1-I identityConfidence=unknown-confirmed', resp.identityConfidence === 'unknown-confirmed');
    check('L1-I meta records unknown-confirmed + timestamp',
      store.likedSyncMeta && store.likedSyncMeta.identityConfidence === 'unknown-confirmed'
      && typeof store.likedSyncMeta.unknownConfirmedAt === 'number');
  }

  // Scenario J (v1.42.11 — M2 name-only weak identity, Codex 2026-07-11 wrapup-review_9):
  // HTML is degraded (no owner). The VLLL browse header carries ownerText with a bare
  // display name — runs[0].text only, NO navigationEndpoint.browseEndpoint — so no
  // channelId/handle can be recovered. The name IS better than 'unknown' (so the
  // account-unknown prompt must NOT fire), but it is a WEAK identity: a different account
  // sharing the display name could merge in undetected. The save must succeed and record
  // identityConfidence='name-only', which takes precedence over 'browse-recovered' even
  // though the identity was recovered from the browse response. This fixture is RED on the
  // pre-v1.42.11 code (name-only was recorded as 'browse-recovered', reading like a normal
  // fully-identified sync).
  {
    let saved = null;
    const { chrome, store } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      parseLikedPlaylistHtml: () => ({ items: [], continuation: '', ownerName: '', ownerHandle: '',
        ownerChannelId: '', error: 'no-ytInitialData' }),
    });
    deps.chrome = chrome;
    const initData = {
      // ownerText run with text but NO navigationEndpoint => bare display name.
      header: { playlistHeaderRenderer: { ownerText: { runs: [ { text: 'Ken' } ] } } },
      onResponseReceivedActions: [ { appendContinuationItemsAction: { continuationItems: [
        lockup('vidJ1', 'j1'), lockup('vidJ2', 'j2'),
      ] } } ],
    };
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(deps);
    // NOTE: no confirmUnknownAccount — a recovered display name is not 'unknown'.
    const resp = await syncLikedPlaylist({});
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-J name-only recovery avoids account-unknown prompt',
      resp.success === true && resp.reason === undefined);
    check('L1-J accountId falls back to the display name', resp.accountId === 'Ken'
      && resp.ownerName === 'Ken' && resp.ownerHandle === '' && resp.ownerChannelId === '');
    check('L1-J items still harvested', ids.includes('vidJ1') && ids.includes('vidJ2'));
    check('L1-J identityConfidence=name-only (precedence over browse-recovered)',
      resp.identityConfidence === 'name-only');
    check('L1-J meta persists the weak name-only confidence',
      store.likedSyncMeta && store.likedSyncMeta.identityConfidence === 'name-only'
      && store.likedSyncMeta.accountId === 'Ken');
  }

  // Scenario K (v1.42.12 — M1 strength-ranked upgrade, Codex 2026-07-11 wrapup-review_10):
  // HTML parses ONLY a bare display name (ownerName='Ken', no channelId/handle), but the
  // authoritative VLLL browse header carries a channelId + handle. The pre-v1.42.12 guard
  // skipped extractOwnerIdentity whenever HTML gave ANY owner (a name counted), freezing the
  // weak name and saving accountId='Ken' with identityConfidence='name-only'. Strength
  // ranking must now upgrade the weak html-name-only identity to the strong browse
  // channelId/handle. RED on the old guard (it kept accountId='Ken').
  {
    let saved = null;
    const { chrome, store } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      // HTML gave a bare display name only — no channelId/handle, no continuation, no error.
      parseLikedPlaylistHtml: () => ({ items: [], continuation: '', ownerName: 'Ken',
        ownerHandle: '', ownerChannelId: '' }),
    });
    deps.chrome = chrome;
    const initData = {
      header: { playlistHeaderRenderer: { ownerText: { runs: [ { text: 'Ken',
        navigationEndpoint: { browseEndpoint: { browseId: 'UCkenstrong', canonicalBaseUrl: '/@kenstrong' } } } ] } } },
      onResponseReceivedActions: [ { appendContinuationItemsAction: { continuationItems: [
        lockup('vidK1', 'k1'), lockup('vidK2', 'k2'),
      ] } } ],
    };
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') return { success: true, data: initData };
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async (op, payload) => { saved = payload.items; return { added: payload.items.length }; };
    const syncLikedPlaylist = makeSync(deps);
    // NOTE: no confirmUnknownAccount — 'Ken' is not 'unknown'; the point is the UPGRADE.
    const resp = await syncLikedPlaylist({});
    const ids = (saved || []).map((x) => x.videoId);
    check('L1-K name-only HTML upgraded to strong browse identity',
      resp.success === true && resp.accountId === 'UCkenstrong' && resp.ownerHandle === '@kenstrong');
    check('L1-K items still harvested', ids.includes('vidK1') && ids.includes('vidK2'));
    check('L1-K identityConfidence=browse-recovered (weak->strong upgrade)',
      resp.identityConfidence === 'browse-recovered'
      && resp.diagnostics.identitySource === 'browse-upgraded');
    check('L1-K meta persists the upgraded strong identity',
      store.likedSyncMeta && store.likedSyncMeta.accountId === 'UCkenstrong'
      && store.likedSyncMeta.identityConfidence === 'browse-recovered');
  }

  // §8.1 acceptance (a): changing the active YouTube tab during sync must not change
  // the destination tab or auth-user header for any fetch.
  {
    let activeTabId = 11;
    let contextCalls = 0;
    let dbWrites = 0;
    const fetchCalls = [];
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), { chrome });
    deps.getSyncContext = async (msg, fixedTabId) => {
      contextCalls++;
      return { success: true, tabId: Number.isInteger(fixedTabId) ? fixedTabId : activeTabId,
        authUser: '3', accountId: 'account-A' };
    };
    deps.sendToYouTubeTab = async (msg, fixedTabId) => {
      fetchCalls.push({ type: msg.type, tabId: fixedTabId, authUser: msg.authUser,
        syncSessionId: msg.syncSessionId });
      if (msg.type === 'FETCH_PLAYLIST_HTML') {
        activeTabId = 22;
        return { success: true, html: '<html></html>' };
      }
      if (msg.type === 'FETCH_INNERTUBE_BROWSE' && msg.body.browseId === 'VLLL') {
        return { success: true, data: contPage([lockup('vidS81A1', 'a1')], '') };
      }
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async () => { dbWrites++; return { added: 1 }; };
    const resp = await makeSync(deps)({ confirmUnknownAccount: true, confirmAccountChange: true });
    const sessionIds = new Set(fetchCalls.map((c) => c.syncSessionId));
    check('§8.1(a) active-tab change keeps every fetch on the start tab/account',
      resp.success === true && contextCalls === 2 && dbWrites === 1
      && fetchCalls.length >= 2 && fetchCalls.every((c) => c.tabId === 11 && c.authUser === '3')
      && sessionIds.size === 1 && !fetchCalls.some((c) => c.tabId === 22));
  }

  // §8.1 acceptance (b): a different end account must skip the DB write entirely.
  {
    let contextCalls = 0;
    let dbWrites = 0;
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), { chrome });
    deps.getSyncContext = async (msg, fixedTabId) => {
      contextCalls++;
      return { success: true, tabId: Number.isInteger(fixedTabId) ? fixedTabId : 31,
        authUser: '1', accountId: contextCalls === 1 ? 'account-start' : 'account-other' };
    };
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE') {
        return { success: true, data: contPage([lockup('vidS81B1', 'b1')], '') };
      }
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async () => { dbWrites++; return { added: 1 }; };
    const resp = await makeSync(deps)({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('§8.1(b) end-account mismatch performs zero DB writes',
      resp.success === false && resp.reason === 'sync-session-changed'
      && resp.dbWriteSkipped === true && dbWrites === 0
      && resp.errors.some((e) => e.includes('DBへ保存せず中止')));
  }

  // §8.1 regression: the playlist HTML fetched mid-sync can reveal that authUser
  // changed even when the final context probe would look stable again. This must
  // abort at the response-side guard, before any browse fetch or DB write, so this
  // case cannot pass merely because the separate end-of-sync guard still exists.
  {
    let contextCalls = 0;
    let browseCalls = 0;
    let dbWrites = 0;
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), {
      chrome,
      extractYtcfg: () => ({ apiKey: 'k', clientVersion: '1', context: { client: {} },
        authUser: '8' }),
    });
    deps.getSyncContext = async (msg, fixedTabId) => {
      contextCalls++;
      return { success: true, tabId: Number.isInteger(fixedTabId) ? fixedTabId : 35,
        authUser: '7', accountId: 'account-mid-fetch' };
    };
    deps.sendToYouTubeTab = async (msg) => {
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE') {
        browseCalls++;
        return { success: true, data: contPage([lockup('vidS81MID1', 'mid')], '') };
      }
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async () => { dbWrites++; return { added: 1 }; };
    const resp = await makeSync(deps)({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('§8.1 mid-fetch authUser mismatch aborts before browse/end guard and DB write',
      resp.success === false && resp.reason === 'sync-session-changed'
      && resp.dbWriteSkipped === true && browseCalls === 0 && contextCalls === 1 && dbWrites === 0);
  }

  // §8.1 acceptance (c): once the chosen tab disappears, never retry an alternate tab.
  {
    let dbWrites = 0;
    let alternateTabCalls = 0;
    const attemptedTabIds = [];
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), { chrome });
    deps.getSyncContext = async (msg, fixedTabId) => ({ success: true,
      tabId: Number.isInteger(fixedTabId) ? fixedTabId : 41, authUser: '2', accountId: 'account-C' });
    deps.sendToYouTubeTab = async (msg, fixedTabId) => {
      attemptedTabIds.push(fixedTabId);
      if (fixedTabId === 41) throw new Error('The tab was closed');
      alternateTabCalls++;
      return { success: true, html: '<html></html>' };
    };
    deps.sendToOffscreenDb = async () => { dbWrites++; return { added: 1 }; };
    const resp = await makeSync(deps)({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('§8.1(c) missing fixed tab aborts without alternate-tab fallback',
      resp.success === false && resp.reason === 'sync-tab-unavailable'
      && dbWrites === 0 && alternateTabCalls === 0
      && attemptedTabIds.length === 1 && attemptedTabIds[0] === 41
      && resp.errors.some((e) => e.includes('別タブへ切り替えず')));
  }

  // §8.1 acceptance (d): stable tab/account retains the normal successful path.
  {
    let dbWrites = 0;
    let contextCalls = 0;
    const fetchCalls = [];
    const { chrome } = makeChrome();
    const deps = Object.assign(baseDeps(), { chrome });
    deps.getSyncContext = async (msg, fixedTabId) => {
      contextCalls++;
      return { success: true, tabId: Number.isInteger(fixedTabId) ? fixedTabId : 51,
        authUser: '4', accountId: 'account-D' };
    };
    deps.sendToYouTubeTab = async (msg, fixedTabId) => {
      fetchCalls.push({ msg, fixedTabId });
      if (msg.type === 'FETCH_PLAYLIST_HTML') return { success: true, html: '<html></html>' };
      if (msg.type === 'FETCH_INNERTUBE_BROWSE') {
        return { success: true, data: contPage([lockup('vidS81D1', 'd1')], '') };
      }
      return { success: false, reason: 'unexpected' };
    };
    deps.sendToOffscreenDb = async (op, payload) => {
      dbWrites++;
      return { added: payload.items.length };
    };
    const resp = await makeSync(deps)({ confirmUnknownAccount: true, confirmAccountChange: true });
    check('§8.1(d) stable tab/account completes the normal sync',
      resp.success === true && dbWrites === 1 && contextCalls === 2
      && resp.fetched === 1 && resp.added === 1
      && resp.diagnostics.tabId === 51 && resp.diagnostics.authUser === '4'
      && fetchCalls.every((c) => c.fixedTabId === 51));
  }

  // u1ps: liked rows with no stored owner must enter the existing account-change
  // confirmation flow. Declining must leave the DB untouched.
  {
    const h = makeStoredOwnerSyncHarness(null, 2);
    const confirmations = [];
    const { cancelled, resp } = await resolveLikedSync({
      doSync: (flags) => h.syncLikedPlaylist(flags),
      confirm: (kind, r) => { confirmations.push({ kind, response: r }); return false; },
    });
    check('u1ps metaなし + likedあり: 確認拒否でDB書込み0',
      cancelled === true && resp.success === false && resp.reason === 'account-changed'
      && resp.dbWriteSkipped === true && h.state.dbWrites === 0
      && h.state.statsReads === 1 && confirmations.length === 1
      && confirmations[0].kind === 'account-changed');
    check('u1ps 持ち主不明確認: 判断可能な日本語警告を返す',
      resp.warning === 'このデータの持ち主アカウントが不明です。今のアカウントで同期すると別アカウントのデータと混ざる可能性があります。'
      && resp.previous && resp.previous.ownerName === resp.warning
      && resp.previous.ownerHandle === '' && resp.previous.ownerChannelId === '');
  }

  {
    const h = makeStoredOwnerSyncHarness(null, 2);
    const confirmations = [];
    const { cancelled, resp } = await resolveLikedSync({
      doSync: (flags) => h.syncLikedPlaylist(flags),
      confirm: (kind) => { confirmations.push(kind); return true; },
    });
    check('u1ps metaなし + likedあり: 承認後は従来どおり同期',
      cancelled === false && resp.success === true && h.state.dbWrites === 1
      && confirmations.join(',') === 'account-changed'
      && h.store.likedSyncMeta && h.store.likedSyncMeta.accountId === 'UCowner');
  }

  check('u1ps 3 Importモード: background handlerが未確認meta保存を配線',
    src.includes('await storeImportedMeta(result)')
    && src.includes('await storeImportedMetaIfAbsent(result)')
    && src.includes('likedSyncMeta: getReplaceImportedLikedMeta(result)'));

  for (const [mode, label] of [
    ['replace', '置換'],
    ['safe-merge', '安全統合'],
    ['backup-merge', 'backup優先統合'],
  ]) {
    const importedMeta = await restoreOwnerlessMeta(mode);
    const h = makeStoredOwnerSyncHarness(importedMeta, 2);
    const resp = await h.syncLikedPlaylist({});
    check('u1ps Import ' + label + ': metaなしliked復元後は次回同期で確認要求',
      importedMeta && importedMeta.ownerUnverified === true && !importedMeta.accountId
      && importedMeta.restoredLikedCount === 2
      && resp.success === false && resp.reason === 'account-changed'
      && resp.dbWriteSkipped === true && h.state.dbWrites === 0);
  }

  {
    const h = makeStoredOwnerSyncHarness({ accountId: 'UCowner', ownerName: 'Owner' }, 2);
    let confirmations = 0;
    const { cancelled, resp } = await resolveLikedSync({
      doSync: (flags) => h.syncLikedPlaylist(flags),
      confirm: () => { confirmations++; return true; },
    });
    check('u1ps accountId一致: 通常同期は確認なし',
      cancelled === false && resp.success === true && confirmations === 0
      && h.state.statsReads === 0 && h.state.dbWrites === 1);
  }
}

// --- M1 (v1.42.13, Codex 2026-07-11 wrapup-review_9): resolveLikedSync escalation.
// Drives the pure confirmation driver against a FAITHFUL background mock whose response
// depends on the flags passed (mirroring background.js: the account-unknown guard at
// L2466 and the account-changed guard at L2481). Because the mock re-decides on every
// re-run, the pre-fix logic (unknown re-run passing confirmAccountChange too) would
// bypass the change guard and save known→unknown with a single prompt — so these
// escalation assertions are RED on the old both-flags handler. ---
function makeBackgroundMock({ storedAccount = null, syncAccount }) {
  const calls = [];
  const doSync = async (flags) => {
    calls.push({ ...flags });
    // Guard 1 (L2466): never persist 'unknown' without explicit opt-in.
    if (syncAccount === 'unknown' && !flags.confirmUnknownAccount) {
      return { success: false, reason: 'account-unknown' };
    }
    // Guard 2 (L2481): a stored account that differs needs its own opt-in.
    if (storedAccount && storedAccount !== syncAccount && !flags.confirmAccountChange) {
      return { success: false, reason: 'account-changed',
        previous: { accountId: storedAccount }, current: { accountId: syncAccount } };
    }
    return { success: true, added: 2, fetched: 2, accountId: syncAccount };
  };
  return { doSync, calls };
}

async function runResolveTests() {
  // The M1 bug repro: stored account KNOWN, this (degraded) sync's owner unknown.
  //   call 1 (no flags)              -> account-unknown
  //   call 2 (confirmUnknownAccount) -> account-changed  (MUST surface — pre-fix it didn't)
  //   call 3 (both flags)            -> success
  {
    const { doSync, calls } = makeBackgroundMock({ storedAccount: 'UCknown', syncAccount: 'unknown' });
    const confirmed = [];
    const { cancelled, resp } = await resolveLikedSync({ doSync, confirm: (k) => { confirmed.push(k); return true; } });
    check('M1 escalation: both guards surfaced & confirmed, in order',
      confirmed.join(',') === 'account-unknown,account-changed');
    check('M1 escalation: 3 doSync calls (initial + 2 re-runs)', calls.length === 3);
    check('M1 escalation: unknown re-run carries confirmUnknownAccount ONLY (no confirmAccountChange)',
      calls[1].confirmUnknownAccount === true && calls[1].confirmAccountChange !== true);
    check('M1 escalation: final re-run carries BOTH flags after the change is confirmed',
      calls[2].confirmUnknownAccount === true && calls[2].confirmAccountChange === true);
    check('M1 escalation: resolves to success only after the change is separately approved',
      !cancelled && !!resp && resp.success === true);
  }

  // known→unknown, user DECLINES the change prompt => cancelled, nothing saved. On the
  // pre-fix handler the change guard never surfaced, so this would have SAVED silently.
  {
    const { doSync, calls } = makeBackgroundMock({ storedAccount: 'UCknown', syncAccount: 'unknown' });
    const { cancelled } = await resolveLikedSync({ doSync, confirm: (k) => k === 'account-unknown' });
    check('M1 escalation: declining the change cancels the known→unknown save',
      cancelled === true && calls.length === 2 && calls[2] === undefined);
  }

  // First-sync unknown (no stored account): no change guard fires, single confirm saves.
  {
    const { doSync, calls } = makeBackgroundMock({ storedAccount: null, syncAccount: 'unknown' });
    const confirmed = [];
    const { cancelled, resp } = await resolveLikedSync({ doSync, confirm: (k) => { confirmed.push(k); return true; } });
    check('M1 escalation: first-sync unknown saves after one confirm, no spurious change flag',
      !cancelled && resp.success === true && confirmed.join(',') === 'account-unknown'
      && calls.length === 2 && calls[1].confirmUnknownAccount === true && calls[1].confirmAccountChange !== true);
  }

  // unknown→unknown (stored account was also unknown): the change guard treats them as
  // equal, so a single unknown confirmation saves (the pre-existing H1 limitation).
  {
    const { doSync, calls } = makeBackgroundMock({ storedAccount: 'unknown', syncAccount: 'unknown' });
    const { cancelled, resp } = await resolveLikedSync({ doSync, confirm: () => true });
    check('M1 escalation: unknown→unknown saves with one confirm (no false change prompt)',
      !cancelled && resp.success === true && calls.length === 2);
  }

  // Declining the unknown prompt cancels immediately (single doSync, no save).
  {
    const { doSync, calls } = makeBackgroundMock({ storedAccount: 'UCknown', syncAccount: 'unknown' });
    const { cancelled } = await resolveLikedSync({ doSync, confirm: () => false });
    check('M1 escalation: declining the unknown prompt cancels immediately',
      cancelled === true && calls.length === 1);
  }

  // Clean identified sync (stored == current): no guards, single doSync, no dialogs.
  {
    const { doSync, calls } = makeBackgroundMock({ storedAccount: 'UCme', syncAccount: 'UCme' });
    let confirmCalls = 0;
    const { cancelled, resp } = await resolveLikedSync({ doSync, confirm: () => { confirmCalls++; return true; } });
    check('M1 escalation: clean identified sync needs no confirmation',
      !cancelled && resp.success === true && calls.length === 1 && confirmCalls === 0);
  }

  // Direct account-changed (identified new account, no unknown step): confirmed once,
  // re-run carries confirmAccountChange.
  {
    const { doSync, calls } = makeBackgroundMock({ storedAccount: 'UCold', syncAccount: 'UCnew' });
    const confirmed = [];
    const { cancelled, resp } = await resolveLikedSync({ doSync, confirm: (k) => { confirmed.push(k); return true; } });
    check('M1 escalation: identified account-change confirmed on its own',
      !cancelled && resp.success === true && confirmed.join(',') === 'account-changed'
      && calls.length === 2 && calls[1].confirmAccountChange === true);
  }
}

runSyncTests().then(runLateLikedViewTests).then(runResolveTests).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
