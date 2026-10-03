'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=process.argv[2]||path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'popup.js'),'utf8');
const unit=source.slice(source.indexOf('function deleteHistoryVideo('),source.indexOf('// Load and show history'));
let passed=0;
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.style={};this.listeners={};this.parent=null;this.dataset={};}
 querySelectorAll(selector){assert(['.history-item','.history-date-header'].includes(selector));return this.children.filter(x=>x.className===selector.slice(1));}
 get previousElementSibling(){if(!this.parent)return null;return this.parent.children[this.parent.children.indexOf(this)-1]||null;}
 get nextElementSibling(){if(!this.parent)return null;return this.parent.children[this.parent.children.indexOf(this)+1]||null;}
 appendChild(child){if(child.tag==='fragment'){for(const c of [...child.children])this.appendChild(c);return child;}child.parent=this;this.children.push(child);return child;}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}}
 set textContent(value){this.text=String(value);this.children=[];}
 get textContent(){return this.text||'';}
 addEventListener(type,fn){this.listeners[type]=fn;}
}
function boot(){
 const list=new Element('div'),callbacks=[],timers=[];
 const records=Array.from({length:101},(_,i)=>({videoId:'v'+i,title:(i%2?'odd':'even')+' '+i,watchedAt:0}));
 const context=vm.createContext({allHistoryData:records,filteredHistoryData:[],historyRenderedCount:0,lastHistoryDateGroup:'',HISTORY_PAGE_SIZE:50,
  historyList:list,chrome:{runtime:{sendMessage:(msg,cb)=>callbacks.push({msg,cb})}},setTimeout:fn=>timers.push(fn),loadStats:()=>{},
  formatDateGroup:()=> 'one-day',formatTime:()=> '00:00',popupMessage:(_,fallback)=>fallback,
  document:{createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment')}});
 vm.runInContext(unit,context);
 const run=code=>vm.runInContext(code,context);
 const ids=()=>list.children.filter(x=>x.className==='history-item').map(x=>new URL(x.children[0].href).searchParams.get('v'));
 const row=id=>list.children.find(x=>x.className==='history-item'&&x.children[0].href.endsWith('='+id));
 function request(id){const r=row(id);assert(r,'rendered row missing '+id);r.children[1].listeners.click({stopPropagation(){}});}
 function finishTimers(){while(timers.length)timers.shift()();}
 function flush(success=true,index=0,withTimers=true){callbacks.splice(index,1)[0].cb({success});if(withTimers)finishTimers();}
 return {run,ids,row,request,flush,finishTimers,callbacks,context};
}
function check(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){process.exitCode=1;console.error('FAIL '+name+': '+e.message);}}
const sequence=(from,to)=>Array.from({length:to-from},(_,i)=>'v'+(from+i));
check('first batch deletion retains every remaining record across all batches',()=>{const h=boot();h.run('renderHistory()');h.request('v0');h.flush();h.run('renderHistoryBatch();renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(1,101));});
check('boundary deletion leaves the next batch first record visible',()=>{const h=boot();h.run('renderHistory()');h.request('v49');h.flush();h.run('renderHistoryBatch();renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(0,101).filter(x=>x!=='v49'));});
check('multiple success callbacks and repeated requests never over-decrement',()=>{const h=boot();h.run('renderHistory()');h.request('v0');h.request('v0');h.request('v20');h.flush(true,2);h.flush();h.flush();h.run('renderHistoryBatch();renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(0,101).filter(x=>!['v0','v20'].includes(x)));});
check('failed deletion preserves rows and next batch boundary',()=>{const h=boot();h.run('renderHistory()');h.request('v0');h.flush(false);h.run('renderHistoryBatch();renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(0,101));});
check('filtered pagination retains matching tail record after deletion',()=>{const h=boot();h.run('renderHistory("even")');h.request('v0');h.flush();h.run('renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(0,101).filter(x=>Number(x.slice(1))%2===0&&x!=='v0'));});
check('late callback after filter change only adjusts current matching prefix',()=>{const h=boot();h.run('renderHistory()');h.request('v0');h.run('renderHistory("odd")');h.flush();h.run('renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(0,101).filter(x=>Number(x.slice(1))%2===1));});
check('late deletion now outside rendered prefix preserves current boundary',()=>{const h=boot();h.run('renderHistory();renderHistoryBatch()');h.request('v75');h.run('renderHistory()');h.flush();h.run('renderHistoryBatch();renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(0,101).filter(x=>x!=='v75'));});
check('deleting the final record leaves no negative cursor or phantom rows',()=>{const h=boot();h.run('allHistoryData=allHistoryData.slice(0,1);renderHistory()');h.request('v0');h.flush();h.run('renderHistoryBatch()');assert.deepEqual(h.ids(),[]);assert.equal(h.run('historyRenderedCount'),0);});
check('late success removes the current same-ID row after unfiltered redraw',()=>{const h=boot();h.run('renderHistory()');h.request('v0');h.run('renderHistory()');h.flush();h.run('renderHistoryBatch();renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(1,101));});
check('late success removes the current same-ID row after matching filtered redraw',()=>{const h=boot();h.run('renderHistory()');h.request('v0');h.run('renderHistory("even")');h.flush();h.run('renderHistoryBatch()');assert.deepEqual(h.ids(),sequence(0,101).filter(x=>Number(x.slice(1))%2===0&&x!=='v0'));});
check('deleting the only row of a day removes its empty header',()=>{const h=boot();h.context.formatDateGroup=t=>t===1?'first':'rest';h.run('allHistoryData[0].watchedAt=1;renderHistory()');h.request('v0');h.flush();assert(!h.context.historyList.children.some(x=>x.className==='history-date-header'&&x.textContent==='first'));});
check('deleting the rendered day tail restores header on next batch',()=>{const h=boot();h.context.formatDateGroup=t=>t===1?'first':'rest';h.run('allHistoryData.forEach((v,i)=>v.watchedAt=i<49?1:0);renderHistory()');h.request('v49');h.flush();assert.equal(h.context.historyList.children.filter(x=>x.className==='history-date-header'&&x.textContent==='rest').length,0);h.run('renderHistoryBatch()');assert.equal(h.context.historyList.children.filter(x=>x.className==='history-date-header'&&x.textContent==='rest').length,1);assert(h.ids().includes('v50'));});
check('filter redraw between success and animation timer retains its current header',()=>{const h=boot();h.run('renderHistory()');h.request('v0');h.flush(true,0,false);h.run('renderHistory("odd")');h.finishTimers();assert.deepEqual(h.ids(),sequence(0,101).filter(x=>Number(x.slice(1))%2===1));assert.equal(h.context.historyList.querySelectorAll('.history-date-header').length,1);});
check('next batch during animation retains the same-day header and all rows',()=>{const h=boot();h.context.formatDateGroup=t=>t===1?'first':'rest';h.run('allHistoryData.forEach((v,i)=>v.watchedAt=i<49?1:0);renderHistory()');h.request('v49');h.flush(true,0,false);h.run('renderHistoryBatch()');h.finishTimers();assert.equal(h.context.historyList.children.filter(x=>x.className==='history-date-header'&&x.textContent==='rest').length,1);assert.deepEqual(h.ids(),sequence(0,100).filter(x=>x!=='v49'));});
console.log(`${passed} cases passed; failures=${process.exitCode?'present':0}`);
