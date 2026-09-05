// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import * as ui from '../local/local-ui.mjs'

function activityReducer() {
  const lines = ui.localPage.split('\n')
  const identify = lines.find(line => line.startsWith('const caseOf='))
  const remember = lines.find(line => line.startsWith('function remember('))
  assert.ok(identify && remember, 'the shipped activity reducer must be readable')
  const state = {cases:new Map()}
  const context = vm.createContext({state})
  vm.runInContext(`${identify}\n${remember}`,context)
  return {state,send(event){context.event=event;vm.runInContext('remember(event)',context)}}
}

test('a pending event from one-shot mode never invents a paused Case, even after task-done', () => {
  const page = activityReducer()
  page.send({src:'agent',type:'case-open',session:'conversation',caseId:'case-1',ok:true})
  page.send({src:'agent',type:'case-pending',session:'conversation',caseId:'case-1',note:'Stopped at the round limit.'})
  page.send({src:'agent',type:'task-done',session:'conversation',activeCaseId:'case-1'})
  const row=page.state.cases.get('conversation')
  assert.equal(row.caseId,'case-1')
  assert.equal(row.status,'Waiting')
  assert.notEqual(row.status,'Paused')
})

test('the reducer defensively ignores a rejected case-open display event', () => {
  const page=activityReducer()
  page.send({src:'agent',type:'case-open',session:'conversation',caseId:'rejected-case',ok:false})
  assert.equal(page.state.cases.get('conversation').caseId,'')
})

test('a new message does not reactivate a detached Case in the sidebar', () => {
  const page = activityReducer()
  for (const event of [
    {type:'case-open',caseId:'case-1',ok:true},
    {type:'session-detached',caseId:'case-1'},
    {type:'task-start',text:'hello again'},
    {type:'task-done',activeCaseId:null},
  ]) page.send({src:'agent',session:'conversation',...event})
  assert.equal(page.state.cases.get('conversation').status,'Detached')
})

test('task completion cannot overwrite a lifecycle observation in the sidebar', () => {
  for (const [caseStatus, expected] of [['paused','Case paused'], ['unavailable','Case state unavailable']]) {
    const page = activityReducer()
    page.send({src:'agent',session:'conversation',type:'case-state',caseId:'case-1',caseStatus})
    page.send({src:'agent',session:'conversation',type:'task-done',activeCaseId:'case-1'})
    assert.equal(page.state.cases.get('conversation').status,expected)
  }
})

test('the inspector uses only explicit Agent observations of Case lifecycle', () => {
  const pending={src:'agent',type:'case-pending',session:'conversation',caseId:'case-1'}
  assert.equal(ui.projectCaseState([pending]).lifecycle,'unavailable')
  const open={src:'agent',type:'case-state',caseId:'case-1',caseStatus:'open',certified:false}
  assert.equal(ui.projectCaseState([open,pending]).lifecycle,'open')
  const paused={...open,caseStatus:'paused'}
  assert.equal(ui.projectCaseState([open,pending,paused]).lifecycle,'paused')
  assert.equal(ui.projectCaseState([open,{...paused,src:'worker'}]).lifecycle,'open')
  assert.equal(ui.projectCaseState([open,{...open,caseStatus:'closed',certified:false}]).label,'Closed')
  assert.equal(ui.projectCaseState([{...open,caseStatus:'invented'}]).label,'Unavailable')
  assert.equal(ui.projectCaseState([open,{src:'agent',type:'case-open',caseId:'case-2',ok:true}]).label,'Unavailable')
})

test('the shipped inspector separates lifecycle, acceptance and detached observations', () => {
  const start=ui.localPage.indexOf('function projectCaseState(')
  const end=ui.localPage.indexOf('const K=',start)
  assert.ok(start>=0&&end>start)
  const elements = new Map(['caseid','casestatus','caseacceptance','caseobservation','floor','frontier','workers'].map(id => [id, {textContent:'',innerHTML:''}]))
  const context=vm.createContext({state:{},$:id=>elements.get(id),esc:String,timeOf:()=>'',eventBody:()=>''})
  vm.runInContext(ui.localPage.slice(start,end),context)
  const renderer=ui.localPage.split('\n').find(line=>line.startsWith('function renderInspector('))
  assert.ok(renderer)
  vm.runInContext(renderer,context)
  const actual=vm.runInContext("projectCaseState([{src:'agent',type:'case-pending',caseId:'case-1'}])",context)
  assert.equal(actual.lifecycle,'unavailable')
  context.events=[{src:'agent',type:'case-state',caseId:'case-1',caseStatus:'closed',certified:false}]
  vm.runInContext('renderInspector(events)',context)
  assert.equal(elements.get('casestatus').textContent,'Closed')
  assert.equal(elements.get('caseacceptance').textContent,'Not satisfied','closed is not certification')
  context.events=[{src:'agent',type:'case-state',caseId:'case-1',caseStatus:'open',certified:true},
    {src:'agent',type:'session-detached',caseId:'case-1'}]
  vm.runInContext('renderInspector(events)',context)
  assert.equal(elements.get('casestatus').textContent,'Open','detachment is not a Case transition')
  assert.equal(elements.get('caseacceptance').textContent,'Satisfied')
  assert.equal(elements.get('caseobservation').textContent,'Detached · last observed')
  context.events=[{src:'agent',type:'board',floor:'attested'},
    {src:'agent',type:'case-state',caseId:'case-2',caseStatus:'open'}]
  vm.runInContext('renderInspector(events)',context)
  assert.equal(elements.get('floor').textContent,'—','never mix an old Board view with a new Case observation')
  context.events=[{src:'agent',type:'case-state',caseId:'case-2',caseStatus:'open',certified:true,floor:'attested'}]
  vm.runInContext('renderInspector(events)',context)
  assert.equal(elements.get('floor').textContent,'attested','acceptance and floor share the same snapshot')
})
