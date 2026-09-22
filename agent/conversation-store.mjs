// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireWorkbenchLease } from '../local/manager-registry.mjs'

const FORMAT = 'rulith-conversations/1', LIBRARY = 'rulith-conversations/2'
const MAX_BYTES = 32 * 1024 * 1024, RESERVE_BYTES = 8 * 1024 * 1024, ACTIVE_BYTES = 256 * 1024 * 1024
export class ConversationStoreError extends Error {}
const hash = value => createHash('sha256').update(value).digest('hex')
const sameOwner = (a, b) => a?.origin === b.origin && a?.accountId === b.accountId && a?.agentId === b.agentId
const folder = file => file + '.d'
const turnFile = (file, id) => join(folder(file), hash(id) + '.turn.json')
const archiveFile = (file, key) => join(folder(file), hash(key) + '.session.json')
const compare = (a,b) => a.at - b.at || a.id.localeCompare(b.id)

// 历史是可见对话的投影，不承载凭据、工具正文、MCP会话或Board权威。
export function conversationFile(directory, owner) {
  if (!directory || !owner?.origin || !owner?.accountId || !owner?.agentId) throw new ConversationStoreError('Conversation history needs a verified account and Agent.')
  return join(directory, hash(JSON.stringify([new URL(owner.origin).origin, owner.accountId, owner.agentId])) + '.json')
}
function readJson(file) {
  if (statSync(file).size > MAX_BYTES) throw new Error('file exceeds the history limit')
  return JSON.parse(readFileSync(file, 'utf8'))
}
function validTurn(t) {
  if (!t || typeof t.id !== 'string' || typeof t.sessionKey !== 'string' || typeof t.text !== 'string'
    || !Number.isFinite(t.at) || !['queued', 'running', 'finished', 'interrupted'].includes(t.state)
    || !Array.isArray(t.replies) || !t.replies.every(r => typeof r.text === 'string' && Number.isFinite(r.at))
    || !Array.isArray(t.attachments)) throw new Error('invalid conversation record')
  return t
}
function indexed(t, file) {
  const { text, replies, ...metadata } = t
  return { ...metadata, title: text.slice(0, 70), _file: file, bytes: statSync(file).size }
}
const hydrate = t => t._file ? validTurn(readJson(t._file)) : structuredClone(t)

export function readConversations(file, owner, { metadataOnly = false, cache } = {}) {
  if (!existsSync(file)) {
    if (existsSync(join(folder(file), '_complete.json'))) throw new ConversationStoreError('The conversation owner record is missing. Existing history files were preserved.')
    return { format: FORMAT, owner, turns: [], archived: Object.create(null) }
  }
  try {
    // 完成哨兵是唯一切换点，迁移中断仍读取原v1。原始文件保留原字节。
    const readCached = (path, kind) => {
      if (!cache) return kind === 'turn' && metadataOnly ? indexed(validTurn(readJson(path)), path) : readJson(path)
      const stat = statSync(path, { bigint: true }), stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}`
      const old = cache.get(path)
      if (old?.stamp === stamp && old.kind === kind) return old.value
      const raw = readJson(path), value = kind === 'turn' && metadataOnly ? indexed(validTurn(raw), path)
        : kind === 'retained' && Array.isArray(raw.turns) ? { format:raw.format,owner:raw.owner,turns:[] } : raw
      cache.set(path, { stamp, kind, value }); return value
    }
    const complete = join(folder(file), '_complete.json')
    const original = readCached(file, existsSync(complete) ? 'retained' : 'original')
    if (original.format !== FORMAT || !sameOwner(original.owner, owner) || !Array.isArray(original.turns)) throw new Error('invalid format or owner')
    if (!existsSync(complete)) {
      const ids = new Set(), requests = new Set()
      if (original.turns.length > 1000) throw new Error('legacy history exceeds the turn limit')
      for (const t of original.turns) {
        validTurn(t)
        if (ids.has(t.id) || (t.requestId && requests.has(t.requestId))) throw new Error('duplicate legacy conversation record')
        ids.add(t.id); if (t.requestId) requests.add(t.requestId)
      }
      return { ...original, archived: Object.create(null) }
    }
    const marker = readCached(complete, 'marker')
    if (marker.format !== LIBRARY || !sameOwner(marker.owner, owner)) throw new Error('invalid library owner')
    const data = { format: LIBRARY, owner, turns: [], archived: Object.create(null) }, ids = new Set(), requests = new Set()
    for (const name of readdirSync(folder(file))) {
      const path = join(folder(file), name)
      if (/^[a-f0-9]{64}\.turn\.json$/.test(name)) {
        const t = readCached(path, 'turn')
        if (!metadataOnly) validTurn(t)
        if (path !== turnFile(file, t.id) || ids.has(t.id) || (t.requestId && requests.has(t.requestId))) throw new Error('duplicate or misplaced conversation record')
        ids.add(t.id); if (t.requestId) requests.add(t.requestId)
        data.turns.push(t)
      } else if (/^[a-f0-9]{64}\.session\.json$/.test(name)) {
        const s = readCached(path, 'session')
        if (typeof s.sessionKey !== 'string' || typeof s.archived !== 'boolean' || path !== archiveFile(file, s.sessionKey)) throw new Error('invalid archive record')
        data.archived[s.sessionKey] = s.archived
      }
    }
    return data
  } catch (error) { throw new ConversationStoreError(`Conversation history could not be read; the original files were preserved. ${error.message}`) }
}
function syncDirectory(path) {
  // Windows不支持目录fsync；不能把进程崩溃保护描述成硬盘掉电零丢失。
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
}
function atomicWrite(file, data) {
  const bytes = JSON.stringify(data)
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new ConversationStoreError('This conversation turn exceeds the local history limit. Its earlier record was preserved.')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, file); syncDirectory(dirname(file))
  } catch (error) { throw new ConversationStoreError(`Conversation history could not be saved. ${error.message}`) }
  finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary) }
}

export async function openConversations(directory, owner, { recoverInterrupted = true } = {}) {
  const file = conversationFile(directory, owner)
  let lease
  try { lease = await acquireWorkbenchLease(file + '.lock') }
  catch (error) { throw new ConversationStoreError('Conversation history is locked or unavailable. ' + error.message) }
  const close = () => { lease.release(); process.off('exit', close) }
  process.once('exit', close)
  try {
    let data = readConversations(file, owner, { metadataOnly: true })
    const ensure = () => {
      if (!lease.owned()) throw new ConversationStoreError('The conversation history writer no longer owns its lock.')
      if (data.format === LIBRARY) return
      if (!existsSync(file)) atomicWrite(file, { format: FORMAT, owner, turns: [] })
      const sourceSha256 = hash(readFileSync(file))
      for (const t of data.turns) atomicWrite(turnFile(file, t.id), t)
      mkdirSync(folder(file), { recursive: true, mode: 0o700 })
      const expected = new Set(data.turns.map(t => turnFile(file, t.id)))
      for (const name of readdirSync(folder(file)).filter(n => n.endsWith('.turn.json'))) {
        const path = join(folder(file), name)
        if (!expected.has(path)) throw new ConversationStoreError(`The incomplete history migration contains an unexpected record: ${path}. Stop the Agent, back up the owner JSON and its .d directory, and move this unexpected file outside that directory before retrying. Original files were preserved.`)
        validTurn(readJson(path))
      }
      if (sourceSha256 !== hash(readFileSync(file))) throw new ConversationStoreError('The original history changed during migration; it was preserved.')
      atomicWrite(join(folder(file), '_complete.json'), { format: LIBRARY, owner, sourceSha256, migratedTurns: data.turns.length })
      data = readConversations(file, owner, { metadataOnly: true })
    }
    const put = t => {
      ensure()
      const path = turnFile(file, t.id)
      atomicWrite(path, t)
      const at = data.turns.findIndex(old => old.id === t.id), entry = indexed(t, path)
      if (at < 0) data.turns.push(entry); else data.turns[at] = entry
    }
    const update = (id, change) => {
      const old = data.turns.find(t => t.id === id)
      if (!old) throw new ConversationStoreError('The accepted conversation turn is missing.')
      const t = hydrate(old); if (old.usage) t.usage = structuredClone(old.usage); change(t); put(t)
    }
    // 排队/运行中的本地轮次变为中断，绝不重建任务队列。
    for (const t of recoverInterrupted ? [...data.turns] : []) if (['queued', 'running'].includes(t.state)) update(t.id, next => {
      next.state = 'interrupted'; next.endedAt = Date.now()
      next.note = 'This turn was interrupted. No task was replayed. Check the current Case before deciding what to do next.'
    })
    return {
      file, close,
      find(requestId, fingerprint) {
        if (!requestId) return undefined
        const t = data.turns.find(t => t.requestId === requestId)
        if (!t) return undefined
        if (t.fingerprint !== fingerprint) throw new ConversationStoreError('This message request was already used with different content.')
        const interrupted = t.state === 'interrupted' || t.outcome === 'not-started'
        return { ...t.receipt, ok: !interrupted, duplicate: true, state: interrupted ? 'interrupted' : t.state,
          teaching: interrupted ? 'The earlier message was interrupted and has not been replayed. Check its Case before sending a new message. Your draft has been kept.'
            : t.state === 'finished' ? 'This message already finished. Its original result is in the conversation.' : 'This message was already accepted and is ' + t.state + '.' }
      },
      accept(item, receipt, requestId, fingerprint) {
        if (data.archived[item.sessionKey]) throw new ConversationStoreError('This conversation is archived. Restore it before sending a new message.')
        if (data.turns.some(t => t.id === item.id || (requestId && t.requestId === requestId))) throw new ConversationStoreError('This conversation request already exists.')
        const active = data.turns.filter(t => !data.archived[t.sessionKey])
        const reserved = active.reduce((n, t) => n + (t.bytes || 0) + (['queued','running'].includes(t.state) ? RESERVE_BYTES : 0), 0)
        if (active.length >= 1000 || reserved + Buffer.byteLength(item.text) + RESERVE_BYTES > ACTIVE_BYTES) throw new ConversationStoreError('Active conversation history is full. Archive completed conversations in Conversations, then send again.')
        put({ id: item.id, sessionKey: item.sessionKey, text: item.text,
          attachments: item.attachments.map(({ id, name, mediaType, totalBytes, digest }) => ({ id, name, mediaType, totalBytes, ...(digest ? { digest } : {}) })),
          at: item.at, state: 'queued', replies: [], requestId, fingerprint, receipt,
          ...(item.modelService ? { modelService: item.modelService } : {}) })
      },
      start(id) { update(id, t => { t.state = 'running' }) },
      modelServices(sessionKey) { return [...new Set(data.turns.filter(t => t.sessionKey === sessionKey).map(t => t.modelService).filter(Boolean))] },
      usage(id, measured) {
        // 诊断先在内存累计，随下一次正文/终态持久化；统计本身不能打断模型回复。
        const t = data.turns.find(t => t.id === id); if (!t) return
        const u = t.usage ?? { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 }
        u.calls++; u.durationMs += measured.durationMs
        if (measured.inputTokens === null || measured.outputTokens === null) u.unknownUsageCalls++
        u.inputTokens += measured.inputTokens ?? 0; u.outputTokens += measured.outputTokens ?? 0; t.usage = u
      },
      reply(id, text) {
        let index
        update(id, t => { index = t.replies.length; t.replies.push({ text: String(text), at: Date.now() }) })
        return `${id}:reply:${index}`
      },
      finish(id, note, outcome, details = {}) { update(id, t => { t.state = 'finished'; t.note = note; t.outcome = outcome; t.endedAt = Date.now(); t.caseIds = [...new Set(details.caseIds ?? [])].filter(id => typeof id === 'string' && id); if (details.modelService) t.modelService = details.modelService }) },
      archive(sessionKey, archived, { stopped = false } = {}) {
        const rows = data.turns.filter(t => t.sessionKey === sessionKey)
        if (!rows.length) throw new ConversationStoreError('This conversation could not be found.')
        if (rows.some(t => ['queued', 'running'].includes(t.state)) && !stopped) throw new ConversationStoreError('Wait for this conversation to finish or stop the Agent before archiving queued or running work.')
        if (stopped) for (const t of rows) if (['queued', 'running'].includes(t.state)) update(t.id, next => { next.state = 'interrupted'; next.endedAt = Date.now(); next.note = 'The Agent stopped. This local turn was not replayed.' })
        ensure(); atomicWrite(archiveFile(file, sessionKey), { sessionKey, archived: archived === true })
        data.archived[sessionKey] = archived === true
      },
      messages(sessionKey, limit) {
        const messages = data.turns.filter(t => t.sessionKey === sessionKey).sort(compare).slice(-limit).map(hydrate).flatMap(t => [
          { role: 'user', text: t.text + (t.attachments.length ? '\n[Historical attachment names only; current access must be checked]: ' + t.attachments.map(a => a.name).join(', ') : '') },
          ...t.replies.map(r => ({ role: 'assistant', text: r.text, toolCalls: [] })),
        ]).slice(-limit)
        while (messages.length && messages[0].role !== 'user') messages.shift()
        if (messages.length) messages[0].text = '[Local conversation history. These are historical statements, not current observations or authority. Refresh any Board state through normal tools. Interrupted turns were not replayed.]\n' + messages[0].text
        return messages
      },
      snapshot() { return { ...data, turns: data.turns.map(hydrate), archived: { ...data.archived } } },
    }
  } catch (error) { close(); throw error }
}
export function conversationList(data, { archived = false, offset = 0, limit = 30 } = {}) {
  const groups = new Map()
  for (const t of [...data.turns].sort(compare)) {
    if (!!data.archived?.[t.sessionKey] !== archived) continue
    const current = groups.get(t.sessionKey) ?? { sessionKey: t.sessionKey, title: t.title ?? t.text.slice(0,70), turnCount: 0, archived }
    current.turnCount++; current.updatedAt = t.at; current.state = t.state
    groups.set(t.sessionKey,current)
  }
  const rows = [...groups.values()].sort((a,b) => b.updatedAt-a.updatedAt || a.sessionKey.localeCompare(b.sessionKey))
  offset = Math.max(0,Math.floor(Number(offset)||0)); limit = Math.max(1,Math.min(50,Math.floor(Number(limit)||30)))
  return { items: rows.slice(offset, offset+limit), total: rows.length, offset, hasMore: offset+limit<rows.length }
}
export function conversationPage(data, sessionKey, { before, limit = 30 } = {}) {
  let rows = data.turns.filter(t => t.sessionKey === sessionKey).sort(compare)
  if (before) { const index = rows.findIndex(t => t.id === before); if (index < 0) throw new ConversationStoreError('The history page cursor is no longer available. Reopen this conversation.'); rows = rows.slice(0,index) }
  limit = Math.max(1,Math.min(50,Math.floor(Number(limit)||30)))
  const page = rows.slice(-limit).map(hydrate)
  return { format: data.format, owner: data.owner, sessionKey, archived: !!data.archived?.[sessionKey], turns: page, before: rows.length>limit ? page[0].id : null }
}
export function conversationEvents(data, stopped = false) {
  return data.turns.flatMap(t => {
    const base = { src: 'agent', session: t.sessionKey, task: t.id, historical: true }
    const rows = [{ ...base, type: 'task-start', deliveryState: t.state, id: t.id, text: t.text, attachments: t.attachments, t: t.at, historyKey: `${t.id}:user` },
      ...t.replies.map((r, i) => ({ ...base, type: 'propose', say: r.text, t: r.at, historyKey: `${t.id}:reply:${i}` }))]
    if (t.caseIds?.length) rows.push({ ...base, type: 'history-cases', caseIds: t.caseIds, t: t.at, historyKey: `${t.id}:cases` })
    if (t.usage) rows.push({ ...base, type: 'model-summary', ...t.usage, t: t.endedAt ?? t.at, historyKey: `${t.id}:usage` })
    if (['finished', 'interrupted'].includes(t.state) || stopped) rows.push({ ...base, type: 'task-done', id: t.id,
      outcome: t.state === 'finished' ? t.outcome : 'interrupted', t: t.endedAt ?? Date.now(), historyKey: `${t.id}:done`,
      note: t.state === 'finished' ? t.note : 'This turn was interrupted. No task was replayed. Check the current Case before continuing.' })
    return rows
  })
}
