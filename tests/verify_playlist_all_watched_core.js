const { assert, boot, initial, row, continuation } = require('./playlist_all_watched_harness');
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }
const { scope: s } = boot();
const seen = { aaaaaaaaaaa: true, bbbbbbbbbbb: true };
test('REQ-1 all watched hides; one unwatched stays', () => {
  const entries = [row('aaaaaaaaaaa'), row('bbbbbbbbbbb')].map(x => x.playlistVideoRenderer);
  assert.equal(s.evaluatePlaylistAllWatched('PLtest', entries, seen).allWatched, true);
  assert.equal(s.evaluatePlaylistAllWatched('PLtest', entries, { aaaaaaaaaaa: true, bbbbbbbbbbb: false }).allWatched, false);
});
test('REQ-1 deleted and private excluded; zero playable stays', () => {
  const entries = [row('aaaaaaaaaaa'), row('deleted', false), row('private', false)].map(x => x.playlistVideoRenderer);
  assert.equal(s.evaluatePlaylistAllWatched('PLtest', entries, seen).allWatched, true);
  assert.equal(s.evaluatePlaylistAllWatched('PLtest', entries.slice(1), {}).allWatched, false);
  assert.equal(s.evaluatePlaylistAllWatched('PLtest', [], {}).allWatched, false);
});
test('REQ-1 over limit RD WL LL never judged', () => {
  for (const id of ['RDabc', 'WL', 'LL', '', 'bad/id']) assert.equal(s.playlistAllWatchedEligible(id), false);
  for (const id of ['RDabc', 'WL', 'LL']) assert.equal(s.evaluatePlaylistAllWatched(id, [row('aaaaaaaaaaa').playlistVideoRenderer], seen).allWatched, false);
  assert.equal(s.evaluatePlaylistAllWatched('PLtest', Array(301).fill(row('aaaaaaaaaaa').playlistVideoRenderer), seen).allWatched, false);
});
test('REQ-2 count change and seven days refetch; fresh cache reused', () => {
  const entry = { videoCount: 2, checkedAt: 1000, allWatched: true, unwatchedCount: 0 };
  assert.equal(s.playlistAllWatchedCacheFresh(entry, 2, 1001), true);
  assert.equal(s.playlistAllWatchedCacheFresh(entry, 3, 1001), false);
  assert.equal(s.playlistAllWatchedCacheFresh(entry, 2, 1000 + 7 * 86400000), false);
  assert.equal(s.playlistAllWatchedCacheFresh(entry, null, 1001), false);
  assert.equal(s.playlistAllWatchedCacheFresh(entry, 2, 999), false);
});
test('REQ-4 strict scoped parsing rejects unknown playability and unrelated shelves', () => {
  const payload = initial([row('aaaaaaaaaaa'), row('deleted', false), continuation('next')]);
  payload.recommendations = { items: [row('bbbbbbbbbbb')] };
  const parsed = s.parsePlaylistAllWatchedPage(payload, false);
  assert.equal(parsed.entries.length, 2); assert.equal(parsed.continuation, 'next');
  for (const bad of [{}, { error: {} }, initial([{ playlistVideoRenderer: { videoId: 'aaaaaaaaaaa' } }]), initial([{ unknownRenderer: {} }])]) {
    assert.throws(() => s.parsePlaylistAllWatchedPage(bad, false));
  }
  assert.throws(() => s.evaluatePlaylistAllWatched('PLtest', [row('aaaaaaaaaaa').playlistVideoRenderer], {}));
});
console.log(`${passed} passed, 0 failed`);
