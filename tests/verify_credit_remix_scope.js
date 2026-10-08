const assert = require('assert/strict');
const fs = require('fs');
const CM = require('../credit_corrections.js');
const CT = require('../credit_target.js');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const block = source.slice(source.indexOf('function cleanCreditLine'), source.indexOf('async function fetchCreditsFromWatch'));
const parser = new Function('self', block + '\nreturn {extractCreditSegments,cleanCreditLine,parseCreditsFromDescription};')({CreditTarget: CT, CreditMaintenance: CM});
const analyze = (description, title = 'Paper Moon (Guest Remix)') => CM.analyze(description, title, parser.extractCreditSegments, parser.cleanCreditLine, CT);
let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS ' + name); }

check('REQ-1 original composition and lyrics fallback, never arrangement', () => {
  for (const heading of ['【Original】', '[Original]']) {
    const result = analyze(heading + '\n作詞・作曲：Creator One\n編曲：Creator One、Creator Two\n【Remix】\nGuest');
    assert.deepEqual(result.credits, {composer: 'Creator One', lyricist: 'Creator One', arranger: ''});
    assert.equal(result.reasons.arranger, 'scope-mismatch');
    assert(result.evidence.composer.includes(heading));
  }
});
check('REQ-1 current role wins independently over original roles', () => {
  const result = analyze('[Original]\nComposer: First\nLyricist: Writer One\nArranger: First\n[Remix]\nComposer: Second\nArranger: Guest');
  assert.deepEqual(result.credits, {composer: 'Second', lyricist: 'Writer One', arranger: 'Guest'});
});
check('REQ-1 conflicting original sections remain held', () => {
  const result = analyze('[Original]\nComposer: First\n[Original]\nComposer: Second');
  assert.equal(result.credits.composer, '');
  assert.equal(result.reasons.composer, 'conflict');
});
check('REQ-1 non-remix cannot inherit original composition', () => {
  assert.equal(analyze('[Original]\nComposer: First', 'Paper Moon').credits.composer, '');
});
check('REQ-2 nested unofficial notice is not another song', () => {
  assert.deepEqual(analyze('[[[[THIS REMIX IS UNOFFICIAL]]]]\noriginal https://example.com\n作詞：Writer One\n作曲編曲：Creator One').credits,
    {composer: 'Creator One', lyricist: 'Writer One', arranger: ''});
});
check('REQ-2 notice alone preserves current credits', () => {
  for (const notice of ['[[[[THIS REMIX IS UNOFFICIAL]]]]', '[THIS REMIX IS UNOFFICIAL]']) {
    assert.equal(analyze(notice + '\nComposer: Creator One').credits.composer, 'Creator One');
  }
});
check('REQ-2 ordinary foreign headings still exclude credits', () => {
  for (const heading of ['[Other Song]', '【Other Song】', '「Other Song」', 'Song: Other Song', '2. Other Song']) {
    assert.equal(analyze(heading + '\nComposer: Other').credits.composer, '', heading);
  }
});
check('REQ-3 exact decorated title candidates', () => {
  for (const title of ['Paper Moon Guest Remix / Singer【Anniversary】', 'Paper Moon Guest Remix - Artist', 'Paper Moon Guest Remix #tag', 'Group 「Paper Moon Guest Remix」 Official Visualiser', 'Lyric Video -「Paper Moon Guest Remix」 | Studio']) {
    assert.equal(analyze('曲名：Paper Moon Guest Remix\nComposer: Creator One', title).credits.composer, 'Creator One', title);
  }
});
check('REQ-3 matching never uses substrings or drops remix identity', () => {
  assert.equal(analyze('Song: RAIN Guest Remix\nComposer: Other', 'BRAIN Guest Remix / Singer').credits.composer, '');
  assert.equal(analyze('Song: Paper Moon\nArranger: Other', 'Paper Moon Guest Remix / Singer').credits.arranger, '');
});
check('REQ-4 concatenated musical and visual roles', () => {
  assert.deepEqual(analyze('曲名：Paper Moon Guest Remix\n作詞作曲絵動画：Creator One https://example.com', 'Paper Moon Guest Remix / Singer【Anniversary】').credits,
    {composer: 'Creator One', lyricist: 'Creator One', arranger: ''});
  assert.equal(analyze('作曲解説：Other').credits.composer, '');
});
check('REQ-5 decorated music words list', () => {
  for (const line of ['music,words：Creator One', '▶︎music,words：Creator One', 'Words, Music: Creator One']) {
    assert.deepEqual(analyze(line).credits, {composer: 'Creator One', lyricist: 'Creator One', arranger: ''}, line);
  }
});
check('REQ-5 promotional and lyric headings without credits do not hold role lists', () => {
  const result = analyze('■配信(Subscribe/Download)\nhttps://example.com\n▶︎music,words：Creator One\n▶︎niconico→\n「A Different Caption」\n【歌詞】\nSome fictional lyrics');
  assert.deepEqual(result.credits, {composer: 'Creator One', lyricist: 'Creator One', arranger: ''});
});
check('REQ-5 publisher and naked music do not imply composer', () => {
  for (const line of ['Music Publisher: Other', 'Music  Publisher: Other', 'Music: Other', 'Music, Producer: Other', 'Music Video: Other']) {
    assert.equal(analyze(line).credits.composer, '', line);
  }
});
check('REQ-6 Topic album hashtag does not scope out explicit composer', () => {
  const desc = 'Provided to YouTube by Sample Distribution\n\nPaper Moon (Guest Remix) · Artist One · Guest\n\n#From_The_Paper_Garden\n\n℗ 2014 Sample Records\n\nReleased on: 2014-01-02\n\nProducer: Creator One\nComposer: Creator One\n\nAuto-generated by YouTube.';
  assert.equal(analyze(desc).credits.composer, 'Creator One');
  assert.equal(parser.parseCreditsFromDescription(desc, 'Paper Moon (Guest Remix)').composer, 'Creator One');
});
console.log(`${passed} passed, 0 failed, 0 skipped`);
