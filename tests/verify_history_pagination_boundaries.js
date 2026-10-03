const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const scaffold=fs.readFileSync(path.join(__dirname,'verify_history_reload_delete.js'),'utf8');
const end=scaffold.indexOf('\nlet passed = 0, failed = 0;');assert.ok(end>0);
const prefix=scaffold.slice(0,end);assert.equal(prefix.split('length: 240').length,2);
let passed=0,failed=0;
function reference(rows,mode){return rows.slice().sort((a,b)=>mode==='date-desc'?b.watchedAt-a.watchedAt:
 mode==='date-asc'?a.watchedAt-b.watchedAt:mode==='count-desc'?b.playCount-a.playCount||b.watchedAt-a.watchedAt:
 mode==='channel'?a.channel.localeCompare(b.channel)||b.watchedAt-a.watchedAt:a.title.localeCompare(b.title)).map(v=>v.videoId);}
for(const size of [1,99,100,101,199,200,201,10000]) for(const mode of ['date-desc','date-asc','count-desc','channel','title']) for(const pageEdge of(size>=199?[99,199]:[99])){
 const name=`${size} records/${mode}/index ${pageEdge}: page edge delete-scroll-undo`;
 try{
  const scope={require,__dirname,structuredClone,console};
  vm.runInNewContext(prefix.replace('length: 240',`length: ${size}`)+'\nglobalThis.setup=setup;',scope);
  const c=scope.setup(mode), expected=Array.from(reference(c.db,mode));
  assert.deepEqual(Array.from(c.api.sorted(),v=>v.videoId),expected);
  if(pageEdge>=100)c.api.renderBatch();
  const entry=c.removeAt(Math.min(pageEdge,size-1)), remaining=expected.filter(id=>id!==entry.video.videoId);
  assert.deepEqual(Array.from(c.api.sorted(),v=>v.videoId),remaining);
  while(c.api.count()<remaining.length)c.api.renderBatch();
  const visible=c.content.children.filter(row=>row.videoId&&!row.hidden).map(row=>row.videoId);
  assert.deepEqual(Array.from(visible),remaining,'pending delete must not skip or duplicate later pages');
  assert.equal(c.api.count(),remaining.length);
  c.api.restoreDelete(entry);c.assertView();assert.equal(c.api.count(),size);
  assert.equal(c.state.deletes.length,0,'Undo must not write to the DB');
  passed++;console.log('PASS '+name);
 }catch(e){failed++;console.error('FAIL '+name+': '+e.message);}
}
console.log(JSON.stringify({passed,failed,scope:'actual production rendering/deletion functions; page edges and 10k synthetic records, no browser/account'}));
process.exitCode=failed?1:0;
