import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Exercise the Runtime shipped beside this kit.
const runtimeDir=fileURLToPath(new URL('../',import.meta.url));
import { context, fenced, classify, tree, sha, fileDigest, execute, sleep, killTree } from '../kits/general/lib.mjs';
import { perform } from '../kits/general/adapter.mjs';
// Read and execute only the Worker's pure declaration/mapping functions. Importing
// the whole module would pull in the optional installed MCP SDK (not needed here).
const workerSource=fs.readFileSync(path.join(runtimeDir,'worker','rulith-worker.mjs'),'utf8').replaceAll('\r\n','\n');
function pureWorkerFunction(name) {
  const start=workerSource.indexOf(`function ${name}(`); assert.ok(start>=0,name);
  const end=workerSource.indexOf('\n}',start); assert.ok(end>=0,name);
  return workerSource.slice(start,end+2);
}
const constant=name=>workerSource.match(new RegExp(`const ${name} = (.*)`))[0];
const {assertParamTable,assertReturnRows,resultFactsFromRows}=new Function(
  [constant('PARAM_TYPE_TOKENS'),constant('PARAM_NAME_PATTERN'),constant('RETURN_PREDICATE'),constant('MAX_RETURN_ROWS'),pureWorkerFunction('assertParamTable'),pureWorkerFunction('assertReturnRow'),pureWorkerFunction('assertReturnRows'),pureWorkerFunction('resultFactsFromRows'),'return {assertParamTable,assertReturnRows,resultFactsFromRows}'].join('\n')
)();

const workspace = fileURLToPath(new URL('../',import.meta.url));
const scratch = path.join(workspace,'.scratch'); fs.mkdirSync(scratch,{recursive:true});
async function treeKillAvailable(t) {
  if (process.platform !== 'win32') return true;
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
  try { await killTree(child.pid); return true; }
  catch { try { child.kill(); } catch {} t.skip('Windows sandbox denies taskkill /T /F; real tree kill cannot be exercised'); return false; }
}
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(scratch,'eng-test-')); const root=path.join(dir,'root'); const home=path.join(dir,'pins');
  fs.mkdirSync(root); fs.mkdirSync(path.join(home,'specs'),{recursive:true});
  fs.writeFileSync(path.join(home,'specs','test.json'),JSON.stringify({command:['node','test.mjs'],output_dirs:['build','out']}));
  fs.writeFileSync(path.join(root,'test.mjs'),'process.exit(0)');
  const env={...process.env,RULITH_SOURCE_TYPE:'file',RULITH_SOURCE_ACCESS:root,ENG_KIT_HOME:home}; const ctx=context(env);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,root,home,env,ctx,call:(tool,args)=>perform(tool,args,env)};
}
test('requires governed file Source and owner pin directory outside it',t=>{
  const f=fixture(t); assert.throws(()=>context({...f.env,RULITH_SOURCE_TYPE:'http'}),/Source required/);
  assert.throws(()=>context({...f.env,ENG_KIT_HOME:f.root}),/pin directory refused/);
  assert.throws(()=>context({...f.env,RULITH_SOURCE_ACCESS:'.'}),/Source required/);
});
test('real paths and absent descendants cannot escape through traversal',t=>{
  const f=fixture(t); const outside=path.join(f.dir,'outside'); fs.mkdirSync(outside);
  assert.throws(()=>fenced(f.ctx.root,'../outside'),/path refused/);
  assert.throws(()=>fenced(f.ctx.root,'../outside/new/file.txt'),/path refused/);
  assert.equal(fenced(f.ctx.root,'new.txt'),path.join(f.root,'new.txt'));
});
test('command classifier refuses destructive and outside-root commands',t=>{
  const f=fixture(t);
  for(const command of [['rm','a'],['cmd','/c','del a'],['git','push'],['npm','install','-g','thing'],['Stop-Service','thing'],['net','stop','thing'],['sc','stop','thing'],['node','--eval','1'],['git','config','--global','x','y'],['node','a.mjs','--out='+f.home],['node','a.mjs','../pins/file'],['echo','x;rm'],[process.execPath,'x']]) assert.throws(()=>classify(f.ctx,command),/refused/);
  assert.equal(classify(f.ctx,['node','test.mjs']).cwd,f.root);
  assert.throws(()=>classify(f.ctx,['node','test.mjs'],'../pins'),/path refused/);
});
test('write and literal patch confirm read-back and enforce digest and byte limit',async t=>{
  const f=fixture(t);
  const a=await f.call('write_file',{path:'a.txt',text:'hello',expect_digest:sha('')});
  assert.equal(a.rows[0].readback_digest,sha(fs.readFileSync(path.join(f.root,'a.txt'))));
  assert.equal(a.rows[0].from_gen,0); assert.equal(a.rows[0].to_gen,1);
  const b=await f.call('patch_file',{path:'a.txt',old_text:'hello',text:'world',expect_digest:sha('hello')}); assert.equal(b.rows[0].digest,sha('world'));
  await assert.rejects(f.call('write_file',{path:'a.txt',text:'x',expect_digest:sha('wrong')}),/digest changed/);
  await assert.rejects(f.call('write_file',{path:'b',text:'汉'.repeat(6000),expect_digest:sha('')}),/16 KiB/);
  await assert.rejects(f.call('patch_file',{path:'a.txt',old_text:'absent',text:'x',expect_digest:sha('world')}),/match once/);
});
test('tree digest is deterministic, skips pinned output dirs, and never calls git',t=>{
  const f=fixture(t); const first=tree(f.ctx).digest;
  fs.mkdirSync(path.join(f.root,'build')); fs.writeFileSync(path.join(f.root,'build','a'),'output');
  fs.mkdirSync(path.join(f.root,'.git')); fs.writeFileSync(path.join(f.root,'.git','config'),'arbitrary hooks');
  assert.equal(tree(f.ctx).digest,first);
  fs.writeFileSync(path.join(f.root,'b'),'b'); fs.writeFileSync(path.join(f.root,'a'),'a'); const second=tree(f.ctx).digest;
  fs.unlinkSync(path.join(f.root,'a')); fs.writeFileSync(path.join(f.root,'a'),'a'); assert.equal(tree(f.ctx).digest,second);
  const walker=fs.readFileSync(new URL('../kits/general/lib.mjs',import.meta.url),'utf8'); assert.doesNotMatch(walker,/spawn\(['"]git|execFile\(['"]git/);
});
test('generation tracks actual changes; passing test is invalidated and its edge replayed',async t=>{
  const f=fixture(t); const pass=await f.call('test',{}); assert.equal(pass.rows[0].gen,0); assert.equal(pass.rows[0].from_gen,-1);
  const edit=await f.call('write_file',{path:'a',text:'a',expect_digest:sha('')}); assert.equal(edit.rows[0].from_gen,0);
  const read=await f.call('read',{path:'a'}); assert.ok(read.rows.every(r=>r.from_gen===undefined&&r.to_gen===undefined));
  const next=await f.call('test',{}); assert.equal(next.rows[0].gen,1); assert.ok(next.rows.every(r=>r.from_gen!==1)); assert.ok(next.rows.some(r=>r.from_gen===pass.rows[0].gen));
  const same=await f.call('write_file',{path:'a',text:'a',expect_digest:sha('a')}); assert.ok(same.rows.every(r=>r.from_gen!==1));
  assert.equal((await f.call('tree_state',{})).rows[0].gen,1);
  await assert.rejects(f.call('test',{command:['echo','fake']}),/no arguments/);
});
test('a changing test stamps its final generation, a free run cannot emit test_result',async t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'test.mjs'),"import fs from 'node:fs'; fs.writeFileSync('test-output.txt','yes')");
  const pass=await f.call('test',{}); assert.equal(pass.rows[0].gen,1); assert.equal(pass.rows[0].tree_digest,tree(f.ctx).digest); assert.ok(pass.rows.every(r=>r.from_gen!==1));
  const run=await f.call('run',{command:['node','test.mjs'],cwd:'.'}); assert.equal(run.rows[0].exit_code,0); assert.equal(run.rows[0].gen,undefined); assert.equal(run.rows[0].value_milli,undefined);
});
test('list and search keep their rows small enough to report twice in one receipt and say when they stop short',async t=>{
  const f=fixture(t);
  for(let i=0;i<60;i++) fs.writeFileSync(path.join(f.root,`file-${String(i).padStart(2,'0')}.txt`),'needle\nneedle\n');
  const search=await f.call('search',{path:'.',query:'needle'});
  assert.ok(search.rows.length>0&&search.rows.length<120,`${search.rows.length} rows`);
  assert.ok(Buffer.byteLength(JSON.stringify(search.rows))<=1800); assert.equal(search.truncated,true);
  const list=await f.call('list',{path:'.'});
  assert.ok(Buffer.byteLength(JSON.stringify(list.rows))<=1800); assert.equal(list.truncated,true);
  const few=await f.call('search',{path:'test.mjs',query:'exit'}); assert.equal(few.rows.length,1); assert.equal(few.truncated,undefined);
});
test('read, list and literal search produce observations with bounded text',async t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'a.txt'),'needle\n'+'x'.repeat(10000));
  const read=await f.call('read',{path:'a.txt'}); assert.ok(Buffer.byteLength(read.head)<=5000); assert.equal(Buffer.byteLength(read.tail),1024); assert.equal(read.next_offset,Buffer.byteLength(read.head));
  assert.ok((await f.call('list',{path:'.'})).rows.some(r=>r.path==='a.txt'));
  assert.equal((await f.call('search',{path:'.',query:'needle'})).rows[0].line,1);
  assert.equal((await f.call('read',{path:'a.txt',offset:2000})).rows[0].offset,2000);
  await assert.rejects(f.call('read',{path:'a.txt',offset:-1}),/offset refused/);
});
test('pinned measurements map integer milli-values, units, repeats and digests',async t=>{
  const f=fixture(t); fs.mkdirSync(path.join(f.root,'build'));
  const filename=process.platform==='win32'?'node.exe':'node'; const binary=path.join(f.root,'build',filename);
  fs.copyFileSync(process.execPath,binary); fs.chmodSync(binary,0o755);
  fs.writeFileSync(path.join(f.root,'measure.mjs'),'console.log(JSON.stringify({value_milli:1200}))');
  fs.writeFileSync(path.join(f.root,'config'),'pinned');fs.writeFileSync(path.join(f.root,'build','candidate'),'candidate');
  const spec={command:[`./build/${filename}`,'measure.mjs'],binary:`build/${filename}`,candidate_binary:'build/candidate',workload:'measure.mjs',config:'config',binary_digest:fileDigest(binary),workload_digest:fileDigest(path.join(f.root,'measure.mjs')),config_digest:sha('pinned'),parser:{kind:'json_integer_milli',field:'value_milli'},unit:'ms',repeats:2,output_dirs:['build']};
  fs.writeFileSync(path.join(f.home,'specs','measure.json'),JSON.stringify(spec));
  const result=await f.call('measure_pinned',{spec_id:'measure'});assert.deepEqual(result.rows.map(r=>r.value_milli),[1200,1200]);assert.deepEqual(result.rows.map(r=>r.repeat),[1,2]);assert.ok(result.rows.every(r=>r.binary_digest===spec.binary_digest&&r.unit==='ms'&&r.candidate_digest===sha('candidate')));
  const tool=JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json',import.meta.url))).tools['eng.measure_pinned@1'];assert.equal(resultFactsFromRows(tool,result.rows).filter(f=>f.predicate==='eng.measurement').length,2);
});
test('an interpreted harness writes a result file; the pinned path to one number becomes the milli-value',async t=>{
  const f=fixture(t); fs.mkdirSync(path.join(f.root,'tools')); fs.mkdirSync(path.join(f.root,'logs'));
  const script="import fs from 'node:fs'; console.log('lots of progress text '.repeat(200)); fs.writeFileSync('logs/results.json',JSON.stringify({run:[{tps:1.5},{tps:12.25}]}))";
  fs.writeFileSync(path.join(f.root,'tools','bench.mjs'),script); fs.writeFileSync(path.join(f.root,'config'),'pinned'); fs.writeFileSync(path.join(f.root,'candidate'),'c');
  const spec={interpreter:'node',command:['node','tools/bench.mjs'],binary:'tools/bench.mjs',candidate_binary:'candidate',workload:'tools/bench.mjs',config:'config',
    binary_digest:fileDigest(path.join(f.root,'tools','bench.mjs')),workload_digest:fileDigest(path.join(f.root,'tools','bench.mjs')),config_digest:sha('pinned'),
    parser:{kind:'json_file_number_milli',file:'logs/results.json',path:['run',-1,'tps']},unit:'tokens_per_second',repeats:1,output_dirs:['logs']};
  fs.writeFileSync(path.join(f.home,'specs','bench.json'),JSON.stringify(spec));
  const result=await f.call('measure_pinned',{spec_id:'bench'}); assert.deepEqual(result.rows.map(r=>r.value_milli),[12250]);
  assert.deepEqual((await f.call('tree_state',{})).measure_specs,['bench']);
  // A run that leaves the result file as it was measured nothing.
  fs.writeFileSync(path.join(f.root,'tools','stale.mjs'),"console.log('no file written')");
  fs.writeFileSync(path.join(f.home,'specs','stale.json'),JSON.stringify({...spec,command:['node','tools/stale.mjs'],binary:'tools/stale.mjs',binary_digest:fileDigest(path.join(f.root,'tools','stale.mjs'))}));
  await assert.rejects(f.call('measure_pinned',{spec_id:'stale'}),/measurement failed/);
  // The interpreter must be the pinned one, and the script the pinned binary.
  fs.writeFileSync(path.join(f.home,'specs','other.json'),JSON.stringify({...spec,command:['python','tools/bench.mjs']}));
  await assert.rejects(f.call('measure_pinned',{spec_id:'other'}),/spec refused/);
});
test('a self- spec comes from the project, is frozen into the kit home on first use and never changes',async t=>{
  const f=fixture(t); fs.mkdirSync(path.join(f.root,'logs')); fs.mkdirSync(path.join(f.root,'.deep-rulith','measure'),{recursive:true});
  const write=v=>fs.writeFileSync(path.join(f.root,'bench.mjs'),`import fs from 'node:fs'; fs.writeFileSync('logs/r.json',JSON.stringify({tps:${v}}))`);
  write(2.5); fs.writeFileSync(path.join(f.root,'config'),'pinned'); fs.writeFileSync(path.join(f.root,'candidate'),'c');
  const spec={interpreter:'node',command:['node','bench.mjs'],binary:'bench.mjs',candidate_binary:'candidate',workload:'config',config:'config',
    binary_digest:fileDigest(path.join(f.root,'bench.mjs')),workload_digest:sha('pinned'),config_digest:sha('pinned'),
    parser:{kind:'json_file_number_milli',file:'logs/r.json',path:['tps']},unit:'tokens_per_second',repeats:1,output_dirs:['logs']};
  const own=path.join(f.root,'.deep-rulith','measure','fast.json'); fs.writeFileSync(own,JSON.stringify(spec));
  await assert.rejects(f.call('measure_pinned',{spec_id:'self-missing'}),/spec refused/);
  const first=await f.call('measure_pinned',{spec_id:'self-fast'}); assert.deepEqual(first.rows.map(r=>[r.spec_id,r.value_milli]),[['self-fast',2500]]);
  assert.ok((await f.call('tree_state',{})).measure_specs.includes('self-fast'));
  // Editing the project copy afterwards changes nothing: the frozen spec still governs (its digest pins the old script).
  fs.writeFileSync(own,JSON.stringify({...spec,repeats:2}));
  const again=await f.call('measure_pinned',{spec_id:'self-fast'}); assert.equal(again.rows.length,1); assert.equal(again.rows[0].spec_digest,first.rows[0].spec_digest);
  write(9); await assert.rejects(f.call('measure_pinned',{spec_id:'self-fast'}),/binary digest changed/);
});
test('read pages a long file: where the unread part starts, whether it is complete, and on which line the window begins',async t=>{
  const f=fixture(t); const lines=Array.from({length:600},(_,i)=>`line ${String(i+1).padStart(3,'0')} ${'x'.repeat(14)}`).join('\n'); // 24 bytes per line
  fs.writeFileSync(path.join(f.root,'long.txt'),lines);
  const first=await f.call('read',{path:'long.txt'}); assert.equal(first.complete,false); assert.equal(first.start_line,1);
  assert.equal(first.next_offset,Buffer.byteLength(first.head)); assert.equal(first.tail,lines.slice(-1024)); assert.ok(first.next_offset>3000,String(first.next_offset));
  // Paging from 0 by next_offset gives the file back exactly, each window with the line it starts on.
  let at=0, text='', pages=0;
  for(;;){ const page=await f.call('read',{path:'long.txt',offset:at}); pages++;
    assert.equal(page.start_line,lines.slice(0,at).split('\n').length); assert.equal(page.tail,''); text+=page.head;
    if(page.complete){ assert.equal(page.next_offset,null); break; }
    assert.equal(page.next_offset,at+Buffer.byteLength(page.head)); at=page.next_offset; }
  assert.equal(text,lines); assert.ok(pages<=4,`${pages} pages`);
  fs.writeFileSync(path.join(f.root,'short.txt'),'tiny'); const short=await f.call('read',{path:'short.txt'}); assert.equal(short.complete,true); assert.equal(short.next_offset,null); assert.equal(short.head,'tiny');
});
test('a read receipt fits the 8 KiB inline budget whatever the text, and never splits a character',async t=>{
  const f=fixture(t); const unit=['"','\\','\n','\t',String.fromCharCode(1),' 引号「中文」','\u{1F600}',' {"k":"v"}','\r\n'].join('');
  const nasty=unit.repeat(400); fs.writeFileSync(path.join(f.root,'nasty.txt'),nasty);
  fs.writeFileSync(path.join(f.root,'control.bin'),String.fromCharCode(1).repeat(9000));
  const control=await f.call('read',{path:'control.bin'}); assert.ok(Buffer.byteLength(JSON.stringify({result:JSON.stringify(control)}))<=7000);
  const tool=JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json',import.meta.url))).tools['eng.read@1'];
  for(const args of [{path:'nasty.txt'},{path:'nasty.txt',offset:0}]){
    const out=await f.call('read',args); const report={result:JSON.stringify(out),reason:'',facts:resultFactsFromRows(tool,out.rows)};
    const bytes=Buffer.byteLength(JSON.stringify(report)); assert.ok(bytes<=8192,String(bytes)); assert.ok(!out.head.includes('\uFFFD')); }
  let at=0, text='';
  for(;;){ const page=await f.call('read',{path:'nasty.txt',offset:at}); text+=page.head; if(page.complete) break; at=page.next_offset; }
  assert.equal(text,nasty);
});
test('run records output hashes and changes but printed numbers remain text',async t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'run.mjs'),"import fs from 'node:fs'; fs.writeFileSync('changed','x'); console.log('value_milli=9000'); console.error('err')");
  const run=await f.call('run',{command:['node','run.mjs'],cwd:'.'});
  assert.equal(run.rows[0].stdout_digest,sha('value_milli=9000\n')); assert.match(run.head,/9000/); assert.equal(run.rows[0].value_milli,undefined); assert.match(run.rows[0].changed_files,/changed/); assert.equal(run.rows[0].to_gen,1);
});
test('deadline kills child and grandchild process tree',async t=>{
  if (!await treeKillAvailable(t)) return;
  const f=fixture(t);
  // 每个测试进程 60 秒后自行退出：测试运行器若被外部杀掉，留下的进程树不会一直跑下去（10-07 曾留下一棵跑了 20 小时的作业树）。
  fs.writeFileSync(path.join(f.root,'grandchild.mjs'),"import fs from 'node:fs'; fs.writeFileSync('grandchild.pid',String(process.pid)); setInterval(()=>fs.appendFileSync('heart','x'),50); setTimeout(()=>process.exit(0),60000)");
  fs.writeFileSync(path.join(f.root,'child.mjs'),"import {spawn} from 'node:child_process'; spawn(process.execPath,['grandchild.mjs'],{stdio:'inherit'}); setTimeout(()=>process.exit(0),60000)");
  fs.writeFileSync(path.join(f.root,'parent.mjs'),"import {spawn} from 'node:child_process'; spawn(process.execPath,['child.mjs'],{stdio:'inherit'}); setTimeout(()=>process.exit(0),60000)");
  const r=await execute(['node','parent.mjs'],f.root,{deadlineMs:1200}); assert.equal(r.timed_out,true); assert.ok(r.duration_ms<8000);
  const bytes=fs.statSync(path.join(f.root,'heart')).size; await sleep(300); assert.equal(fs.statSync(path.join(f.root,'heart')).size,bytes);
});
test('job survives adapter exit, blocks other tools, then poll and stop kill descendants',async t=>{
  if (!await treeKillAvailable(t)) return;
  const f=fixture(t);
  // 作业是刻意脱离适配器的；两层进程都在 60 秒后自行退出，测试运行器被外部杀掉时也不会留下常驻进程。
  fs.writeFileSync(path.join(f.root,'job-child.mjs'),"import fs from 'node:fs'; setInterval(()=>fs.appendFileSync('job-heart','x'),50); setTimeout(()=>process.exit(0),60000)");
  fs.writeFileSync(path.join(f.root,'job.mjs'),"import {spawn} from 'node:child_process'; spawn(process.execPath,['job-child.mjs'],{stdio:'inherit'}); setTimeout(()=>process.exit(0),60000)");
  const adapter=fileURLToPath(new URL('../kits/general/job_start.mjs',import.meta.url));
  const receipt=JSON.parse(execFileSync(process.execPath,[adapter,JSON.stringify({command:['node','job.mjs'],cwd:'.'})],{env:f.env,encoding:'utf8'}));
  const id=receipt.rows[0].job_id;
  t.after(async()=>{ try { await f.call('job_stop',{job_id:id}); } catch {} });
  // 监督进程与两层 node 的启动在负载下要几百毫秒到数秒：等到心跳文件出现为止（上限 15 秒），不按固定时长猜。
  for(let i=0;i<300&&!fs.existsSync(path.join(f.root,'job-heart'));i++) await sleep(50);
  assert.ok(fs.statSync(path.join(f.root,'job-heart')).size>0);
  for(const name of ['write_file','run','test','measure_pinned','job_start']) await assert.rejects(f.call(name,{}),/job live/);
  // Reads go ahead while the job runs, and record no generation step of their own.
  const seen=await f.call('list',{path:'.'}); assert.ok(seen.rows.some(r=>r.path==='job.mjs')); assert.ok(seen.rows.every(r=>r.from_gen===undefined));
  const poll=await f.call('job_poll',{job_id:id,wait_s:0}); assert.equal(poll.rows[0].status,'running');
  const stop=await f.call('job_stop',{job_id:id}); assert.equal(stop.rows[0].status,'stopped');
  const bytes=fs.statSync(path.join(f.root,'job-heart')).size; await sleep(200); assert.equal(fs.statSync(path.join(f.root,'job-heart')).size,bytes);
});
test('measurement refuses a changed binary digest before execution',async t=>{
  const f=fixture(t); const binary=path.join(f.root,'measure.exe'); fs.writeFileSync(binary,'changed');
  fs.writeFileSync(path.join(f.root,'candidate'),'candidate'); fs.writeFileSync(path.join(f.root,'workload'),'workload'); fs.writeFileSync(path.join(f.root,'config'),'config');
  const spec={command:['./measure.exe'],binary:'measure.exe',candidate_binary:'candidate',workload:'workload',config:'config',binary_digest:sha('original'),workload_digest:sha('workload'),config_digest:sha('config'),parser:{kind:'json_integer_milli',field:'value_milli'},unit:'ms',repeats:2,output_dirs:[]};
  fs.writeFileSync(path.join(f.home,'specs','measure.json'),JSON.stringify(spec));
  await assert.rejects(f.call('measure_pinned',{spec_id:'measure'}),/binary digest changed/);
  fs.writeFileSync(path.join(f.home,'specs','measure.json'),JSON.stringify({...spec,command:['node','test.mjs']})); await assert.rejects(f.call('measure_pinned',{spec_id:'measure'}),/spec refused|ENOENT/);
});
test('manifest matches Worker scalar mapping',t=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json',import.meta.url)));
  assert.equal(Object.keys(manifest.tools).length,18);
  for(const [id,tool]of Object.entries(manifest.tools)){assert.match(id,/@[1-9][0-9]*$/);assertParamTable(tool.params,id);assertReturnRows(tool.returns,id);}
  for(const [id,tool]of Object.entries(manifest.tools)) { assert.equal(tool.adapter,'run'); assert.deepEqual(tool.sourceTypes,['file']); assert.ok(tool.returns.length<=32); assert.ok(tool.returns.every(r=>Object.keys(r.args).length<=32)); assert.ok(fs.existsSync(path.join(workspace,'kits/general',tool.entry.split('/').at(-1)))); }
});
test('read tools write no Board facts; tree_state reports only eng.tree; tools that can change the tree still report eng.tree_step',()=>{
  const tools=JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json',import.meta.url))).tools;
  const predicates=id=>tools[id].returns.map(r=>r.predicate);
  // Reads write no Board facts: their entries, text and matches reach the model in the call result (D-1011a, owner 10-11).
  assert.deepEqual(predicates('eng.list@1'),[]); assert.deepEqual(predicates('eng.read@1'),[]);
  assert.deepEqual(predicates('eng.search@1'),[]); assert.deepEqual(predicates('eng.tree_state@1'),['eng.tree']);
  for(const id of ['eng.write_file@1','eng.patch_file@1','eng.run@1','eng.job_start@1','eng.job_poll@1','eng.job_stop@1','eng.test@1','eng.measure_pinned@1'])
    assert.deepEqual(tools[id].returns.find(r=>r.predicate==='eng.tree_step'),{predicate:'eng.tree_step',args:{from_gen:'$from_gen',to_gen:'$to_gen'}},id);
});
test('evidence predicates keep their exact mappings',()=>{
  const tools=JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json',import.meta.url))).tools;
  const columns=names=>Object.fromEntries(names.map(n=>[n,'$'+n]));
  const fileState={predicate:'eng.file_state',args:columns(['path','prev_digest','digest','readback_digest','bytes'])};
  const jobState={predicate:'eng.job_state',args:columns(['job_id','status','exit_code','command_digest','tree_before'])};
  const expected={
    'eng.write_file@1':fileState,'eng.patch_file@1':fileState,'eng.job_start@1':jobState,'eng.job_poll@1':jobState,'eng.job_stop@1':jobState,
    'eng.run@1':{predicate:'eng.command_result',args:columns(['run_id','command_digest','exit_code','timed_out','duration_ms','stdout_digest','stderr_digest','stdout_bytes','stderr_bytes','tree_before','tree_after','changed_files'])},
    'eng.test@1':{predicate:'eng.test_result',args:columns(['spec_digest','gen','tree_digest','exit_code'])},
    'eng.measure_pinned@1':{predicate:'eng.measurement',args:columns(['spec_id','repeat','value_milli','unit','spec_digest','binary_digest','candidate_digest','workload_digest','config_digest'])},
    'eng.tree_state@1':{predicate:'eng.tree',args:columns(['gen','tree_digest'])},
  };
  for(const [id,row] of Object.entries(expected)) assert.deepEqual(tools[id].returns[0],row,id);
});
test('a change a read sees first is still invalidated by the next receipt of a tool that can change the tree',async t=>{
  const f=fixture(t); const pass=await f.call('test',{}); assert.equal(pass.rows[0].exit_code,0); assert.equal(pass.rows[0].gen,0);
  fs.writeFileSync(path.join(f.root,'outside.txt'),'edited outside the tools');
  const seen=await f.call('tree_state',{}); assert.equal(seen.rows[0].gen,1); assert.deepEqual(Object.keys(seen.rows[0]).sort(),['gen','tree_digest']);
  const run=await f.call('run',{command:'node test.mjs',cwd:'.'});
  assert.ok(run.rows.some(r=>r.from_gen===0&&r.to_gen===1),JSON.stringify(run.rows.map(r=>[r.from_gen,r.to_gen])));
});
test('real Worker maps changing and no-change receipts without fabricating numeric facts',async t=>{
  const f=fixture(t); const manifest=JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json',import.meta.url)));
  for(const [tool,args]of [['tree_state',{}],['write_file',{path:'a',text:'abc',expect_digest:sha('')}],['read',{path:'a'}],['search',{path:'.',query:'abc'}],['list',{path:'.'}],['run',{command:['node','test.mjs'],cwd:'.'}],['test',{}]]) {
    const declared=manifest.tools[`eng.${tool}@1`]; const result=await f.call(tool,args); const facts=resultFactsFromRows(declared,result.rows);
    assert.equal(facts.length,result.rows.length*declared.returns.length);
    assert.equal(facts.some(f=>f.predicate==='eng.tree_step'),!['tree_state','read','search','list'].includes(tool),tool);
    assert.ok(facts.every(f=>f.predicate!=='eng.measurement'));
  }
});
test('finite detached job survives its adapter, then finishes through poll',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'job.mjs'),"import fs from 'node:fs'; setTimeout(()=>{fs.writeFileSync('job-output','done');},500)");
  const adapter=fileURLToPath(new URL('../kits/general/job_start.mjs',import.meta.url));
  const receipt=JSON.parse(execFileSync(process.execPath,[adapter,JSON.stringify({command:['node','job.mjs'],cwd:'.'})],{env:f.env,encoding:'utf8'}));
  const id=receipt.rows[0].job_id;
  const look=await f.call('tree_state',{}); assert.equal(look.rows[0].from_gen,undefined); assert.equal(look.rows[0].gen,0);
  const done=await f.call('job_poll',{job_id:id,wait_s:2}); assert.equal(done.rows[0].status,'done'); assert.equal(done.rows[0].exit_code,0); assert.equal(fs.readFileSync(path.join(f.root,'job-output'),'utf8'),'done');
  const facts=resultFactsFromRows(JSON.parse(fs.readFileSync(new URL('../kits/general/worker-tools.json',import.meta.url))).tools['eng.job_poll@1'],done.rows);assert.ok(facts.some(f=>f.predicate==='eng.tree_step'&&f.args.from_gen===0));
});
test('a command line string is split into argv without a shell',async t=>{
  const f=fixture(t);
  const ok=await f.call('run',{command:'node test.mjs',cwd:'.'}); assert.ok(ok.rows.length>0);
  for (const bad of ['node test.mjs | more','node test.mjs && echo x','node "unclosed','node $(whoami)','node test.mjs > out.txt']) await assert.rejects(f.call('run',{command:bad,cwd:'.'}),/command refused/);
});
test('recording git history is refused anywhere in a shell line unless the owner allows git_commit', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'settings.json'), JSON.stringify({ shell: true }));
  for (const line of ['git commit -m x', 'cd src && git commit -am x', 'git -C . tag v1', 'git merge main', 'echo hi && git config user.name x', 'git reset --hard'])
    assert.throws(() => classify(f.ctx, line, '.'), /command refused/, line);
  for (const line of ['git status', 'git log --merges', 'git diff HEAD~1', 'git stash'])
    assert.doesNotThrow(() => classify(f.ctx, line, '.'), line);
  fs.writeFileSync(path.join(f.home, 'settings.json'), JSON.stringify({ shell: true, allow: ['git_commit'] }));
  assert.doesNotThrow(() => classify(f.ctx, 'git commit -m x', '.'));
});
test('owner settings relax the classifier: outside paths, installs, deletes and the shell', async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(scratch, 'eng-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'model.txt'), 'weights');
  fs.writeFileSync(path.join(f.root, 'cat.mjs'), "import fs from 'node:fs'; console.log(fs.readFileSync(process.argv[2], 'utf8'))");
  const settingsFile = path.join(f.home, 'settings.json');
  await assert.rejects(f.call('run', { command: `node cat.mjs ${path.join(outside, 'model.txt')}`, cwd: '.' }), /path refused/);
  await assert.rejects(f.call('run', { command: 'npm install left-pad', cwd: '.' }), /command refused/);
  await assert.rejects(f.call('run', { command: 'node cat.mjs cat.mjs | more', cwd: '.' }), /command refused/);
  fs.writeFileSync(settingsFile, JSON.stringify({ allowedPaths: [outside], allow: ['install'], shell: true }));
  const read = await f.call('run', { command: `node cat.mjs "${path.join(outside, 'model.txt')}"`, cwd: '.' });
  assert.equal(read.rows[0].exit_code, 0, 'outside read: ' + JSON.stringify(read).slice(0, 400));
  const redirected = await f.call('run', { command: 'node cat.mjs cat.mjs > copy.txt', cwd: '.' });
  assert.equal(redirected.rows[0].exit_code, 0, 'redirect: ' + JSON.stringify(redirected).slice(0, 400));
  assert.match(fs.readFileSync(path.join(f.root, 'copy.txt'), 'utf8'), /readFileSync/);
  for (const always of ['git push origin main', 'npm install -g left-pad', 'taskkill /IM node.exe', 'node -e 1'])
    await assert.rejects(f.call('run', { command: always, cwd: '.' }), /command refused/);
  fs.writeFileSync(settingsFile, JSON.stringify({ allow: ['everything'] }));
  await assert.rejects(f.call('run', { command: 'node cat.mjs cat.mjs', cwd: '.' }), /settings refused/);
});
test('an empty expect_digest creates a new file and refuses to replace one; a write still advances the generation',async t=>{
  const f=fixture(t);
  const made=await f.call('write_file',{path:'new.txt',text:'hello',expect_digest:''}); assert.equal(made.rows[0].digest,sha('hello')); assert.equal(made.rows[0].to_gen,1);
  await assert.rejects(f.call('write_file',{path:'new.txt',text:'again',expect_digest:''}),/file digest changed/);
  await assert.rejects(f.call('patch_file',{path:'new.txt',old_text:'hello',text:'x',expect_digest:''}),/file digest changed/);
  // A read does not walk the tree again afterwards, and reports no generation step.
  const read=await f.call('read',{path:'new.txt'}); assert.equal(read.rows[0].from_gen,undefined);
});
test('**/name skips that folder at any depth; a skipped folder is still searched when the path names it',async t=>{
  const f=fixture(t); fs.writeFileSync(path.join(f.home,'settings.json'),JSON.stringify({treeExclude:['**/node_modules','tmp']}));
  fs.mkdirSync(path.join(f.root,'a','node_modules'),{recursive:true}); fs.writeFileSync(path.join(f.root,'a','node_modules','dep.js'),'needle');
  fs.mkdirSync(path.join(f.root,'tmp','gufo','src'),{recursive:true}); fs.writeFileSync(path.join(f.root,'tmp','gufo','src','gemm.cu'),'x\nneedle here');
  fs.writeFileSync(path.join(f.root,'a','own.js'),'needle');
  const state=await f.call('tree_state',{}); assert.ok(state.rows[0].tree_digest);
  assert.deepEqual((await f.call('search',{path:'.',query:'needle'})).rows.map(r=>r.path),['a/own.js']);
  assert.deepEqual((await f.call('search',{path:'tmp/gufo',query:'needle'})).rows.map(r=>[r.path,r.line]),[['tmp/gufo/src/gemm.cu',2]]);
  // A dependency folder inside the skipped folder stays skipped.
  fs.mkdirSync(path.join(f.root,'tmp','gufo','node_modules')); fs.writeFileSync(path.join(f.root,'tmp','gufo','node_modules','x.js'),'needle');
  assert.equal((await f.call('search',{path:'tmp',query:'needle'})).rows.length,1);
});
test('refusals say what is wrong: the spec field at fault, a missing parent, a missing path',async t=>{
  const f=fixture(t); fs.mkdirSync(path.join(f.root,'.deep-rulith','measure'),{recursive:true}); fs.writeFileSync(path.join(f.root,'bench.py'),'print(1)');
  const spec={interpreter:'python',command:['python','bench.py'],cwd:'.',binary:'bench.py',binary_digest:fileDigest(path.join(f.root,'bench.py')),candidate_binary:'bench.py',
    workload:'synthetic text generated by the script',workload_digest:sha('x'),config:'bench.py',config_digest:fileDigest(path.join(f.root,'bench.py')),
    parser:{kind:'json_file_number_milli',file:'out.json',path:['pp']},unit:'tokens_per_second',repeats:1,output_dirs:['logs']};
  fs.writeFileSync(path.join(f.root,'.deep-rulith','measure','pp.json'),JSON.stringify(spec));
  assert.deepEqual((await f.call('tree_state',{})).measure_specs,['self-pp']);
  await assert.rejects(f.call('measure_pinned',{spec_id:'self-pp'}),/^Error: spec refused: workload is not a file in the project$/);
  // A refused spec is not frozen: it can be corrected under the same name.
  assert.equal(fs.existsSync(path.join(f.home,'specs','self-pp.json')),false);
  fs.writeFileSync(path.join(f.home,'specs','units.json'),JSON.stringify({...spec,workload:'bench.py',unit:'tok/s'}));
  await assert.rejects(f.call('measure_pinned',{spec_id:'units'}),/spec refused: unit must be/);
  await assert.rejects(f.call('measure_pinned',{spec_id:'absent'}),/spec refused: no such spec/);
  await assert.rejects(f.call('write_file',{path:'no/such/dir/x.txt',text:'x',expect_digest:''}),/parent directory missing/);
  // The adapter process prints the verdict on stdout and stderr: fixed words, never the path.
  const adapter=fileURLToPath(new URL('../kits/general/read.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[adapter,JSON.stringify({path:'missing-secret-name.txt'})],{env:f.env,encoding:'utf8'});
  assert.equal(run.status,2); assert.equal(run.stderr,'path not found'); assert.equal(JSON.parse(run.stdout).verdict,'path not found');
  const bad=spawnSync(process.execPath,[fileURLToPath(new URL('../kits/general/measure_pinned.mjs',import.meta.url)),JSON.stringify({spec_id:'self-pp'})],{env:f.env,encoding:'utf8'});
  assert.equal(bad.stderr,'spec refused: workload is not a file in the project');
});
