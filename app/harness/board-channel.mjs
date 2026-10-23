// One FIFO for every hand. The panel only reads cached results. A queue entry owns review + initial request only;
// a held operation's follow-up reads rejoin the FIFO. The operation slot lasts through return,
// including the shadow suggestion; review reads and dispatch stay adjacent on the same transport.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { blockNote, decodeBoardResult, deliveryNote, NOTE_PREFIX } from './web/shadow-reviewer.mjs';

export function renderChannelResult(_args, result) {
  const notes = (result.content ?? []).filter((part) => part.text?.startsWith(NOTE_PREFIX));
  const content = (result.content ?? []).filter((part) => !notes.includes(part));
  return [{ type: 'text', text: JSON.stringify({ ...result, content })
    + (notes.length ? '\n' + notes.map((part) => part.text).join('\n') : '') }];
}

const UNRESOLVED = new Set(['running', 'waiting_for_decision', 'needs_person']);
const mainEntry = (entry) => (entry.seat ?? 'main') === 'main'; // Ignore historical other-seat entries, never route to them.
const keyOf = (entry) => JSON.stringify([entry.tool, entry.label, entry.at]);
const deliveredOutcome = (result, entry) => {
  const answer = decodeBoardResult(result);
  // The carrier can be another hand's refused call. Its refusal is not this operation's outcome.
  return { content: [{ type: 'text', text: JSON.stringify({ accepted: entry.state !== 'refused', tool: entry.tool,
    state: entry.state, ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    ...(entry.contentWithheld !== undefined ? { contentWithheld: entry.contentWithheld } : {}),
    ...(entry.decision !== undefined ? { decision: entry.decision } : {}),
    ...(entry.reason !== undefined ? { teaching: entry.reason } : {}), view: answer.view, operations: answer.operations }) }] };
};
const ownEntry = (result, tool) => {
  const entries = (decodeBoardResult(result)?.operations ?? []).filter((entry) => entry.tool === tool && mainEntry(entry) && UNRESOLVED.has(entry.state));
  return entries.length === 1 ? entries[0] : undefined;
};

// Stop waiting on a queued/in-flight read without cancelling the shared transport.
const untilAbort = (promise, signal) => {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

export async function awaitOutcome(bridge, tool, result, { pollMs = 2_000, signal,
  waitSeconds = Number(process.env.RULITH_DSH_WAIT_SECONDS || 0), delivered = () => undefined } = {}) {
  const own = ownEntry(result, tool);
  if (!own || own.state !== 'running' || decodeBoardResult(result)?.accepted === false) return result;
  const deadline = waitSeconds > 0 ? Date.now() + waitSeconds * 1000 : Infinity;
  let last = result;
  while (Date.now() < deadline && !signal?.aborted) {
    try { await delay(pollMs, undefined, { signal }); }
    catch (error) { if (signal?.aborted) return last; throw error; }
    const retained = delivered(own); if (retained) return retained;
    const look = await untilAbort(bridge.call('Get', {}), signal);
    if (signal?.aborted) return last;
    const captured = delivered(own); if (captured) return captured;
    if (look.isError) return last;
    const entry = (decodeBoardResult(look)?.operations ?? []).find((entry) => mainEntry(entry) && keyOf(entry) === keyOf(own));
    // Absence is not settlement: another call may already have delivered and aged this entry.
    if (entry) { last = look; if (entry.state !== 'running') return look; }
  }
  return last;
}

export function readToolKinds(file) {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.format !== 'rulith-worker-tools/1') return {};
    return Object.fromEntries(Object.entries(manifest.tools ?? {}).map(([id, tool]) => [id, tool.kind]));
  } catch { return {}; }
}

/** Only authority declarations or an authority-listed Worker id plus its local manifest can exempt an Execute. */
export function isWrite(tool, args, views = [], toolKinds = {}) {
  if (tool === 'Set') return true;
  if (tool !== 'Execute') return false;
  const actions = views.flatMap((view) => view.actions ?? []);
  const action = actions.find((row) => row.action === args?.action);
  if (!action) return true;
  if (action.kind === 'read') return false;
  if (action.kind !== undefined) return true;
  const id = /^\[worker tool\] (\S+)$/u.exec(action.description ?? '')?.[1];
  // A shared Tool id on different carriers is not enough to select a read declaration.
  const matches = new Set(actions.filter((row) => row.description === action.description).map((row) => row.action));
  return !id || matches.size !== 1 || views.some((view) => view.actionsTruncated === true) || toolKinds[id] !== 'read';
}

// A block has the platform's pre-execution refusal shape, so every hand reads it like any Board refusal.
// The view keeps Action names and readiness only, as the platform's refusal view does.
export function blockedResult(position, teaching, tool) {
  const read = decodeBoardResult(position) ?? {};
  const answer = { accepted: false, requestExecuted: false, tool, errorCode: 'review_blocked', teaching };
  if (read.view) answer.view = { ...read.view, ...(Array.isArray(read.view.actions) ? { actions: read.view.actions.map((row) =>
    ({ ...Object.fromEntries(['action', 'status', 'reason', 'why', 'waits'].filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])),
      ...(row.available === false ? { available: false,
        ...(Object.hasOwn(row, 'unavailableReason') ? { unavailableReason: row.unavailableReason } : {}) } : {}) })) } : {}) };
  answer.operations = read.operations ?? [];
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(answer) }], ...(position?._meta ? { _meta: position._meta } : {}) };
}

const targetKey = (hand, tool, args) => JSON.stringify([hand, tool, args?.action ?? null, args?.target ?? args?.args?.goal ?? null,
  tool === 'Set' ? [...new Set((args?.operations ?? []).map((op) =>
    op.target ?? op.goal ?? op.args?.goal ?? op.parent ?? op.nodeId ?? op.id ?? op.label ?? op.predicate ?? null))].sort() : null]);

export class BoardChannel {
  constructor({ invoke, focusedGoals = () => [], toolKinds = () => ({}), shadow, visible = console.error }) {
    Object.assign(this, { invoke, focusedGoals, toolKinds, shadow, visible });
    this.queue = Promise.resolve(); this.blocks = new Map(); this.pending = new Map(); this.closed = false;
    this.operation = null; this.operationWaiters = []; this.stop = new AbortController();
    this.latestBoard = null;
  }
  acquireOperation(signal) {
    if (this.closed) return Promise.reject(new Error('MCP connection closed'));
    return new Promise((resolve, reject) => {
      const waiter = { reject, cleanup: () => signal?.removeEventListener('abort', abort), grant: () => {
        waiter.cleanup();
        const slot = {}; this.operation = slot;
        resolve(() => {
          if (this.operation !== slot) return;
          this.operation = null; this.operationWaiters.shift()?.grant();
        });
      } };
      const abort = () => {
        this.operationWaiters = this.operationWaiters.filter((entry) => entry !== waiter);
        waiter.cleanup(); reject(signal.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (this.operation) this.operationWaiters.push(waiter);
      else waiter.grant();
    });
  }
  serial(job) {
    if (this.closed) return Promise.reject(new Error('MCP connection closed'));
    const next = this.queue.then(() => { if (this.closed) throw new Error('MCP connection closed'); return job(); });
    this.queue = next.catch(() => {}); return next;
  }
  async request(tool, args) {
    const result = await this.invoke(tool, args);
    const answer = decodeBoardResult(result);
    if (answer?.view) this.latestBoard = { view: answer.view, operations: answer.operations ?? [], seenAt: new Date().toISOString() };
    for (const entry of answer?.operations ?? []) {
      if (!mainEntry(entry)) continue;
      const key = keyOf(entry);
      if (this.pending.has(key) && entry.state !== 'running') this.pending.set(key, deliveredOutcome(result, entry));
    }
    return result;
  }
  async discovery() {
    const result = await this.request('Get', {});
    const answer = decodeBoardResult(result);
    if (result.isError || answer?.accepted !== true || !answer.view) throw new Error('shadow default Board read refused');
    this.position = result; // The position a block answer shows; same queue entry, so nothing changed since.
    return answer.view;
  }
  async views(discovery) {
    const views = [discovery ?? await this.discovery()];
    const goals = [...this.focusedGoals()];
    if (goals.length) {
      const result = await this.request('Get', { include: ['nodes'], selector: { goals } });
      const answer = decodeBoardResult(result);
      if (result.isError || answer?.accepted !== true || !answer.view) throw new Error('shadow focused Board read refused');
      views.push(answer.view);
    }
    return views;
  }
  async call(tool, args, { hand = 'main', route = {}, timeoutMs, wait = {}, signal } = {}) {
    const operation = tool === 'Set' || tool === 'Execute' || (tool === 'Get' && Object.hasOwn(args ?? {}, 'artifact'));
    // Admission is outside the FIFO: plain reads and the holder's polls must keep flowing.
    const release = operation ? await this.acquireOperation(signal) : () => {};
    let first;
    try {
      first = await this.serial(async () => {
        signal?.throwIfAborted();
        let discovery; let readError; this.position = undefined;
        // Execute needs a fresh declaration. Classification failure remains a write and fails open in review.
        if (tool === 'Execute' && this.shadow?.enabled) {
          try { discovery = await this.discovery(); } catch (error) { readError = error; }
        }
        let verdict = { verdict: 'allow' };
        let kinds = {};
        if (tool === 'Execute' && this.shadow?.enabled)
          try { kinds = this.toolKinds(); } catch (error) { readError ??= error; }
        if (isWrite(tool, args, discovery ? [discovery] : [], kinds) && this.shadow)
          verdict = await this.shadow.review({ hand, tool, args, route, timeoutMs }, async () => {
            if (readError) throw readError;
            return this.views(discovery);
          });
        if (this.closed) throw new Error('MCP connection closed');
        signal?.throwIfAborted();
        if (verdict.verdict === 'block') {
          const key = targetKey(hand, tool, args); const count = (this.blocks.get(key) ?? 0) + 1;
          this.blocks.set(key, count);
          return { result: blockedResult(this.position, blockNote(verdict, count >= 2), tool) };
        }
        const result = await this.request(tool, args);
        // A default Board Get cannot own the slot even if its strip shows somebody's held Artifact Get.
        const own = !result.isError && decodeBoardResult(result)?.accepted !== false && operation && ownEntry(result, tool);
        if (own?.state === 'running') this.pending.set(keyOf(own), null);
        return { result, own, note: verdict.verdict === 'note' ? verdict : null };
      });
      let outcome = first.result;
      if (first.own?.state === 'running') outcome = await awaitOutcome(this, tool, outcome, {
        ...wait, signal: signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal,
        delivered: (entry) => this.pending.get(keyOf(entry)),
      });
      if (first.note) {
        // Record advice inside the holder's slot; acquiring again would deadlock.
        try {
          signal?.throwIfAborted();
          const id = `shadow_${randomUUID().replaceAll('-', '')}`;
          const result = await this.serial(() => this.request('Set', { operations: [{ op: 'assert_fact', id,
            predicate: 'suggestion', args: { id, node: first.note.node, advice: first.note.advice } }] }));
          const answer = decodeBoardResult(result);
          if (result.isError || answer?.accepted !== true || UNRESOLVED.has(answer?.state)) throw new Error('shadow suggestion not accepted or still unresolved');
        } catch (error) { this.visible(`[shadow] suggestion write FAILED: ${String(error?.message ?? error).slice(0, 300)}`); }
        outcome = { ...outcome, content: [...(outcome.content ?? []), { type: 'text', text: deliveryNote(first.note) }] };
      }
      return outcome;
    } finally { if (first?.own) this.pending.delete(keyOf(first.own)); release(); }
  }
  close() {
    this.closed = true; this.stop.abort(); this.operation = null;
    for (const waiter of this.operationWaiters.splice(0)) { waiter.cleanup(); waiter.reject(new Error('MCP connection closed')); }
    this.shadow?.close();
  }
}
