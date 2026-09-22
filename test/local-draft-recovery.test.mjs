import test from 'node:test'
import assert from 'node:assert/strict'
import { localPage } from '../local/local-ui.mjs'
import { deferred, fileOf, loadLocalPage } from './support/local-dom.mjs'

async function setup(respond) {
  const page=await loadLocalPage(localPage,{respond})
  await page.emit({src:'agent',type:'task-start',session:'alpha',text:'Alpha conversation',id:'a'})
  await page.emit({src:'agent',type:'task-start',session:'beta',text:'Beta conversation',id:'b'})
  return page
}
const choose=(p,key)=>p.click(p.find('[data-case="'+key+'"]'))

test('text and advanced fields stay with their conversation when switching drafts',async()=>{
  const page=await setup()
  await choose(page,'alpha');await page.type('private alpha draft')
  page.$('casetype').value='alpha_type';page.$('businesskey').value='{"order":"alpha"}'
  await choose(page,'beta')
  assert.equal(page.$('prompt').value,'')
  assert.equal(page.$('casetype').value,'');assert.equal(page.$('businesskey').value,'')
  await page.type('beta draft');await choose(page,'alpha')
  assert.equal(page.$('prompt').value,'private alpha draft')
  assert.equal(page.$('casetype').value,'alpha_type');assert.equal(page.$('businesskey').value,'{"order":"alpha"}')
})

test('an unsent new conversation remains selectable and late acceptance clears only the submitted text',async()=>{
  const hold=deferred(),page=await setup((path)=>path.startsWith('/cases')?hold.promise:undefined)
  await page.click('newcase');await page.type('unsent new draft')
  await choose(page,'alpha');assert.equal(page.$('prompt').value,'')
  const draft=page.find('[data-draft]');assert.ok(draft,'unsent draft is reachable')
  await page.click(draft);assert.equal(page.$('prompt').value,'unsent new draft')
  await page.submit();await choose(page,'beta');await page.type('beta next message')
  hold.resolve({body:{ok:true,sessionKey:'new-accepted'}});await page.flush()
  assert.equal(page.$('prompt').value,'beta next message')
  await page.emit({src:'agent',type:'task-start',session:'new-accepted',text:'unsent new draft',id:'new-turn'})
  await choose(page,'new-accepted');assert.equal(page.$('prompt').value,'')
})

test('a failed addition can be explicitly retried without sending a conversation',async()=>{
  let adds=0
  const page=await setup(path=>path.startsWith('/materials')?++adds===1?{body:{ok:false,teaching:'Temporary write failure'}}:{body:{ok:true,material:{id:'mat-retried'}}}:undefined)
  await page.choose([fileOf('retry.txt')])
  const retry=page.all('button').find(b=>b.getAttribute('aria-label')==='Add retry.txt again');assert.ok(retry)
  await page.click(retry)
  assert.equal(adds,2);assert.equal(page.chips()[0].said,'Ready')
  assert.equal(page.calls.filter(c=>c.path.startsWith('/cases')).length,0)
})

test('retry retains the original destination and removed rows do not reappear after a late reply',async()=>{
  const hold=deferred();let adds=0
  const page=await setup(path=>path.startsWith('/materials')?++adds===1?{body:{ok:false}}:hold.promise:undefined)
  await choose(page,'alpha');await page.choose([fileOf('original.txt')])
  const original=page.calls.find(c=>c.path.startsWith('/materials')).body.modelDestination
  page.state.status.runtime.agent.modelService='https://different.example/v1'
  await page.click(page.all('button').find(b=>b.getAttribute('aria-label')==='Add original.txt again'))
  assert.equal(page.calls.filter(c=>c.path.startsWith('/materials'))[1].body.modelDestination,original)
  await page.click(page.chips()[0].remove)
  await choose(page,'beta');await page.type('beta remains')
  hold.resolve({body:{ok:true,material:{id:'mat-late'}}});await page.flush()
  assert.equal(page.$('prompt').value,'beta remains');assert.equal(page.chips().length,0)
  await choose(page,'alpha');assert.equal(page.chips().length,0)
})

test('export downloads only the selected loaded events and never unsent text',async()=>{
  const page=await setup();await choose(page,'alpha');await page.type('never exported draft')
  await page.click('exportlog');assert.equal(page.downloads.length,1)
  const data=JSON.parse(await page.downloads[0].blob.text())
  assert.equal(data.scope.conversationId,'alpha');assert.equal(data.coverage.completeHistory,false)
  assert.equal(data.events.length,1);assert.equal(data.events[0].session,'alpha')
  assert.equal('activeCase' in data,false);assert.ok(!JSON.stringify(data).includes('never exported draft'))
  await page.click('newcase');await page.click('exportlog')
  assert.deepEqual(JSON.parse(await page.downloads[1].blob.text()).events,[])
  assert.equal(JSON.parse(await page.downloads[1].blob.text()).coverage.earlierMessagesAvailable,null)
  await page.click('convopen');await page.click('exportviewmobile')
  assert.equal(page.$('convmodal').hidden,true);assert.equal(page.downloads.length,3)
})

test('All activity identifies the retained composer destination',async()=>{
  const page=await setup();await choose(page,'alpha');await page.type('alpha draft')
  await choose(page,'')
  assert.equal(page.$('composertarget').hidden,false)
  assert.match(page.$('composertarget').textContent,/Alpha conversation/)
  assert.equal(page.$('prompt').value,'alpha draft')
})

test('an unobserved model destination cannot add a file and a changed destination has no futile retry',async()=>{
  const page=await setup(path=>path.startsWith('/materials')?{body:{ok:false,errorCode:'material_destination_changed',teaching:'Remove and add again'}}:undefined)
  const status=page.state.status;page.state.status=null
  await page.choose([fileOf('before-status.txt')])
  assert.equal(page.calls.filter(c=>c.path.startsWith('/materials')).length,0)
  assert.match(page.$('composererr').textContent,/settings are not available/)
  page.state.status=status;await page.choose([fileOf('stale.txt')])
  assert.equal(page.chips().length,1)
  assert.equal(page.all('button').some(b=>b.getAttribute('aria-label')==='Add stale.txt again'),false)
})

test('a visible accepted session preserves input typed there before its original send returns',async()=>{
  const hold=deferred(),page=await setup(path=>path.startsWith('/cases')?hold.promise:undefined)
  await page.click('newcase');await page.type('initial message');await page.submit()
  const session=page.calls.find(c=>c.path.startsWith('/cases')).body.sessionKey
  await page.emit({src:'agent',type:'task-start',session,text:'initial message',id:'new-turn'})
  await choose(page,session);await page.type('typed before acknowledgement')
  page.$('casetype').value='next_type';page.$('businesskey').value='{"next":true}'
  await choose(page,'alpha') // saves all input fields of the already-visible session
  hold.resolve({body:{ok:true,sessionKey:session}});await page.flush()
  await choose(page,session)
  assert.equal(page.$('prompt').value,'typed before acknowledgement')
  assert.equal(page.$('casetype').value,'next_type');assert.equal(page.$('businesskey').value,'{"next":true}')
})

test('two independently edited drafts are retained when the send acknowledgement joins their identity',async()=>{
  const hold=deferred(),page=await setup(path=>path.startsWith('/cases')?hold.promise:undefined)
  await page.click('newcase');await page.type('initial');await page.submit();await page.type('next in original draft')
  const session=page.calls.find(c=>c.path.startsWith('/cases')).body.sessionKey
  await page.emit({src:'agent',type:'task-start',session,text:'initial',id:'new-turn'})
  await choose(page,session);await page.type('next in accepted session')
  hold.resolve({body:{ok:true,sessionKey:session}});await page.flush()
  await choose(page,'alpha');await choose(page,session)
  assert.equal(page.$('prompt').value,'next in accepted session')
  await page.click(page.find('[data-draft]'))
  assert.equal(page.$('prompt').value,'next in original draft')
})

test('export notices clear on switching and All activity keeps archived-send refusal',async()=>{
  const page=await setup(path=>path.startsWith('/conversation?')?{body:{ok:true,available:true,archived:true,events:[]}}:undefined)
  await choose(page,'alpha');await page.click('exportlog');assert.equal(page.$('exportnote').hidden,false)
  await choose(page,'');assert.equal(page.$('exportnote').hidden,true)
  await page.type('must not send to archive');await page.submit()
  assert.match(page.$('composererr').textContent,/Restore this archived/)
  assert.equal(page.calls.filter(c=>c.path.startsWith('/cases')).length,0)
})
