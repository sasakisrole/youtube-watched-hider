const assert = require('assert/strict');
const fs = require('fs');
const CM = require('../credit_corrections');
const CT = require('../credit_target');
const {boot} = require('./verify_credit_recheck_copy');
const background = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const block = background.slice(background.indexOf('function cleanCreditLine'), background.indexOf('async function fetchCreditsFromWatch'));
const parser = new Function('self', block + '\nreturn {extractCreditSegments,cleanCreditLine,parseCreditsFromDescription};')({CreditTarget:CT,CreditMaintenance:CM});
const analyze = (description, title) => CM.analyze(description,title,parser.extractCreditSegments,parser.cleanCreditLine,CT);
const row = (videoId,title,values) => ({videoId,title,creditsSource:'general',...values});
const proposals = (record,description) => CM.candidates(record,{ok:true,title:record.title,maintenance:analyze(description,record.title)},CT);
const theme = '作詞：喜多條 忠　作曲：吉田 拓郎　歌唱：キャンディーズ';
const altair = '「Altair and Vega」\n歌：MindaRyn　作詞：亀山陽平　作曲/編曲：土井浩平\n------☆彡\n劇場版主題歌\n'+theme;
const maison = '「YOU」\nMusic & Lyrics & Arrangement：Twinfield\n「君にふさわしい奇跡」\n作詞・作曲・編曲：くじら / 歌唱：礼衣\n「カラフルパレット」\n作詞・作曲・編曲：ふるーり / 歌唱：礼衣';
const anemona = '作詞・作曲 : 漣\nMusic ＆ Words : Sazanami (× Sanazami)';
let passed=0, failed=0;
async function check(name,fn) {try {await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}
async function uiProposals(record,description,candidate,artists={}) {
  const storage={}; const ui=boot('en','success','success','ja',true,storage);
  ui.runtime.sendMessage=function(message,callback) {
    this.mbSent.push(message);
    setImmediate(()=>callback(message.type==='lookupMbArtistReading'
      ? {success:true,artists:artists[message.name] || []} : {success:true,candidate}));
  };
  ui.setRecords([record]); await ui.review.restoreProposals();
  ui.elements.creditRecheckMb.checked=true;
  const port=ui.start([record]);
  ui.progress(port,record,{ok:true,title:record.title,maintenance:analyze(description,record.title)});
  ui.done(port);
  for(let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve));
  return storage.creditRecheckProposalsV1 || [];
}
async function main() {
  await check('REQ-1 Altair scoped composer excludes theme song',()=>{
    const r=row('6vK8A3npElM','MindaRyn「Altair and Vega」PV',{composer:'土井浩平, 吉田 拓郎 歌唱：キャンディーズ'});
    assert.equal(proposals(r,altair)[0]?.value,'土井浩平');
    assert.equal(parser.parseCreditsFromDescription(altair,r.title).composer,'土井浩平');
  });
  await check('REQ-2 YOU all three roles use only Twinfield',()=>{
    const saved='Twinfield,くじら/歌唱：礼衣,ふるーり/歌唱：礼衣';
    const r=row('V7zppYVQ3Ro','YOU / MAISONdes',{composer:saved,lyricist:saved,arranger:saved});
    const p=proposals(r,maison); assert.equal(p.length,3);
    for(const role of ['composer','lyricist','arranger']) assert.equal(p.find(p=>p.role===role)?.value,'Twinfield');
  });
  await check('REQ-3 nonsong endurance and episode clips clear consistently',()=>{
    for(const [id,title,desc] of [['lM5AmnYRSyk','排除くん耐久動画',''],['0optOGdRNRY','排除くん動画',theme],['QbfPKfEuqCY','各話動画',theme]]) {
      const p=proposals(row(id,title,{composer:'吉田 拓郎 歌唱：キャンディーズ'}),desc);
      assert.equal(p[0]?.value,'',id); assert.equal(p[0]?.source,'description-nonsong',id);
    }
  });
  await check('REQ-4 Anemona never adds the annotated romanized spelling',()=>{
    const r=row('Z6JJbLR-EkM','アネモナ / 雨ノ漣',{composer:'漣,Sazanami (× Sanazami)',lyricist:'漣'});
    const p=proposals(r,anemona);
    assert.equal(p.find(p=>p.role==='lyricist'),undefined);
    assert.equal(p.find(p=>p.role==='composer')?.value,'漣');
  });
  await check('REQ-5 crescendo and trusty snow merge proven Saito identities',async()=>{
    const artists={
      '斎藤真也':[{id:'same-saito-id',name:'斎藤真也','sort-name':'Saito, Shinya'}],
      '齊藤真也':[{id:'same-saito-id',name:'斎藤真也',matchedName:'齊藤真也','sort-name':'Saito, Shinya'}]
    };
    for(const [id,title,saved] of [['bnAz5cCwsJA','crescendo','Shinya Saito,斎藤真也'],['hKI8Gyu17wY','trusty snow','斎藤真也,齊藤真也']]) {
      const p=await uiProposals(row(id,title,{arranger:saved}),'Arranger, Composer, Lyricist: Satoshi Yaginuma\nArranger: '+saved,null,artists);
      assert.equal(p.find(p=>p.role==='arranger')?.value,'Satoshi Yaginuma, 斎藤真也',title);
    }
  });
  await check('REQ-6 instrumental and offvocal preserve lyricists',async()=>{
    for(const [id,title,saved,value] of [['-c81tBTa6yQ','絵空 (Instrumental)','sky_delta','sky_delta・藍月なくる'],['bVGj-Z4yqyI','Luminous Rage (Instrumental)','sky_delta','sky_delta・藍月なくる'],['mcjIlwdxZYU','Mizlecca (offvocal ver.)','ユリカリパブリック','Hagali・ユリカリパブリック']]) {
      const p=await uiProposals(row(id,title,{lyricist:saved}),'',{stage:'strict',mbid:'recording',mbTitle:title,lyricist:value});
      assert.equal(p.find(p=>p.role==='lyricist'),undefined,title);
    }
  });
  await check('REQ-7 double Decades DJ Okawari and Amatsu Otome keep valid proposals',()=>{
    const cases=[
      [row('boundary001','double Decades / fripSide',{arranger:'Guest'}),'Arranger, Composer, Lyricist: Satoshi Yaginuma\nArranger: Guest','Satoshi Yaginuma, Guest'],
      [row('boundary002','Brown Eyes / DJ Okawari',{composer:'DJ Okawari feat. Brittany Campbell'}),'「Brown Eyes」\nComposer: DJ Okawari','DJ Okawari'],
      [row('boundary003','天女神樂「アマツオトメ」',{composer:'Old'}),'「アマツオトメ」\n作曲：Paja☆Maa','Paja☆Maa'],
      [row('boundary004','LEVEL NINE',{composer:'Guest'}),'Composer: Guest\nComposer: はがね','Guest, はがね']
    ];
    for(const [r,desc,value] of cases) assert.equal(proposals(r,desc)[0]?.value,value,r.title);
  });
  await check('unknown multisong section is held rather than cleaned into other names',()=>{
    const r=row('unknown0001','Unidentified Song',{composer:'Twinfield,くじら/歌唱：礼衣,ふるーり/歌唱：礼衣'});
    assert.equal(proposals(r,maison).length,0);
  });
  await check('matching meteor insert song keeps both composers',()=>{
    const title='ときめき★メテオストライク';
    const desc='「'+title+'」\n作曲/編曲：石黒峻平/土井浩平\n------☆彡\n'+theme;
    assert.equal(proposals(row('dk_Lw8seK2E',title,{composer:'石黒峻平/土井浩平, 吉田 拓郎 歌唱：キャンディーズ'}),desc)[0]?.value,'石黒峻平/土井浩平');
  });
  await check('unknown multisong section with only annotated saved names stays held',()=>{
    assert.deepEqual(proposals(row('unknown0002','Unidentified Song',{composer:'なとり/歌唱：asmi'}),maison),[]);
  });
  await check('a typo annotation does not remove other contributors on its line',()=>{
    assert.deepEqual(proposals(row('typonote001','Song',{composer:'Alice, Bob'}),'Composer: Alice, Sazanami (× Sanazami)\nComposer: Bob'),[]);
  });
  await check('Japanese homonyms with different or ambiguous identities stay separate',async()=>{
    for(const artists of [
      {'斎藤真也':[{id:'one',name:'斎藤真也','sort-name':'Saito, Shinya'}],'齊藤真也':[{id:'two',name:'齊藤真也','sort-name':'Saito, Shinya'}]},
      {'斎藤真也':[{id:'one',name:'斎藤真也','sort-name':'Saito, Shinya'}],'齊藤真也':[{id:'one',name:'斎藤真也',matchedName:'齊藤真也'},{id:'two',name:'齊藤真也'}]}
    ]) {
      const saved='斎藤真也,齊藤真也';
      const p=await uiProposals(row('identity001','Song',{arranger:saved}),'Arranger: Satoshi Yaginuma\nArranger: '+saved,null,artists);
      assert.equal(p.find(p=>p.role==='arranger')?.value,'Satoshi Yaginuma, 斎藤真也, 齊藤真也');
    }
  });
  await check('artist backend retains exact alias identity without exposing aliases as readings',async()=>{
    const start=background.indexOf('async function lookupMbArtistReading');
    const lookup=new Function('mbGet',background.slice(start,background.indexOf('function collectMbRole',start))+';return lookupMbArtistReading;')(
      async()=>({count:1,artists:[{id:'one',name:'斎藤真也','sort-name':'Saito, Shinya',aliases:[{name:'齊藤真也'}]}]}));
    const response=await lookup('齊藤真也');
    assert.equal(response.artists[0]?.matchedName,'齊藤真也');
    assert.equal(response.artists[0]?.name,'斎藤真也');
    const resolve=CM.createArtistReadingLookup(async name=>lookup(name));
    assert.equal((await resolve('Satoshi Yaginuma, 斎藤真也, 齊藤真也',true,true)).value,'Satoshi Yaginuma, 斎藤真也');
  });
  await check('instrumental reading lookup neither removes nor renames a lyricist',async()=>{
    const p=await uiProposals(row('offvocal001','Song (off-vocal)',{lyricist:'Shinya Saito,斎藤真也'}),'',null,
      {'斎藤真也':[{id:'saito',name:'斎藤真也','sort-name':'Saito, Shinya'}]});
    assert.equal(p.find(p=>p.role==='lyricist'),undefined);
  });
  await check('vocal editions still add lyricists and instrumental composers can change',async()=>{
    for(const [title,role] of [['Song','lyricist'],['Song (Instrumental)','composer']]) {
      const p=await uiProposals(row('positive001',title,{[role]:'Alice'}),'',{stage:'strict',mbid:'recording',mbTitle:title,[role]:'Alice・Bob'});
      assert.equal(p.find(p=>p.role===role)?.value,'Alice, Bob');
    }
  });
  await check('the supplied unheaded Altair credits stop at the decorated divider',()=>{
    const r=row('6vK8A3npElM','MindaRyn「Altair and Vega」PV',{composer:'土井浩平, 吉田 拓郎 歌唱：キャンディーズ'});
    assert.equal(proposals(r,altair.split('\n').slice(1).join('\n'))[0]?.value,'土井浩平');
  });
  await check('one foreign song and a divider cannot justify clearing an unknown target',()=>{
    assert.deepEqual(proposals(row('unknown0003','Unidentified Song',{composer:'吉田 健男 歌唱：キャンディーズ'}),altair),[]);
  });
  await check('an annotated slash list is held without removing its unannotated coauthor',()=>{
    const desc='Composer: Alice / Sazanami (× Sanazami)\nComposer: Bob';
    assert.deepEqual(proposals(row('typonote002','Song',{composer:'Alice, Bob'}),desc),[]);
    assert.equal(analyze(desc,'Song').credits.composer,'');
  });
  await check('REQ-8 a restored proposal is rechecked when its video is due',async()=>{
    const r=row('lM5AmnYRSyk','排除くん耐久動画',{composer:'吉田 拓郎 歌唱：キャンディーズ',creditsSource:'enrich:same-song'});
    r.creditsRecheck=CM.recheckStamp(r,true,true,true,true);
    const storage={creditRecheckProposalsV1:[{videoId:r.videoId,role:'composer',value:'吉田 拓郎',source:'description-cleanup',selected:false,
      rev:CM.PROPOSAL_REVISION,savedValue:r.composer,savedSource:'enrich:same-song'}]};
    const ui=boot('en','success','success','ja',true,storage);
    ui.setRecords([r]); await ui.review.restoreProposals();
    const before=ui.ports.length;
    ui.start([r]);
    assert.equal(ui.ports.length,before+1,'the restored video must be fetched again');
  });
  console.log(`RESULT: ${passed} passed / ${failed} failed`); process.exitCode=failed?1:0;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
