import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conversationFile, openConversations, readConversations, conversationPage, conversationList } from '../agent/conversation-store.mjs'
import { createConversationReader } from '../agent/conversation-reader.mjs'
import { createLocalHost, defaultLocalConfig } from '../local/rulith-local.mjs'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
const owner = { origin: 'https://console.example.test', accountId: 'a', agentId: 'agent' }
const fixture = t => { const dir = mkdtempSync(join(tmpdir(), 'conversation-library-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const turn = (n, sessionKey = 'chat') => ({ id: `t-${n}`, sessionKey, text: `message ${n}`, attachments: [], at: n })

test('archive is reversible, blocks new execution and retains request deduplication', async t => {
  const dir = fixture(t), store = await openConversations(dir, owner); t.after(() => store.close())
  store.accept(turn(1), { ok: true, id: 't-1' }, 'request-0000000001', 'same')
  assert.throws(() => store.archive('chat', true), /running|queued/)
  store.finish('t-1', 'done', 'complete'); store.archive('chat', true)
  assert.throws(() => store.accept(turn(2), { ok: true }, '', ''), /archived/)
  assert.equal(store.find('request-0000000001', 'same').duplicate, true)
  const data = readConversations(store.file, owner)
  assert.equal(conversationList(data).items.length, 0)
  assert.equal(conversationList(data, { archived: true }).items[0].sessionKey, 'chat')
  assert.equal(conversationPage(data, 'chat').turns[0].text, 'message 1')
  store.archive('chat', false); store.accept(turn(2), { ok: true }, '', '')
  assert.equal(conversationList(store.snapshot()).items[0].turnCount, 2)
})

test('updates write one turn, pages are stable and another writer cannot open the same owner', async t => {
  const dir = fixture(t), store = await openConversations(dir, owner); t.after(() => store.close())
  for (let n = 1; n <= 7; n++) { store.accept(turn(n), { ok: true }, '', ''); store.finish(`t-${n}`, 'done', 'complete') }
  await assert.rejects(openConversations(dir, owner), /another|running|lock/i)
  const folder = store.file + '.d', files = readdirSync(folder).filter(n => n.endsWith('.turn.json'))
  const before = new Map(files.map(n => [n, readFileSync(join(folder,n),'utf8')]))
  store.reply('t-7', 'Only this turn changes')
  assert.equal(files.filter(n => before.get(n) !== readFileSync(join(folder,n),'utf8')).length, 1)
  const last = conversationPage(store.snapshot(), 'chat', { limit: 3 })
  assert.deepEqual(last.turns.map(t => t.id), ['t-5','t-6','t-7'])
  assert.deepEqual(conversationPage(store.snapshot(), 'chat', { before: last.before, limit: 3 }).turns.map(t => t.id), ['t-2','t-3','t-4'])
})

test('legacy migration keeps original bytes and does not turn historical Case links into live focus', async t => {
  const dir = fixture(t), file = conversationFile(dir, owner)
  const legacy = JSON.stringify({ format: 'rulith-conversations/1', owner, turns: [{...turn(1), state:'finished', replies:[], receipt:{ok:true}, requestId:'request-legacy-0001',fingerprint:'x'}] })
  writeFileSync(file, legacy)
  const store = await openConversations(dir, owner); t.after(() => store.close())
  store.finish('t-1','done','complete',{ caseIds:['case-1'], modelService:'https://model.example.test/' })
  assert.equal(readFileSync(file,'utf8'), legacy)
  const saved = conversationPage(store.snapshot(), 'chat').turns[0]
  assert.deepEqual(saved.caseIds,['case-1'])
  assert.equal(saved.activeCaseId,undefined)
})

test('duplicate legacy identities are rejected before migration can discard any record', async t => {
  for (const duplicate of ['id', 'requestId']) {
    const dir = fixture(t), file = conversationFile(dir, owner)
    const first = {...turn(1), state:'finished', replies:[], requestId:'original-request'}
    const second = {...first, ...turn(2), requestId:'second-request', [duplicate]:first[duplicate]}
    const original = JSON.stringify({format:'rulith-conversations/1',owner,turns:[first,second]})
    writeFileSync(file,original)
    await assert.rejects(openConversations(dir,owner),/duplicate legacy/)
    assert.equal(readFileSync(file,'utf8'),original)
    assert.equal(existsSync(join(file+'.d','_complete.json')),false)
  }
})

test('an unexpected partial migration refuses completion and preserves the source', async t => {
  const dir=fixture(t),file=conversationFile(dir,owner)
  const original=JSON.stringify({format:'rulith-conversations/1',owner,turns:[]})
  writeFileSync(file,original);mkdirSync(file+'.d')
  writeFileSync(join(file+'.d','unexpected.turn.json'),'preserve this partial record')
  const store=await openConversations(dir,owner);t.after(()=>store.close())
  assert.throws(()=>store.accept(turn(1),{ok:true},'',''),/unexpected record/)
  assert.equal(existsSync(join(file+'.d','_complete.json')),false)
  assert.equal(readFileSync(file,'utf8'),original)
})

test('usage diagnostics do not write independently and survive the next successful reply',async t=>{
  const dir=fixture(t),store=await openConversations(dir,owner);t.after(()=>store.close())
  store.accept(turn(1),{ok:true},'','')
  const file=join(store.file+'.d',readdirSync(store.file+'.d').find(n=>n.endsWith('.turn.json')))
  const before=readFileSync(file,'utf8')
  store.usage('t-1',{durationMs:125,inputTokens:10,outputTokens:null})
  assert.equal(readFileSync(file,'utf8'),before)
  store.reply('t-1','completed response')
  const saved=JSON.parse(readFileSync(file,'utf8'))
  assert.equal(saved.replies[0].text,'completed response')
  assert.equal(saved.usage.unknownUsageCalls,1);assert.equal(saved.usage.inputTokens,10)
})

test('stopped archiving only interrupts its selected session; the reader sees later atomic updates',async t=>{
  const dir=fixture(t),first=await openConversations(dir,owner)
  first.accept(turn(1,'one'),{ok:true},'','');first.accept(turn(2,'two'),{ok:true},'','');first.close()
  const store=await openConversations(dir,owner,{recoverInterrupted:false});t.after(()=>store.close())
  const reader=createConversationReader(store.file,owner);t.after(()=>reader.close())
  assert.equal((await reader.read({kind:'list'})).total,2)
  store.archive('one',true,{stopped:true})
  assert.equal(store.snapshot().turns.find(t=>t.sessionKey==='two').state,'queued')
  assert.equal((await reader.read({kind:'list'})).total,1)
  assert.equal((await reader.read({kind:'list',archived:true})).items[0].sessionKey,'one')
  store.reply('t-2','new text after the reader cached metadata')
  const page=await reader.read({kind:'page',sessionKey:'two',stopped:true})
  assert.ok(page.events.some(e=>e.say==='new text after the reader cached metadata'))
  assert.equal((await reader.read({kind:'list'})).items[0].text,undefined)
  const record=readConversations(store.file,owner,{metadataOnly:true}).turns.find(t=>t.id==='t-2')._file
  const before=statSync(record),text=readFileSync(record,'utf8')
  writeFileSync(record+'.replacement',text.replace('message 2','message 9'))
  utimesSync(record+'.replacement',before.atime,before.mtime);renameSync(record+'.replacement',record)
  assert.equal(statSync(record).size,before.size)
  assert.equal((await reader.read({kind:'list'})).items[0].title,'message 9')
})

test('legacy SSE replay discloses older omitted turns and a closed reader fails visibly',async t=>{
  const dir=fixture(t),store=await openConversations(dir,owner);t.after(()=>store.close())
  for(let n=0;n<35;n++){store.accept(turn(n),{ok:true},'','');store.finish('t-'+n,'done','complete')}
  const reader=createConversationReader(store.file,owner);t.after(()=>reader.close())
  const events=await reader.read({kind:'recent'})
  assert.equal(events.find(e=>e.type==='loss').omitted,5)
  assert.equal(events.filter(e=>e.type==='task-start').length,30)
  await reader.close();assert.equal(reader.failed,true)
  await assert.rejects(reader.read({kind:'list'}),/closed|stopped/)
})

test('an archive upload holds the host operation lock before its body completes',async t=>{
  const dir=fixture(t),store=await openConversations(join(dir,'conversations'),owner)
  store.accept(turn(1),{ok:true},'','');store.finish('t-1','done','complete');store.close()
  const host=createLocalHost({configFile:join(dir,'local.json'),config:defaultLocalConfig(),roles:['agent'],port:0,key:'archive-test',autoStart:false,conversationOwner:owner})
  await host.listen();t.after(()=>host.close())
  const base=`http://127.0.0.1:${host.port}`
  const body=JSON.stringify({sessionKey:'chat',archived:true})
  let finish
  const completed=new Promise(resolve=>{finish=resolve})
  const slow=request(base+'/conversation/archive?k=archive-test',{method:'POST',headers:{'x-rulith-local':'archive-test','content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>finish(res.statusCode))})
  t.after(()=>slow.destroy());slow.write(body.slice(0,1))
  await delay(30)
  const competing=await fetch(base+'/conversation/archive?k=archive-test',{method:'POST',headers:{'x-rulith-local':'archive-test','content-type':'application/json'},body})
  assert.equal(competing.status,409)
  assert.match((await competing.json()).teaching,/another archive/)
  slow.end(body.slice(1));assert.equal(await completed,200)
  assert.equal((await fetch(base+'/conversations?k=wrong')).status,401)
  const badOrigin=await fetch(base+'/conversation/archive?k=archive-test',{method:'POST',headers:{'x-rulith-local':'archive-test',origin:'https://other.test'},body})
  assert.equal(badOrigin.status,403)
})
