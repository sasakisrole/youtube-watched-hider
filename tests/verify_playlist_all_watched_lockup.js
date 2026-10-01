const { assert, read, boot, initial, row, continuation } = require('./playlist_all_watched_harness');
const lockup = (id, type = 'LOCKUP_CONTENT_TYPE_VIDEO') => ({ lockupViewModel: { contentId: id, contentType: type } });
const section = items => ({ itemSectionRenderer: { contents: items } });
const page = (items, sections) => ({ contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
  content: { sectionListRenderer: { contents: sections || [section(items)] } }
} }] } } });
(async () => {
  for (const listId of ['PLsaved', 'LRrecap']) for (const all of [true, false]) {
    const h = boot();
    h.scope.fetchPlaylistAllWatchedPage = async () => page([lockup('aaaaaaaaaaa'), lockup('bbbbbbbbbbb')]);
    h.scope.DBClient.checkMultiple = async ids => {
      assert.deepEqual(Array.from(ids), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
      return { aaaaaaaaaaa: true, bbbbbbbbbbb: all };
    };
    h.run(read('content.js').match(/  function applyPlaylistCardDisplay\([^]*?\n  }/)[0]);
    const card = { isConnected: true, dataset: {}, style: { display: '' }, querySelectorAll(selector) {
      return selector.startsWith('a[') ? [{ href: 'https://www.youtube.com/playlist?list=' + listId }] : [{ textContent: '2 videos' }];
    } };
    h.scope.applyPlaylistCardDisplay(card);
    h.observed[0].cb([{ target: card, isIntersecting: true }]);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(h.writes.length, 1, 'lockup initial page must be judged');
    assert.equal(Object.values(h.stored)[0].allWatched, all);
    assert.equal(card.style.display, all ? 'none' : '');
  }
  const a = lockup('aaaaaaaaaaa');
  const bad = [
    page([a, lockup('bbbbbbbbbbb', 'LOCKUP_CONTENT_TYPE_PLAYLIST')]),
    page([a, { unknownRenderer: {} }]), page([a, null]),
    page([a, lockup('bad')]), page([a, { lockupViewModel: { contentId: 'bbbbbbbbbbb' } }]),
    page([], [section([a]), section([a])]),
    page([], [section([a]), { unknownRenderer: {} }]),
    page([a, continuation('next')]),
    page([a, row('bbbbbbbbbbb')]),
    page([{ ...a, unknownRenderer: {} }]),
  ];
  const outerContinuation = page([a]);
  outerContinuation.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.continuations = [{}];
  bad.push(outerContinuation);
  const mixed = page([a]); mixed.contents.legacy = initial([row('bbbbbbbbbbb')]).contents; bad.push(mixed);
  const tabs = page([a]); tabs.contents.twoColumnBrowseResultsRenderer.tabs.push(tabs.contents.twoColumnBrowseResultsRenderer.tabs[0]); bad.push(tabs);
  for (const data of bad) {
    const h = boot(); let requests = 0;
    h.scope.fetchPlaylistAllWatchedPage = async () => { requests++; return data; };
    const result = await h.scope.checkPlaylistAllWatched({ listId: 'PLbad', videoCount: 2 }, 0);
    assert.equal(result?.unsupported, true, 'ambiguous, unknown or continuing lockup page unsupported');
    assert.equal(result.allWatched, false); assert.equal(requests, 1);
    assert.equal(h.calls.filter(x => x[0] === 'db').length, 0);
    assert.equal(h.run('playlistAllWatchedFailures'), 0);
  }
  console.log('PASS REQ-7 PL/LR lockup display and conservative layout rejection');
})().catch(e => { console.error(e); process.exitCode = 1; });
