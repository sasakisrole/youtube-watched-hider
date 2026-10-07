const assert = require('assert/strict');
const fs = require('fs');
const CM = require('../credit_corrections.js');
const CT = require('../credit_target.js');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const block = source.slice(source.indexOf('function cleanCreditLine'), source.indexOf('async function fetchCreditsFromWatch'));
const parser = new Function('self', block + '\nreturn {extractCreditSegments,cleanCreditLine,parseCreditsFromDescription};')({CreditTarget: CT, CreditMaintenance: CM});
const title = 'Example (Guest Remix)';
const analyze = (description, target = title) => CM.analyze(description, target, parser.extractCreditSegments, parser.cleanCreditLine, CT);
let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
function both(description, expected, target = title) {
  const result = analyze(description, target);
  assert.deepEqual(result.credits, expected, 'recheck');
  assert.deepEqual(parser.parseCreditsFromDescription(description, target), {...expected, creditsRaw: ''}, 'enrichment');
  return result;
}
const all = {composer: 'Alice', lyricist: 'Alice', arranger: 'Alice'};
const description = 'Composer, Arranger, Associated Performer, Vocal, Producer, Lyricist: Alice\nProducer, Arranger: Bob\nRe- Mixer: Guest';
check('all known roles survive unknown role lists', () => {
  assert.deepEqual(new Set(parser.extractCreditSegments(description.split('\n')[0])[0].roles), new Set(Object.keys(all)));
  both(description.split('\n')[0], all);
});
check('co-contributors survive across role list lines', () => {
  const result = both(description, {...all, arranger: 'Alice, Bob'});
  assert.deepEqual(result.held, []);
  assert(result.evidence.arranger.includes('Producer, Arranger: Bob'));
  assert(result.evidence.arranger.includes('Lyricist: Alice'));
});
check('role ordering and unknown role positions do not change assignments', () => {
  for (const label of ['Lyricist, Producer, Arranger, Composer', 'Associated Performer, Composer, Vocal, Lyricist, Arranger', 'Composer, Lyricist, Arranger, Engineer', 'Arranger，Lyricist，Composer']) {
    both(label + ': Alice', all);
  }
});
check('composer writer list retains the explicit compound meaning', () => {
  both('Composer, Writer: Alice', {composer: 'Alice', lyricist: 'Alice', arranger: ''});
});
check('multiple people and repeated people are deduplicated in first-seen order', () => {
  both('Composer, Arranger: Alice, Bob\nArranger: Bob\nComposer: Carol\nArranger: Alice、Carol', {composer: 'Alice, Bob, Carol', lyricist: '', arranger: 'Alice, Bob, Carol'});
});
check('Japanese role lists and wrappers retain every role', () => {
  for (const label of ['作曲、編曲', '作曲，編曲', '【作曲、編曲】', '[作曲、編曲]']) {
    both(label + ': Alice\n編曲: Bob', {composer: 'Alice', lyricist: '', arranger: 'Alice, Bob'});
  }
});
check('remix-only and producer-only labels never create musical roles', () => {
  for (const label of ['Re- Mixer', 'Remix', 'Remixer', 'Producer', 'Producer, Vocal', 'Associated Performer, Re- Mixer']) {
    both(label + ': Guest', {composer: '', lyricist: '', arranger: ''});
  }
  both('Arranger: Alice / Re- Mixer: Guest', {composer: '', lyricist: '', arranger: 'Alice'});
  both('Composer, Remixer: Alice', {composer: 'Alice', lyricist: '', arranger: ''});
});
check('original remix and foreign song sections remain isolated', () => {
  const desc = '[Original]\nComposer, Arranger: Original\n[Remix]\n' + description + '\nSong: Different\nComposer, Arranger: Other';
  both(desc, {...all, arranger: 'Alice, Bob'});
  both(desc, {composer: '', lyricist: '', arranger: ''}, 'Example');
});
check('unscoped credits before named or version sections remain held', () => {
  for (const heading of ['Song: Different', '[Original]']) {
    const result = both('Composer, Arranger: Alice\n' + heading + '\nComposer, Arranger: Bob', {composer: '', lyricist: '', arranger: ''});
    assert(result.held.includes('composer'));
    assert(result.held.includes('arranger'));
  }
});
check('foreign inline headings cannot donate compound roles', () => {
  both('Song: Different / Composer, Arranger: Alice', {composer: '', lyricist: '', arranger: ''});
  both('Song: ' + title + ' / Composer, Arranger: Alice', {composer: 'Alice', lyricist: '', arranger: 'Alice'});
});
check('prose inside unknown wrappers never becomes a role list', () => {
  for (const line of ['[See Composer, Arranger: Alice]', '【Notes [Composer, Arranger]: Alice】', '[Composer Notes, Arranger]: Alice', '【See Composer, Arranger】: Alice']) {
    both(line, {composer: '', lyricist: '', arranger: ''});
  }
});
check('identical saved co-contributors produce zero candidates', () => {
  const maintenance = both(description, {...all, arranger: 'Alice, Bob'});
  const record = {videoId: 'example0001', title, ...maintenance.credits, creditsSource: 'general'};
  assert.deepEqual(CM.candidates(record, {ok: true, title, maintenance}, CT), []);
  const proposals = CM.candidates({...record, arranger: 'Old'}, {ok: true, title, maintenance}, CT);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].value, 'Alice, Bob');
});
check('plain prose containing role lists is ignored', () => {
  both('Notes about Composer, Arranger: Alice', {composer: '', lyricist: '', arranger: ''});
});
check('commas inside band annotations are preserved', () => {
  both('Composer, Arranger: Alice (Band, Unit), Bob\nArranger: Bob', {composer: 'Alice (Band,Unit),Bob', lyricist: '', arranger: 'Alice (Band,Unit), Bob'});
});
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
