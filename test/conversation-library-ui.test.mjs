import test from 'node:test'
import assert from 'node:assert/strict'
import { localPage } from '../local/local-ui.mjs'
import { deferred, loadLocalPage } from './support/local-dom.mjs'

const message = (text='Remember blue',type='task-start') => ({src:'agent',type,session:'chat',task:'t-1',id:'t-1',text,t:1,historyKey:'t-1:user',historical:true})
async function library() {
  const control={archived:false,before:'t-old',posts:[],history:undefined}
  const page=await loadLocalPage(localPage,{respond:async(path,request)=>{
    const route=path.split('?')[0]
    if(route==='/conversations')return {body:{ok:true,available:true,items:new URL('http://local'+path).searchParams.get('archived')===String(control.archived)?[{sessionKey:'chat',title:'Remember blue',state:'finished',archived:control.archived}]:[],total:1,hasMore:false}}
    if(route==='/conversation')return control.history?control.history():{body:{ok:true,available:true,archived:control.archived,before:control.before,events:[message()],modelServices:[]}}
    if(route==='/conversation/archive'){control.archived=request.body.archived;control.posts.push(request);return {body:{ok:true,archived:control.archived}}}
    if(route==='/cases'){control.posts.push(request);return {body:{ok:true,sessionKey:'chat'}}}
  }})
  return Object.assign(page,{control})
}

test('page selects saved history, archives without sending a task and restores before new messages',async()=>{
  const page=await library()
  await page.click(page.find('[data-case="chat"]'))
  assert.match(page.$('stream').textContent,/Remember blue/)
  await page.click('archivehistory')
  assert.equal(page.control.archived,true)
  assert.match(page.$('historystate').textContent,/Archived/)
  await page.type('must not send');await page.submit()
  assert.equal(page.control.posts.filter(x=>x.body.text).length,0)
  await page.click('historyarchived');await page.click(page.find('[data-case="chat"]'))
  assert.equal(page.$('archivehistory').textContent,'Restore conversation')
  await page.click('archivehistory');await page.submit()
  assert.equal(page.control.posts.filter(x=>x.body.text).length,1)
})

test('All activity retains a working restore control for its archived composer target',async()=>{
  const page=await library()
  await page.click(page.find('[data-case="chat"]'));await page.click('archivehistory')
  await page.click(page.find('[data-case=""]'))
  assert.equal(page.$('historybar').hidden,false)
  assert.equal(page.$('archivehistory').textContent,'Restore conversation')
  await page.type('after restoring');await page.submit()
  assert.equal(page.control.posts.filter(x=>x.body.text).length,0)
  await page.click('archivehistory');assert.equal(page.control.archived,false)
  await page.submit();assert.equal(page.control.posts.filter(x=>x.body.text).length,1)
})

test('switching away ignores delayed history and an older page cannot overwrite a live reply',async()=>{
  const page=await library(),hold=deferred()
  page.control.history=()=>hold.promise
  await page.click(page.find('[data-case="chat"]'));await page.click('newcase')
  hold.resolve({body:{ok:true,available:true,events:[message('late old text')],modelServices:[]}});await page.flush()
  assert.doesNotMatch(page.$('stream').textContent,/late old text/)
  page.control.history=undefined;await page.click(page.find('[data-case="chat"]'))
  await page.emit({...message('live text'),historical:false})
  await page.click('loadolder')
  assert.match(page.$('stream').textContent,/live text/)
  assert.doesNotMatch(page.$('stream').textContent,/Remember blue/)
})

test('interrupted duplicate requires an explicit new-send click; model consent keeps original request id',async()=>{
  let sent=[]
  const page=await loadLocalPage(localPage,{respond:async(path,r)=>{
    if(!path.startsWith('/cases'))return
    sent.push(r.body)
    if(sent.length===1)return {body:{ok:false,state:'interrupted',teaching:'Interrupted; check its Case.'}}
    return {body:{ok:true,sessionKey:'chat'}}
  }})
  await page.type('same message');await page.submit()
  assert.equal(sent.length,1);assert.equal(page.$('newattempt').hidden,false)
  await page.click('newattempt')
  assert.equal(sent.length,2);assert.notEqual(sent[0].requestId,sent[1].requestId)
  sent=[]
  const consent=await loadLocalPage(localPage,{respond:async(path,r)=>{
    if(!path.startsWith('/cases'))return
    sent.push({...r.body})
    return {body:sent.length===1?{ok:false,state:'model-confirmation',modelService:'https://next.example/model',teaching:'Confirm destination.'}:{ok:true,sessionKey:'chat'}}
  }})
  await consent.type('same context');await consent.submit();await consent.click('historyconsent');await consent.submit()
  assert.equal(sent[0].requestId,sent[1].requestId)
  assert.equal(sent[1].historyModelDestination,'https://next.example/model')
})

test('unbound history gives an explanation instead of a permanent loading message',async()=>{
  const page=await loadLocalPage(localPage,{respond:async path=>path.startsWith('/conversations')?{body:{ok:true,available:false,items:[]}}:undefined})
  await page.click('historyactive')
  assert.match(page.$('historynotice').textContent,/after connecting an account and Agent/)
  assert.doesNotMatch(page.$('historynotice').textContent,/Loading/)
})
