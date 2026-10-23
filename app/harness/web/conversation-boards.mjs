// Host-only Board ownership. Tool registration and Agent selection remain launcher-wide.
import { setTimeout as delay } from 'node:timers/promises';
import { BoardChannel } from '../board-channel.mjs';
import { conversationKey, depthOf } from '../subagents.mjs';

const TRANSIENT = /^(MCP transport failed|MCP request refused|MCP response unreadable|MCP connection closed|connection_replaced)$/;
const terminal = (error) => ['conversation_limit', 'exploration_control_pending', 'conversation_ended'].includes(error?.reason);
const unexecuted = (error) => error?.requestExecuted === false || error?.reason === 'session_unavailable';
const transient = (error) => (!error?.reason || error.reason === 'connection_replaced') && TRANSIENT.test(String(error?.message ?? ''));

export class ConversationBoards {
  constructor({ enabled = true, connect, shadow, toolKinds, report = () => {},
    patienceMs = Number(process.env.RULITH_DSH_RECONNECT_PATIENCE_MS ?? 180000),
    wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
    Object.assign(this, { enabled, connect, shadow, toolKinds, report, patienceMs, wait });
    this.holders = new Map(); this.sessions = new Map(); this.disposed = new Set(); this.closed = false;
  }
  get size() { return this.holders.size; }
  observe(agent) {
    if (this.closed) throw new Error('Rulith Agent detached');
    const key = this.enabled ? conversationKey(agent) : undefined;
    if (typeof agent?.session?.id === 'string') {
      this.disposed.delete(agent.session.id);
      this.sessions.set(agent.session.id, key);
      // A cold child's parent may predate plugin attachment. Retain that owner until its disposal is observed.
      const parent = agent.session.header?.parentSession;
      if (this.enabled && depthOf(agent) && !this.disposed.has(parent)) this.sessions.set(parent, key);
    }
    return key;
  }
  holder(agent) { return this.holderForKey(this.observe(agent)); }
  /**
   * The holder of one conversation by its key, created on demand. Normally a holder appears when dsh creates the
   * conversation's agent (observe); the owner's composer controls may also need one for a conversation that has not called
   * Rulith yet, so that choosing a mode can open its Board first (ensureBoard).
   */
  holderForKey(key) {
    if (this.closed) throw new Error('Rulith Agent detached');
    let holder = this.holders.get(key);
    if (holder) return holder;
    holder = { key, bridge: null, connecting: null, stop: new AbortController(), state: 'attached', detail: {} };
    holder.channel = new BoardChannel({ shadow: this.shadow(), toolKinds: this.toolKinds,
      focusedGoals: () => holder.bridge?.focusedGoals ?? [],
      invoke: (name, args) => this.request(holder, name, args) });
    this.holders.set(key, holder);
    this.publish();
    return holder;
  }
  live(holder) { return !this.closed && this.holders.get(holder.key) === holder; }
  publish() {
    const severity = { attached: 0, reconnecting: 1, failed: 2 };
    const holders = [...this.holders.values()];
    const worst = holders.reduce((a, b) => !a || severity[b.state] > severity[a.state] ? b : a,
      null) ?? { state: 'attached', detail: {} };
    const reconnectedAt = holders.map((holder) => holder.reconnectedAt).filter(Boolean).sort().at(-1);
    this.report(worst.state, { ...worst.detail, ...(reconnectedAt ? { reconnectedAt } : {}), liveConversations: this.size });
  }
  state(holder, state, detail = {}) {
    if (!this.live(holder)) return;
    holder.state = state; holder.detail = detail; this.publish();
  }
  async connectPatiently(holder) {
    const until = Date.now() + this.patienceMs;
    const reconnect = !!holder.bridge;
    let pendingRetries = 0, refusalRetries = 0;
    if (reconnect) this.state(holder, 'reconnecting');
    for (let retryMs = 2000; ; retryMs = Math.min(retryMs * 2, 30000)) {
      if (!this.live(holder)) throw new Error('Rulith Agent detached');
      try {
        const { bridge } = await this.connect(holder.key, holder.stop.signal);
        if (!this.live(holder)) { bridge.close(); throw new Error('Rulith Agent detached'); }
        holder.bridge = bridge;
        holder.idleExhausted = false;
        if (reconnect) holder.reconnectedAt = new Date().toISOString();
        this.state(holder, 'attached', holder.reconnectedAt ? { reconnectedAt: holder.reconnectedAt } : {});
        return bridge;
      } catch (error) {
        let backoff;
        if (error?.reason === 'exploration_control_pending') {
          if (pendingRetries < 2) backoff = 250 * 2 ** pendingRetries++;
        } else if (!terminal(error) && unexecuted(error)) {
          if (refusalRetries++ === 0) backoff = 0;
        } else if (!terminal(error) && transient(error)) backoff = retryMs;
        if (backoff === undefined || !this.live(holder) || Date.now() + backoff > until) throw error;
        this.state(holder, 'reconnecting', { reason: String(error.message), retryInMs: backoff });
        if (backoff) await this.wait(backoff, holder.stop.signal);
      }
    }
  }
  async liveBridge(holder) {
    if (!this.live(holder)) throw new Error('Rulith Agent detached');
    if (holder.bridge && !holder.bridge.closed) return holder.bridge;
    if (!holder.connecting) holder.connecting = this.connectPatiently(holder).catch((error) => {
      holder.idleExhausted = true;
      this.state(holder, 'failed', { error: String(error.message) });
      throw error;
    }).finally(() => { holder.connecting = null; });
    return holder.connecting;
  }
  /** Open this conversation's Board now (an MCP initialize, which creates the Board on first use), without a tool call. */
  async ensureBoard(key) {
    if (!this.enabled) throw new Error('Conversation Boards are off for this launcher');
    await this.liveBridge(this.holderForKey(key));
  }
  async reconnectIdle() {
    await Promise.all([...this.holders.values()].filter((holder) => holder.bridge?.closed && !holder.idleExhausted)
      .map((holder) => this.liveBridge(holder).catch(() => {})));
  }
  async request(holder, name, args) {
    for (let attempt = 0; ; attempt++) {
      const bridge = await this.liveBridge(holder);
      try { return await bridge.call(name, args); }
      catch (error) {
        // A transport failure gets one proactive recovery budget even if a write cannot be replayed.
        holder.idleExhausted = terminal(error) || unexecuted(error) || !transient(error);
        this.state(holder, 'failed', { error: String(error.message) });
        if (terminal(error)) throw error;
        if (unexecuted(error)) {
          if (attempt) throw error;
          bridge.close();
          continue;
        }
        if (!transient(error)) throw error;
        if (name === 'Get') { if (!attempt) continue; throw error; }
        throw new Error('The connection to Rulith was interrupted during this call; its outcome is unknown. Do not repeat it: Get shows its outcome in the operations strip.');
      }
    }
  }
  disposeSession(session) {
    this.disposed.add(session.id);
    if (!this.sessions.has(session.id)) return;
    const key = this.sessions.get(session.id);
    this.sessions.delete(session.id);
    if (!this.enabled) return; // The legacy default Board lives for the Agent attachment.
    if (![...this.sessions.values()].includes(key)) this.drop(key);
  }
  drop(key) {
    const holder = this.holders.get(key);
    if (!holder) return;
    this.holders.delete(key);
    holder.stop.abort(); holder.channel.close(); holder.bridge?.close();
    this.publish();
  }
  close() {
    this.closed = true;
    for (const key of this.holders.keys()) this.drop(key);
    this.sessions.clear();
    this.disposed.clear();
  }
}
