// SPDX-License-Identifier: Apache-2.0
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readConversations, conversationList, conversationPage, conversationEvents } from './conversation-store.mjs'

// 冷索引和分页读取不占用Local主线程；热读按原子文件的mtime/size复用元数据，
// 正文仅在选择一页时读取，不把归档正文长期保存在内存或发到浏览器。
export function createConversationReader(file, owner) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { file, owner } })
  const pending = new Map(); let sequence = 0, failed
  worker.unref()
  const fail = error => { failed = error; for (const call of pending.values()) call.reject(error); pending.clear() }
  worker.on('error', fail)
  worker.on('exit', code => fail(new Error(`Conversation reader stopped (${code}). Retry opening Conversations to start a new read-only reader.`)))
  worker.on('message', result => {
    const call = pending.get(result.id); if (!call) return
    pending.delete(result.id)
    if (result.error) call.reject(new Error(result.error)); else call.resolve(result.value)
  })
  return {
    get failed() { return !!failed },
    read(input) { if (failed) return Promise.reject(failed); return new Promise((resolve,reject) => { const id=++sequence; pending.set(id,{resolve,reject}); worker.postMessage({id,...input}) }) },
    close() { fail(new Error('Conversation reader closed.')); return worker.terminate() },
  }
}
if (!isMainThread) {
  const cache = new Map()
  parentPort.on('message', input => {
    try {
      const data = readConversations(workerData.file, workerData.owner, { metadataOnly: true, cache })
      let value
      if (input.kind === 'list') value = conversationList(data,input)
      else if (input.kind === 'page') {
        const page = conversationPage(data,input.sessionKey,input)
        value = { archived:page.archived, before:page.before, modelServices:[...new Set(page.turns.map(t=>t.modelService).filter(Boolean))], events:conversationEvents(page,input.stopped) }
      } else {
        // SSE初次只回放最近30轮；旧对话走分页。退出通知只检查尚未完成的本地轮次。
        const rows = input.kind === 'interrupted' ? data.turns.filter(t=>['queued','running'].includes(t.state))
          : data.turns.filter(t=>!data.archived[t.sessionKey]).sort((a,b)=>a.at-b.at).slice(-30)
        const pages = rows.map(t=>conversationPage({...data,turns:[t]},t.sessionKey,{limit:1}))
        value = pages.flatMap(page=>conversationEvents(page,input.stopped)).filter(e=>input.kind!=='interrupted'||e.type==='task-done')
        const activeCount = data.turns.filter(t=>!data.archived[t.sessionKey]).length
        if (input.kind !== 'interrupted' && activeCount > rows.length) value.unshift({src:'local',type:'loss',omitted:activeCount-rows.length,reason:'recent conversation replay; open Conversations for paged history',historyKey:'local-history:recent-limit',t:0})
      }
      parentPort.postMessage({id:input.id,value})
    } catch(error) { parentPort.postMessage({id:input.id,error:error.message}) }
  })
}
