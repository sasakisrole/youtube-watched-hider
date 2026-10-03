const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const offscreen = fs.readFileSync(path.join(root, 'offscreen.js'), 'utf8');
function part(start, end) {
  const a=background.indexOf(start), b=background.indexOf(end,a);
  assert.ok(a>=0&&b>a,start); return background.slice(a,b);
}
function boot() {
  let listener, contexts=false, creation, created=0, calls=0;
  let outcome={schemaVersion:2,watchedVideos:[{videoId:'synthetic001'}],likedVideos:[]};
  const state={
    WatchedDB:{exportAll:async options=>{calls++; assert.equal(options.appVersion,'1.58.0');
      if(outcome instanceof Error) throw outcome; return structuredClone(outcome);}},
    chrome:{runtime:{getURL:file=>'chrome-extension://synthetic/'+file,
      getContexts:async filter=>{assert.deepEqual(Array.from(filter.contextTypes),['OFFSCREEN_DOCUMENT']);return contexts?[{}]:[];},
      onMessage:{addListener:fn=>listener=fn},
      sendMessage:message=>new Promise(resolve=>{
        assert.equal(listener(structuredClone(message),{},response=>resolve(structuredClone(response))),true);
      })},offscreen:{createDocument:options=>{
      created++;assert.equal(options.url,'offscreen.html');
      return new Promise((resolve,reject)=>{creation={resolve:()=>{contexts=true;resolve();},reject};});
    }}},console,setTimeout,clearTimeout,
  };
  vm.runInNewContext(offscreen,state);
  vm.runInNewContext(part('const OFFSCREEN_DOCUMENT_PATH', 'function storageLocalGet(')+'\nglobalThis.bridge=sendToOffscreenDb;',state);
  return {state,listener:()=>listener,created:()=>created,calls:()=>calls,
    present:()=>contexts=true,outcome:value=>outcome=value,creation:()=>creation,
    export:()=>state.bridge('EXPORT_DATA',{appVersion:'1.58.0'})};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let passed=0,failed=0;
async function test(name,body){try{await body();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.message);}}
(async()=>{
 await test('20 concurrent exports create one offscreen owner and clone responses',async()=>{
  const c=boot(), pending=Array.from({length:20},()=>c.export());await tick();
  assert.equal(c.created(),1); c.creation().resolve(); const result=await Promise.all(pending);
  assert.equal(c.calls(),20);assert.notEqual(result[0],result[1]);
  result[0].watchedVideos[0].videoId='changed';assert.equal(result[1].watchedVideos[0].videoId,'synthetic001');
 });
 await test('failed owner creation rejects every waiter and permits later retry',async()=>{
  const c=boot(), pending=Array.from({length:3},()=>c.export());
  const observed=Promise.allSettled(pending);await tick();c.creation().reject(new Error('synthetic create failure'));
  const results=await observed;assert.ok(results.every(r=>r.status==='rejected'));assert.equal(c.calls(),0);
  const retry=c.export();await tick();assert.equal(c.created(),2);c.creation().resolve();assert.equal((await retry).schemaVersion,2);
 });
 await test('existing owner skips creation',async()=>{const c=boot();c.present();await c.export();assert.equal(c.created(),0);});
 await test('DB rejection crosses the real offscreen response boundary',async()=>{
  const c=boot();c.present();c.outcome(new Error('synthetic DB failure'));
  await assert.rejects(c.export(),/synthetic DB failure/);
 });
 await test('missing or failed RPC response stays a failure',async()=>{
  for(const response of [undefined,null,{success:false,error:'synthetic response failure'}]){
    const c=boot();c.present();c.state.chrome.runtime.sendMessage=async()=>response;
    await assert.rejects(c.export(),/Offscreen DB did not respond|synthetic response failure/);
  }
 });
 await test('unrelated messages do not touch the synthetic DB',async()=>{
  const c=boot();assert.equal(c.listener()({target:'content'}, {},()=>assert.fail('response')),false);assert.equal(c.calls(),0);
 });
 console.log(JSON.stringify({passed,failed,scope:'real background owner/RPC functions and full offscreen listener; mocked DB, no browser or actual IndexedDB'}));
 process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
