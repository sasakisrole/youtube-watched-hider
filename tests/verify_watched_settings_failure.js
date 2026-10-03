'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=process.argv[2]||path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'popup.js'),'utf8');
const unit=source.slice(source.indexOf('function saveWatchedDisplaySetting('),source.indexOf("\nwatchedThresholdInput.addEventListener('change'"));
let passed=0;
function boot(kind) {
 const sent=[],notices=[],writes=[];let gets=0,queries=0;
 const runtime={lastError:null};
 const snapshot={dimWatched:true,hideOnHome:false,watchedThreshold:95};
 const callback=(fn,result,error)=>{runtime.lastError=error?{message:'synthetic failure'}:null;try{fn(result);}finally{runtime.lastError=null;}};
 const scope={watchedDisplayDefaults:{},popupMessage:(key,fallback)=>key,showStatus:(...x)=>notices.push(x),chrome:{runtime,
  storage:{local:{set:(data,fn)=>{writes.push(data);callback(fn,undefined,kind==='set-error');},get:(_,fn)=>{gets++;callback(fn,kind==='get-undefined'?undefined:snapshot,kind==='get-error');}}},
  tabs:{query:(_,fn)=>{queries++;callback(fn,kind==='tabs-undefined'?undefined:[{id:1},{id:2}],kind==='tabs-error');},sendMessage:(id,data)=>{sent.push({id,data});return Promise.resolve();}}}};
 const context=vm.createContext(scope);vm.runInContext(unit,context);
 return {run:()=>vm.runInContext("saveWatchedDisplaySetting('dimWatched',true)",context),sent,notices,writes,snapshot,gets:()=>gets,queries:()=>queries};
}
function check(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){process.exitCode=1;console.error('FAIL '+name+': '+e.message);}}
check('failed write sends nothing and reports save failure',()=>{const h=boot('set-error');h.run();assert.equal(h.gets(),0);assert.equal(h.sent.length,0);assert.equal(h.notices[0][0],'popupDynamicSettingsFailed');});
for(const kind of ['get-error','get-undefined'])check(kind+' never broadcasts invalid snapshot and reports saved-but-unconfirmed',()=>{const h=boot(kind);h.run();assert.equal(h.queries(),0);assert.equal(h.sent.length,0);assert.equal(h.notices[0][0],'popupDynamicSettingsApplyFailed');assert.equal(h.notices[0][1],true);});
for(const kind of ['tabs-error','tabs-undefined'])check(kind+' sends nothing, reports propagation failure and does not throw',()=>{const h=boot(kind);h.run();assert.equal(h.sent.length,0);assert.equal(h.notices[0][0],'popupDynamicSettingsApplyFailed');});
check('success sends latest complete snapshot to both tabs without replacing unrelated settings',()=>{const h=boot('success');h.run();assert.equal(h.writes.length,1);assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0])),{dimWatched:true});assert.equal(h.sent.length,2);for(const item of h.sent){assert.equal(item.data.type,'WATCHED_DISPLAY_SETTINGS_CHANGED');assert.equal(item.data.settings,h.snapshot);assert.equal(item.data.settings.hideOnHome,false);}assert.equal(h.notices.length,0);});
console.log(`${passed} cases passed; failures=${process.exitCode?'present':0}`);
