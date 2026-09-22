// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FORMAT = 'rulith-conversations/1'
const MAX_BYTES = 32 * 1024 * 1024
export class ConversationStoreError extends Error {}

// 身份来自已验证的账号与 Agent，凭据更换不改变历史归属。文件只保存对话投影，
// 不保存 MCP 会话、工具正文、思考过程或可恢复成 Board 权威的状态。
export function conversationFile(directory, owner) {
  if (!directory || !owner?.origin || !owner?.accountId || !owner?.agentId) throw new ConversationStoreError('Conversation history needs a verified account and Agent.')
  const identity = JSON.stringify([new URL(owner.origin).origin, owner.accountId, owner.agentId])
  return join(directory, createHash('sha256').update(identity).digest('hex') + '.json')
}

export function readConversations(file, owner) {
  if (!existsSync(file)) return { format: FORMAT, owner, turns: [] }
  try {
    if (statSync(file).size > MAX_BYTES) throw new Error('file exceeds the history limit')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.format !== FORMAT || JSON.stringify(data.owner) !== JSON.stringify(owner)
      || !Array.isArray(data.turns) || data.turns.length > 1000) throw new Error('invalid format or owner')
    const ids = new Set()
    for (const turn of data.turns) {
      if (!turn || typeof turn.id !== 'string' || ids.has(turn.id) || typeof turn.sessionKey !== 'string'
        || typeof turn.text !== 'string' || !Number.isFinite(turn.at)
        || !['queued', 'running', 'finished', 'interrupted'].includes(turn.state)
        || !Array.isArray(turn.replies) || !turn.replies.every(r => typeof r.text === 'string' && Number.isFinite(r.at))
        || !Array.isArray(turn.attachments)) throw new Error('invalid conversation record')
      ids.add(turn.id)
    }
    return data
  } catch (error) {
    throw new ConversationStoreError(`Conversation history could not be read; the original file was preserved. ${error.message}`)
  }
}

function atomicWrite(file, data) {
  const bytes = JSON.stringify(data)
  if (Buffer.byteLength(bytes) > MAX_BYTES || data.turns.length > 1000) throw new ConversationStoreError('Conversation history is full. Stop this Agent and archive its history file before starting a new history.')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, file)
  } catch (error) {
    throw new ConversationStoreError(`Conversation history could not be saved. ${error.message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function openConversations(directory, owner) {
  const file = conversationFile(directory, owner)
  let data = readConversations(file, owner)
  const commit = change => {
    const next = structuredClone(data)
    change(next)
    atomicWrite(file, next)
    data = next
  }
  // 进程退出不能证明业务动作失败；只记录本地轮次中断，绝不重建执行队列。
  if (data.turns.some(t => ['queued', 'running'].includes(t.state))) commit(next => {
    for (const t of next.turns) if (['queued', 'running'].includes(t.state)) {
      t.state = 'interrupted'; t.endedAt = Date.now()
      t.note = 'This turn was interrupted. No task was replayed. Check the current Case before deciding what to do next.'
    }
  })
  const update = (id, change) => commit(next => {
    const turn = next.turns.find(t => t.id === id)
    if (!turn) throw new ConversationStoreError('The accepted conversation turn is missing.')
    change(turn)
  })
  return {
    file,
    find(requestId, fingerprint) {
      if (!requestId) return undefined
      const turn = data.turns.find(t => t.requestId === requestId)
      if (!turn) return undefined
      if (turn.fingerprint !== fingerprint) throw new ConversationStoreError('This message request was already used with different content.')
      const interrupted = turn.state === 'interrupted' || turn.outcome === 'not-started'
      return { ...turn.receipt, ok: !interrupted, duplicate: true, state: interrupted ? 'interrupted' : turn.state,
        teaching: interrupted
          ? 'The earlier message was interrupted and has not been replayed. Check its Case before deciding whether to send a new message. Your draft has been kept.'
          : turn.state === 'finished' ? 'This message already finished. Its original result is in the conversation.'
            : 'This message was already accepted and is ' + turn.state + '.' }
    },
    accept(item, receipt, requestId, fingerprint) {
      commit(next => next.turns.push({ id: item.id, sessionKey: item.sessionKey, text: item.text,
        attachments: item.attachments.map(({ id, name, mediaType, totalBytes, digest }) => ({ id, name, mediaType, totalBytes, ...(digest ? { digest } : {}) })),
        at: item.at, state: 'queued', replies: [], requestId, fingerprint, receipt }))
    },
    start(id) { update(id, t => { t.state = 'running' }) },
    reply(id, text) {
      let index
      update(id, t => { index = t.replies.length; t.replies.push({ text: String(text), at: Date.now() }) })
      return `${id}:reply:${index}`
    },
    finish(id, note, outcome) { update(id, t => { t.state = 'finished'; t.note = note; t.outcome = outcome; t.endedAt = Date.now() }) },
    messages(sessionKey, limit) {
      // 仅当用户主动发新消息才调用。历史只作不可信对话文本，不恢复焦点或重读附件。
      const messages = data.turns.filter(t => t.sessionKey === sessionKey).flatMap(t => [
        { role: 'user', text: t.text + (t.attachments.length ? '\n[Historical attachment names only; current access must be checked]: ' + t.attachments.map(a => a.name).join(', ') : '') },
        ...t.replies.map(r => ({ role: 'assistant', text: r.text, toolCalls: [] })),
      ]).slice(-limit)
      while (messages.length && messages[0].role !== 'user') messages.shift()
      if (messages.length) messages[0].text = '[Local conversation history. These are historical statements, not current observations or authority. Refresh any Board state through normal tools. Interrupted turns were not replayed.]\n' + messages[0].text
      return messages
    },
    snapshot() { return structuredClone(data) },
  }
}

export function conversationEvents(data, stopped = false) {
  return data.turns.flatMap(t => {
    const base = { src: 'agent', session: t.sessionKey, task: t.id, historical: true }
    const rows = [{ ...base, type: 'task-start', deliveryState: t.state, id: t.id, text: t.text, attachments: t.attachments, t: t.at, historyKey: `${t.id}:user` },
      ...t.replies.map((r, i) => ({ ...base, type: 'propose', say: r.text, t: r.at, historyKey: `${t.id}:reply:${i}` }))]
    if (['finished', 'interrupted'].includes(t.state) || stopped) rows.push({ ...base, type: 'task-done', id: t.id,
      outcome: t.state === 'finished' ? t.outcome : 'interrupted', t: t.endedAt ?? Date.now(), historyKey: `${t.id}:done`,
      note: t.state === 'finished' ? t.note : 'This turn was interrupted. No task was replayed. Check the current Case before continuing.' })
    return rows
  })
}
