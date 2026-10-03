'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=process.argv[2]||path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'popup.js'),'utf8');
const unwrap=source.slice(source.indexOf('function unwrapWatchedRecords('),source.indexOf('// Format date'));
const unit=source.slice(source.indexOf('function deleteHistoryVideo('),source.indexOf('// Watched display settings'));
const maintenance=source.slice(source.indexOf("clearWatchedBtn.addEventListener('click'"),source.indexOf('// Sync: Import & Merge from file'));
let passed=0;
class Element {
 constructor(){this.children=[];this.dataset={};this.style={};}
 appendChild(e){if(e.fragment)this.children.push(...e.children);else this.children.push(e);return e;}
 set textContent(v){this.text=String(v);this.children=[];} get textContent(){return (this.text||'')+this.children.map(x=>x.textContent).join(' ');}
 addEventListener(){}
}
function boot(){
 const callbacks=[],notices=[],list=new Element(),runtime={lastError:null},statusEl={textContent:''};
 const context=vm.createContext({historyList:list,historySearch:{value:''},allHistoryData:[{videoId:'stale',title:'old',watchedAt:0}],filteredHistoryData:[],historyRenderedCount:0,lastHistoryDateGroup:'',historyLoadFailed:false,historyLoadGeneration:0,HISTORY_PAGE_SIZE:50,statusEl,
  document:{createElement:()=>new Element(),createDocumentFragment:()=>Object.assign(new Element(),{fragment:true})},chrome:{runtime:Object.assign(runtime,{sendMessage:(_,cb)=>callbacks.push(cb)})},
  popupMessage:key=>key,showStatus:(...v)=>{notices.push(v);statusEl.textContent=v[0];},formatDateGroup:()=> 'day',formatTime:()=> '00:00'});
 for(const name of ['clearWatchedBtn','clearLikedBtn','clearAllBtn'])context[name]={disabled:false,addEventListener:(_,fn)=>{context[name].clickHandler=fn;}};
 context.confirm=()=>true;context.loadStats=()=>{};context.settingsPanel={style:{}};context.settingsBtn={setAttribute(){}};
 vm.runInContext(unwrap+unit+maintenance,context);const run=s=>vm.runInContext(s,context);run('renderHistory()');
 function respond(data,error=false,index=0){runtime.lastError=error?{message:'synthetic error'}:null;try{callbacks.splice(index,1)[0](data);}finally{runtime.lastError=null;}}
 return {context,list,notices,run,respond};
}
function check(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){process.exitCode=1;console.error('FAIL '+name+': '+e.message);}}
function failed(h){assert.equal(h.list.children.length,1);assert.equal(h.list.children[0].textContent,'popupDynamicHistoryLoadFailed');assert.equal(h.run('allHistoryData.length'),0);assert.equal(h.run('historyRenderedCount'),0);assert.equal(h.run('lastHistoryDateGroup'),'');assert.equal(h.notices.at(-1)[0],'popupDynamicHistoryLoadFailed');}
for(const kind of ['runtime','missing','malformed','database'])check(kind+' failure clears stale rows and shows retry instead of no-history',()=>{const h=boot();h.run('loadHistory()');h.respond(kind==='runtime'?[]:kind==='missing'?undefined:kind==='malformed'?{invalid:true}:{__error:true,message:'synthetic database error'},kind==='runtime');failed(h);});
check('synchronous request failure reports retry and clears stale history',()=>{const h=boot();h.context.chrome.runtime.sendMessage=()=>{throw Error('synthetic transport error');};assert.doesNotThrow(()=>h.run('loadHistory()'));failed(h);});
check('search after failure retains load-failure guidance',()=>{const h=boot();h.run('loadHistory()');h.respond(undefined);h.run('renderHistory("new query")');failed(h);});
check('retry success restores data and normal empty response is truly empty',()=>{const h=boot();h.run('loadHistory()');h.respond(undefined);h.run('loadHistory()');h.respond([{videoId:'fresh',title:'fresh',watchedAt:1}]);assert.equal(h.run('historyLoadFailed'),false);assert.equal(h.run('allHistoryData[0].videoId'),'fresh');assert(!h.list.textContent.includes('popupDynamicHistoryLoadFailed'));assert.equal(h.context.statusEl.textContent,'');h.run('loadHistory()');h.respond([]);assert.equal(h.list.children[0].textContent,'popupDynamicNoHistory');});
check('supported export wrappers remain valid and newest-first',()=>{for(const data of [{schemaVersion:2,watchedVideos:[{videoId:'a',watchedAt:1},{videoId:'b',watchedAt:2}]},{records:[{videoId:'a',watchedAt:1},{videoId:'b',watchedAt:2}]}]){const h=boot();h.run('loadHistory()');h.respond(data);assert.equal(h.run('allHistoryData[0].videoId'),'b');assert.equal(h.notices.length,0);}});
check('older successful response cannot overwrite the latest request',()=>{const h=boot();h.run('loadHistory();loadHistory()');h.respond([{videoId:'new',watchedAt:2}],false,1);h.respond([{videoId:'old',watchedAt:1}]);assert.equal(h.run('allHistoryData[0].videoId'),'new');});
check('older failed response cannot erase a newer successful load',()=>{const h=boot();h.run('loadHistory();loadHistory()');h.respond([{videoId:'new',watchedAt:2}],false,1);h.respond(undefined,true);assert.equal(h.run('allHistoryData[0].videoId'),'new');assert.equal(h.run('historyLoadFailed'),false);assert.equal(h.notices.length,0);});
check('recovery preserves a status message belonging to another operation',()=>{const h=boot();h.run('loadHistory()');h.respond(undefined);h.context.statusEl.textContent='other operation status';h.run('loadHistory()');h.respond([]);assert.equal(h.context.statusEl.textContent,'other operation status');});
for(const button of ['clearWatchedBtn','clearAllBtn']) {
 check(button+' successful mock clear resets load-failure state',()=>{const h=boot();h.run('loadHistory()');h.respond(undefined);h.context.historyLoadFailed=true;h.run(button+'.clickHandler()');h.respond({success:true,backup:{reason:'no_data'}});assert.equal(h.run('historyLoadFailed'),false);assert.equal(h.list.children[0].textContent,'popupDynamicNoHistory');});
 check(button+' rejected mock clear preserves load-failure state',()=>{const h=boot();h.run('loadHistory()');h.respond(undefined);h.context.historyLoadFailed=true;h.run(button+'.clickHandler()');h.respond({success:false,reason:'backup_failed'});assert.equal(h.run('historyLoadFailed'),true);assert.equal(h.list.children[0].textContent,'popupDynamicHistoryLoadFailed');});
 check(button+' successful mock clear invalidates a pre-clear pending read',()=>{const h=boot();h.run('loadHistory();'+button+'.clickHandler()');h.respond({success:true,backup:{reason:'no_data'}},false,1);h.respond([{videoId:'old',watchedAt:1}]);assert.equal(h.run('allHistoryData.length'),0);assert.equal(h.list.children[0].textContent,'popupDynamicNoHistory');});
}
console.log(`${passed} cases passed; failures=${process.exitCode?'present':0}`);
