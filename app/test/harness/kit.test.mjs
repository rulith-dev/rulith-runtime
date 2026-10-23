import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RulithMcp, PROTOCOL, TOOLS, apply as applyBridge } from '../../harness/rulith-mcp.mjs';
import { restrictAgent, apply as applyGate, ADDENDUM } from '../../harness/rulith-gate.mjs';
import { forDeployment } from '../../harness/web-tools.mjs';
import { parseArgs, dshArgv, Budget, CAPS, startRole } from '../../harness/rulith-dsh-role.mjs';
import { awaitOutcome } from '../../harness/web/rulith-runtime.mjs';
import { sleep } from '../../harness/host-utils.mjs';
import { workerInventory } from '../../harness/worker-inventory.mjs';
import { generalKit, kitReady, KIT_SKIP } from '../../harness/runtime-kit.mjs';

const scratch=fileURLToPath(new URL('../../.scratch/',import.meta.url)); fs.mkdirSync(scratch,{recursive:true});
const response=(result,id,status=200,extra={})=>new Response(status===202?null:JSON.stringify({jsonrpc:'2.0',id,result}),{status,headers:{'content-type':'application/json','mcp-session-id':'session',...extra}});
test('MCP pins protocol, serializes calls, strips host metadata, and never retries',async()=>{
  const calls=[]; let live=0; let max=0;
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'secret',fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body); calls.push({body,headers:options.headers}); live++; max=Math.max(max,live); await sleep(10); live--;
    if(body.method==='initialize')return response({protocolVersion:PROTOCOL,_meta:{'rulith/v4':{agentId:'agent',focusedGoals:[]}}},body.id);
    if(body.method==='notifications/initialized')return response(undefined,undefined,202);
    return response({content:[{type:'text',text:'authority'}],_meta:{'rulith/v4':{agentId:'agent',focusedGoals:[]}}},body.id);
  }});
  assert.equal(await client.initialize(),'agent');
  const artifact = { artifact: { ref: 'supplied-ref', offset: 0 } };
  const results=await Promise.all([client.call('Get',{}),client.call('Set',{}),client.call('Get',artifact)]);
  assert.equal(max,1); assert.equal(calls[0].body.params.protocolVersion,PROTOCOL);
  assert.equal(calls[2].headers['mcp-protocol-version'],PROTOCOL); assert.equal(calls[2].headers['mcp-session-id'],'session');
  // A Board Get carries no progress token; Set and Artifact Get may be held and carry their own.
  assert.equal(calls[2].body.params._meta,undefined); assert.equal(calls[3].body.params._meta.progressToken,`progress_${calls[3].body.id}`);
  assert.equal(calls[4].body.params.name, 'Get'); assert.deepEqual(calls[4].body.params.arguments, artifact);
  assert.equal(calls[4].body.params._meta.progressToken, `progress_${calls[4].body.id}`);
  assert.ok(results.every(r=>r._meta===undefined));
  for (const retired of ['QueryBoard', 'ApplyBatch', 'ApplyAction', 'ReadArtifact']) await assert.rejects(client.call(retired, {}), /tool refused/);
  await assert.rejects(client.call('shell',{}),/tool refused/); await assert.rejects(client.call('OpenCase',{}),/tool refused/); await assert.rejects(client.call('EndGoal',{}),/tool refused/); assert.equal(calls.length,5);
});
test('connection_replaced permanently closes MCP, including queued calls',async()=>{
  let count=0;
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'do-not-log',fetchImpl:async()=>{count++;return new Response('{"reason":"connection_replaced"}',{status:409});}});
  await assert.rejects(client.initialize(),/^Error: connection_replaced$/);
  await assert.rejects(client.call('Get',{}),/closed/); assert.equal(count,1);
});
test('protocol mismatch fails closed without downgrade',async()=>{
  let count=0;
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'secret',fetchImpl:async(_url,opt)=>{count++;return response({protocolVersion:'2026-07-28',_meta:{'rulith/v4':{agentId:'agent',focusedGoals:[]}}},JSON.parse(opt.body).id);}});
  await assert.rejects(client.initialize(),/handshake refused/); assert.equal(count,1);
});
test('HTTP SSE matching response preserves operations and consumes notifications',async()=>{
  const client=new RulithMcp({url:'https://example.invalid/mcp',token:'secret',fetchImpl:async(_url,opt)=>{
    const req=JSON.parse(opt.body);
    return new Response('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{}})+'\n\n'+'event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:req.id,result:{content:[],operations:[{state:'running'}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await client.call('Get',{}); assert.deepEqual(result.operations,[{state:'running'}]);
});
test('only progress for this call extends its silence deadline, within the host ceiling', async () => {
  const run = async (matching, answerAt, ceilingMs) => {
    let calls = 0;
    const client = new RulithMcp({ url: 'https://example.invalid/mcp', token: 'secret', timeoutMs: 120, ceilingMs,
      fetchImpl: async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body);
        let interval; let answer;
        const body = new ReadableStream({
          start(controller) {
            const send = (value) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
            interval = setInterval(() => send({ jsonrpc: '2.0', method: 'notifications/progress', params: {
              progressToken: matching ? request.params._meta.progressToken : 'someone-else' } }), 30);
            answer = setTimeout(() => { clearInterval(interval); send({ jsonrpc: '2.0', id: request.id, result: { content: [] } }); controller.close(); }, answerAt);
            options.signal.addEventListener('abort', () => { clearInterval(interval); clearTimeout(answer); controller.error(new Error('aborted')); }, { once: true });
          },
          cancel() { clearInterval(interval); clearTimeout(answer); },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      } });
    try {
      const call = client.call('Execute', {});
      if (matching && answerAt < ceilingMs) assert.deepEqual(await call, { content: [] });
      else { await assert.rejects(call, /MCP response unreadable/); await assert.rejects(client.call('Get', {}), /closed/); }
      assert.equal(calls, 1, 'the accepted write is never retried');
    } finally { client.close(); }
  };
  await run(true, 260, 600);
  await run(false, 260, 600);
  await run(true, 600, 240);
});

test('a normal launch refreshes the shipped browser plugin without recreating the profile', t => {
  const dir = fs.mkdtempSync(path.join(scratch, 'launcher-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'dsh-home');
  const profile = path.join(home, 'profiles', 'rulith');
  const client = path.join(profile, 'node_modules', 'rulith-dsh-ui', 'lib', 'client.js');
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, 'old Case UI');
  const own = path.join(profile, 'owner-settings.json'); fs.writeFileSync(own, 'owner choice');
  const bin = path.join(dir, 'dsh.cjs');
  fs.writeFileSync(bin, 'require("node:fs").writeFileSync("launched.json",JSON.stringify(process.argv.slice(2)))');
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ dshBin: bin, dshHome: home, cwd: dir, managerHome: dir, keyFile: path.join(dir, 'key'), runtimeEntry: 'unused', persona: 'unused' }));
  execFileSync(process.execPath, [fileURLToPath(new URL('../../harness/web/start-deep-rulith.mjs', import.meta.url)), settings, '--no-open'], { stdio: 'pipe' });
  assert.equal(fs.readFileSync(client, 'utf8'), fs.readFileSync(new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url), 'utf8'));
  assert.equal(fs.readFileSync(own, 'utf8'), 'owner choice');
  const argv = JSON.parse(fs.readFileSync(path.join(dir, 'launched.json')));
  assert.ok(argv.includes('--no-open'));
  assert.ok(!argv.includes('--from-default-profile'));
});

test('held outcomes follow the main operation identity and ignore historical seats', async () => {
  const answer = (operations) => ({ content: [{ type: 'text', text: JSON.stringify({ operations }) }] });
  const own = { tool: 'Execute', label: 'work', at: 'one', state: 'running' };
  const historical = { ...own, seat: 'retired', state: 'running' };
  const initial = answer([historical, own]);
  const intermediate = answer([{ ...historical, state: 'done' }, own]);
  const done = answer([historical, { ...own, state: 'done' }]);
  let reads = 0;
  assert.equal(await awaitOutcome({ call: async () => ++reads === 1 ? intermediate : done }, 'Execute', initial, { pollMs: 1 }), done);
  assert.equal(reads, 2);
});

test('gate restricts inherited globals through agent context before work',async()=>{
  const calls=[]; const scoped={tools:{get:name=>['web_search','web_fetch','write','edit'].includes(name)?{}:undefined,restrict:filter=>{calls.push(filter);return ()=>{};}}};
  restrictAgent({ctx:scoped}); assert.deepEqual(calls[0].allow,[...TOOLS,'web_search','web_fetch']);
  const dir=fs.mkdtempSync(path.join(scratch,'persona-')); const persona=path.join(dir,'persona.txt'); fs.writeFileSync(persona,'approved');
  const previous=process.env.RULITH_DSH_PERSONA; process.env.RULITH_DSH_PERSONA=persona;
  const handlers = new Map(); let section;
  try { await applyGate({systemPrompt:{section:value=>{section=value;}},on:(type,cb)=>{handlers.set(type,cb);},provide:(key,value)=>{assert.equal(key,'rulithGate');assert.equal(value,true);}}); handlers.get('agent/created')({agent:{ctx:scoped}}); assert.equal(handlers.get('agent/pre-step'), undefined); assert.equal(typeof handlers.get('tools/execute'),'function','the web_fetch guard'); assert.equal(section.complete,true); assert.equal(section.interpolate,false); assert.equal(section.text,`approved\n\n${forDeployment(ADDENDUM)}`); }
  finally { if(previous===undefined)delete process.env.RULITH_DSH_PERSONA;else process.env.RULITH_DSH_PERSONA=previous; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('headless disables every sub-agent plugin',()=>{
  const overlay=fs.readFileSync(new URL('../../harness/rulith.cordis.yml',import.meta.url),'utf8');
  const entries=[...overlay.matchAll(/^- id: ([^\r\n]*subagent[^\r\n]*)\r?\n([^]*?)(?=^- id: |$(?![^]))/gm)];
  assert.equal(entries.length,7);for(const entry of entries){assert.equal(entry[2].trim(),'disabled: true');}
});
test('IPC plugin publishes exactly the three v4 global tools with proper dsh schemas and renderer',async()=>{
  const previousProxy=process.env.RULITH_DSH_PROXY; const previousSend=process.send;
  process.env.RULITH_DSH_PROXY='ipc';
  const definitions=[];const effects=[];let published;
  process.send=message=>{
    const result=message.method==='identity'?'agent':message.method==='list'?{tools:TOOLS.map(name=>({name,description:'authority',inputSchema:{type:'object'}}))}:{content:[{type:'text',text:'authority result'}]};
    queueMicrotask(()=>process.emit('message',{protocol:'rulith-dsh-rpc',id:message.id,result}));
  };
  try {
    await applyBridge({effect:effect=>effects.push(effect()),tools:{register:definition=>{definitions.push(definition);return()=>{};}},provide:(key,value)=>{assert.equal(key,'rulithBridge');published=value;}});
    assert.deepEqual(definitions.map(d=>d.name),[...TOOLS]);assert.ok(definitions.every(d=>d.parameters.type==='object'&&d.input===undefined));
    const result=await definitions[0].execute({});assert.equal(result.content[0].text,'authority result');assert.equal(definitions[0].output.render({},result)[0].text,JSON.stringify(result));
    assert.ok(published);assert.equal(published.shadow,undefined);
    const abort=new AbortController();let received;
    published.call=async(_tool,_args,options)=>{received=options.signal;return result;};
    await definitions[1].execute({operations:[]},{signal:abort.signal});assert.equal(received,abort.signal);
  } finally {
    for(const dispose of effects.reverse())dispose();process.send=previousSend;
    if(previousProxy===undefined)delete process.env.RULITH_DSH_PROXY;else process.env.RULITH_DSH_PROXY=previousProxy;
  }
});
test('wrapper removes appended serve and sends only headless argv',()=>{
  const absolute=fileURLToPath(new URL('../../',import.meta.url));
  const options=parseArgs(['--dsh-entry',path.join(absolute,'dsh.js'),'--dsh-home',path.join(absolute,'home'),'--cwd',path.join(absolute,'cwd'),'--persona',path.join(absolute,'persona'),'--task','--serve','--serve']);
  assert.equal(options.task,'--serve'); const argv=dshArgv(options,'--serve','sess');
  assert.ok(!argv.includes('--serve')); assert.ok(argv.includes('--json')); assert.deepEqual(argv.slice(-2),['--session-id','sess']);
  assert.throws(()=>parseArgs(['--web']),/refused/); assert.throws(()=>parseArgs(['--serve']),/paths required/);
});
test('wrapper cap boundaries, aggregate prompt tokens and unknown usage',()=>{
  assert.deepEqual(CAPS,{steps:150,wallMs:5400000,promptTokens:25000000});
  let now=0; const cap=new Budget({steps:2,wallMs:100,promptTokens:10},()=>now);
  assert.equal(cap.event({type:'status',phase:'step_start'}),null);
  assert.equal(cap.event({type:'status',phase:'step_end',usage:{inputTokens:4}}),null);
  assert.equal(cap.event({type:'status',phase:'step_start'}),null);
  assert.equal(cap.event({type:'status',phase:'step_end',usage:{inputTokens:6}}),'prompt token cap');
  now=100; assert.equal(cap.event({}),'wall time cap');
  const missing=new Budget(); assert.equal(missing.event({type:'status',phase:'step_end'}),'prompt usage missing');
  const steps=new Budget({steps:1,wallMs:10000,promptTokens:100}); steps.event({type:'status',phase:'step_start'}); assert.equal(steps.event({type:'status',phase:'step_end',usage:{inputTokens:1}}),'step cap');
  const cached=new Budget({steps:150,wallMs:10000,promptTokens:100});assert.equal(cached.event({type:'status',phase:'step_end',usage:{inputTokens:1,cacheReadTokens:99}}),'prompt token cap');
  const retries=new Budget({steps:150,wallMs:10000,promptTokens:100});assert.equal(retries.event({type:'status',phase:'step_end',usage:{inputTokens:1,outputTokens:5,totalTokens:105}}),'prompt token cap');
});
function fakeFixture(t,source) {
  const dir=fs.mkdtempSync(path.join(scratch,'dsh-test-')); const home=path.join(dir,'home'); const cwd=path.join(dir,'cwd'); fs.mkdirSync(home);fs.mkdirSync(cwd);
  const entry=path.join(dir,'fake-dsh.mjs');const persona=path.join(dir,'persona.txt');fs.writeFileSync(entry,source);fs.writeFileSync(persona,'approved');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,home,cwd,options:{'dsh-entry':entry,'dsh-home':home,cwd,persona},env:{...process.env,RULITH_SERVE_PORT:'0',RULITH_SERVE_KEY:'private-test-key',RULITH_MODEL:'test-model',RULITH_MODEL_URL:'http://127.0.0.1:9/v1'},client:{initialize:async()=> 'agent',list:async()=>({tools:TOOLS.map(name=>({name}))}),call:async()=>({}),close(){} }};
}
test('fake dsh receives isolated cwd/home, disabled telemetry, task stdin and resumed session',async t=>{
  const f=fakeFixture(t,"import fs from 'node:fs'; let task=''; for await(const b of process.stdin)task+=b; fs.writeFileSync('invocation.json',JSON.stringify({argv:process.argv.slice(2),task,cwd:process.cwd(),home:process.env.DSH_HOME,telemetry:process.env.DSH_TELEMETRY_MODE,token:process.env.RULITH_TOKEN})); console.log(JSON.stringify({type:'session',sessionId:'persisted'})); console.log(JSON.stringify({type:'status',phase:'step_start'})); console.log(JSON.stringify({type:'status',phase:'step_end',usage:{inputTokens:3}})); process.disconnect();");
  const trace=[]; const role=await startRole(f.options,{client:f.client,env:f.env,emit:(type,data)=>trace.push({type,...data})}); t.after(()=>role.stop());
  assert.equal(trace[0].agentId,'agent'); await role.run('task --serve','conversation'); await role.run('followup','conversation');
  const invocation=JSON.parse(fs.readFileSync(path.join(f.cwd,'invocation.json'))); assert.equal(invocation.task,'followup');assert.equal(invocation.home,f.home);assert.equal(invocation.cwd,f.cwd);assert.equal(invocation.telemetry,'DISABLED');assert.equal(invocation.token,undefined);assert.ok(invocation.argv.includes('--session-id'));assert.equal(role.sessions.get('conversation').budget.promptTokens,6);
  await role.stop();
});
// D-1015c: the headless role passes DeepSeek's key for web_search only when the model is DeepSeek's own API.
test('headless role passes a web search key only for a DeepSeek model',async t=>{
  for(const [url,want] of [['https://api.deepseek.com/v1','test-search-key'],['http://127.0.0.1:9/v1',null]]){
    const f=fakeFixture(t,"import fs from 'node:fs'; for await(const b of process.stdin){} fs.writeFileSync('search-key.json',JSON.stringify(process.env.RULITH_DSH_WEB_SEARCH_KEY ?? null)); console.log(JSON.stringify({type:'session',sessionId:'s'})); process.disconnect();");
    const role=await startRole(f.options,{client:f.client,env:{...f.env,RULITH_MODEL_URL:url,RULITH_MODEL_KEY:'test-search-key',RULITH_DSH_WEB_SEARCH_KEY:'inherited'},emit(){}}); t.after(()=>role.stop());
    await role.run('task','one'); await role.stop();
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.cwd,'search-key.json'),'utf8')),want,url);
  }
});
test('fake dsh is killed at caps and the session cannot resume',async t=>{
  const f=fakeFixture(t,"for await(const b of process.stdin){} console.log(JSON.stringify({type:'status',phase:'step_start'})); console.log(JSON.stringify({type:'status',phase:'step_end',usage:{inputTokens:100}})); setInterval(()=>{},1000)");
  const role=await startRole(f.options,{client:f.client,env:f.env,caps:{steps:150,wallMs:5000,promptTokens:100},emit(){},terminate:async pid=>{try{process.kill(pid);}catch{}}}); t.after(()=>role.stop());
  await role.run('task','same'); await assert.rejects(role.run('followup','same'),/token cap/); await role.stop();
});
test('manager request IDs are deduplicated and caps persist across role restarts',async t=>{
  const f=fakeFixture(t,"for await(const b of process.stdin){} console.log(JSON.stringify({type:'session',sessionId:'saved'})); console.log(JSON.stringify({type:'status',phase:'step_start'})); console.log(JSON.stringify({type:'status',phase:'step_end',usage:{inputTokens:2}})); setTimeout(()=>process.disconnect(),50)");
  let role=await startRole(f.options,{client:f.client,env:f.env,emit(){}});t.after(()=>role.stop());
  const port=role.server.address().port;
  const send=body=>fetch(`http://127.0.0.1:${port}/task`,{method:'POST',headers:{'content-type':'application/json','x-rulith-serve':'private-test-key'},body:JSON.stringify(body)});
  const request={text:'manager task',sessionKey:'same',requestId:'test-request-id-1234'};
  const first=await send(request);assert.equal(first.status,202);const receipt=await first.json();
  const again=await send(request);assert.equal(again.status,202);assert.deepEqual(await again.json(),receipt);
  const changed=await send({...request,text:'different'});assert.equal(changed.status,409);
  for(let i=0;i<30&&!role.sessions.get('same')?.id;i++)await sleep(25);
  await sleep(150);await role.stop();
  role=await startRole(f.options,{client:f.client,env:f.env,emit(){}});assert.equal(role.sessions.get('same').id,'saved');assert.equal(role.sessions.get('same').budget.promptTokens,2);await role.stop();
});
test('IPC stop terminates active dsh and reload drains the current task',async t=>{
  const f=fakeFixture(t,"for await(const b of process.stdin){} setInterval(()=>{},1000)");
  const role=await startRole(f.options,{client:f.client,env:f.env,emit(){},terminate:async pid=>{try{process.kill(pid);}catch{}}}); t.after(()=>role.stop());
  const running=role.run('task'); await sleep(150); await role.control({protocol:'wrong',operation:'stop'});assert.equal(role.server.listening,true);
  await role.control({protocol:'rulith-local-control',operation:'reload'});assert.equal(role.server.listening,true);
  await role.control({protocol:'rulith-local-control',operation:'stop'}); await running; assert.equal(role.server.listening,false);
});
test('overlay disabled ids exist in pinned dsh base sources; runner depends on gate',{skip:!process.env.DSH_REFERENCE_DIR&&!process.env.DSH_BASE_FILE&&'set DSH_REFERENCE_DIR or DSH_BASE_FILE to the pinned dsh base'},()=>{
  const source=process.env.DSH_REFERENCE_DIR;
  const base=fs.readFileSync(process.env.DSH_BASE_FILE ?? path.join(source,'packages/bundle/base/cordis.patch.yml'),'utf8');
  const overlay=fs.readFileSync(new URL('../../harness/rulith.cordis.yml',import.meta.url),'utf8');
  const ids=[...overlay.matchAll(/^- id: ([^\r\n]+)\r?\n  disabled: true/gm)].map(m=>m[1]); assert.ok(ids.length>=45);
  for(const id of ids) assert.match(base,new RegExp(`^    - id: ${id}$`,'m'),id);
  assert.equal(new Set(ids).size,ids.length);assert.match(overlay,/inject: \[headlessStartup, rulithGate\]/);assert.match(overlay,/compression: none/);assert.match(overlay,/maxParallelToolCalls: 1/);
});
test('model-visible inventory contains every manifest id, primary predicate and fixed verdict',{skip:!kitReady()&&KIT_SKIP},()=>{
  const inventory=fs.readFileSync(new URL('../../harness/model-visible.md',import.meta.url),'utf8');
  const manifest=JSON.parse(fs.readFileSync(path.join(generalKit(), 'worker-tools.json')));
  for(const [id,tool]of Object.entries(manifest.tools)){assert.ok(inventory.includes(id));for(const mapping of tool.returns)assert.ok(inventory.includes(mapping.predicate));}
  assert.ok(inventory.includes(workerInventory()), 'generated ids, predicate mappings and fixed verdicts stay current');
  assert.ok(inventory.includes(ADDENDUM));
});
