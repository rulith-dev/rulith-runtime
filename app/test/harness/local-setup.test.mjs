// PSC 0.2.27 ② ③ ④ (ACC-LOCAL-09, ACC-LOCAL-10): the app host's half of "set up this Agent on this computer" and of the
// model that applies from the next turn. No manager process, network service or credential of this computer is used:
// the manager is a recording stand-in, and the model endpoints are local test servers that record what reaches them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setupRoutes, setupView } from '../../harness/web/local-setup.mjs';
import { conversationModel, createRouteAdapter, effectiveModel, installLiveModels, liveRoute, modelRoutes, publicModel, signedInAccount }
  from '../../harness/web/model-runtime.mjs';

const ACCOUNT = { origin: 'https://console.example', accountId: 'acct-1' };
const SECRET = 'sk-test-never-shown-0123456789';
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-rulith-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

test('setup routes start the manager operation, read its steps, and wait for it with its step\'s reason on failure', async () => {
  const sent = [];
  const rows = new Map();
  const steps = (state) => ['instance', 'pair', 'kit', 'worker', 'reload', 'ready'].map((name, index) => ({ name,
    state: state === 'failed' && index === 1 ? 'failed' : state === 'failed' && index > 1 ? 'pending' : 'done',
    reason: state === 'failed' && index === 1 ? 'That Connection is in use by a Worker on another computer.' : 'Done.',
    ...(state === 'failed' && index === 1 ? { errorCode: 'local_setup_connection_in_use' } : {}) }));
  let polls = 0;
  const manager = async (route, body) => {
    sent.push([route, body]);
    if (body) {
      rows.set(body.requestId, body.agentId === 'agent-bad' ? 'failed' : 'running');
      // The manager appends its whole state to every answer; none of it may reach the page.
      return { setup: { requestId: body.requestId, agentId: body.agentId, mode: body.mode, state: rows.get(body.requestId), steps: steps(rows.get(body.requestId)),
        instanceId: 'inst-1', connectionId: '', connectionDisposition: '', secretish: SECRET }, instances: [{ token: SECRET }] };
    }
    const requestId = new URL(route, 'http://x').searchParams.get('requestId');
    if (++polls >= 2) rows.set(requestId, 'done');
    const state = rows.get(requestId);
    return { setup: { requestId, agentId: 'agent-1', mode: 'setup', state, steps: steps(state), instanceId: 'inst-1', connectionId: 'conn-1',
      connectionDisposition: 'reused' } };
  };
  const routes = setupRoutes({ manager, wait: async () => {} });
  const started = await routes.start({ agentId: 'agent-1', requestId: 'setup-app-0001' });
  assert.deepEqual(sent[0], ['/manager/instances/setup-local', { requestId: 'setup-app-0001', agentId: 'agent-1', mode: 'setup' }]);
  assert.equal(started.state, 'running');
  assert.equal(JSON.stringify(started).includes(SECRET), false, 'only the step list and ids reach the page');
  const done = await routes.ready({ agentId: 'agent-1', requestId: 'setup-app-0001' });
  assert.deepEqual([done.state, done.connectionId, done.connectionDisposition], ['done', 'conn-1', 'reused']);
  await assert.rejects(routes.ready({ agentId: 'agent-bad', requestId: 'setup-app-0002', mode: 'repair' }),
    (error) => error.message === 'That Connection is in use by a Worker on another computer.' && error.errorCode === 'local_setup_connection_in_use');
  assert.equal(sent.at(-1)[1].mode, 'repair');
  await assert.rejects(routes.status({ requestId: '../x' }), /Name the setup request/);
  // A request id is made when the page sends none, so a new click is a new request.
  await routes.start({ agentId: 'agent-1' });
  assert.match(sent.at(-1)[1].requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(setupView({ setup: { requestId: 'x', extra: 1 } })).sort(),
    ['agentId', 'connectionDisposition', 'connectionId', 'instanceId', 'mode', 'requestId', 'state', 'steps']);
  // The owner's confirmation of replacing the Agent token (SYS-LOCAL-01) is passed on only as exactly `true`.
  await routes.start({ agentId: 'agent-1', requestId: 'setup-app-0003', replaceAgentToken: true });
  assert.deepEqual(sent.at(-1)[1], { requestId: 'setup-app-0003', agentId: 'agent-1', mode: 'setup', replaceAgentToken: true });
  await routes.start({ agentId: 'agent-1', requestId: 'setup-app-0004', replaceAgentToken: 'yes' });
  assert.equal(Object.hasOwn(sent.at(-1)[1], 'replaceAgentToken'), false);
  assert.equal(setupView({ setup: { requestId: 'x', replaceAgentToken: true } }).replaceAgentToken, true);
});

test('setup waiting is bounded: a setup still running after the bound is reported as in progress, not as failed', async () => {
  const manager = async (route, body) => ({ setup: { requestId: body?.requestId ?? 'setup-slow-0001', state: 'running', steps: [] } });
  await assert.rejects(setupRoutes({ manager, wait: async () => {}, waitMs: 0 }).ready({ agentId: 'agent-1', requestId: 'setup-slow-0001' }),
    (error) => error.errorCode === 'setup_in_progress');
});

/** A manager home with one signed-in account, an account default for it and for another account, and two instances. */
function home(t, { signedIn = true } = {}) {
  const dir = temp(t);
  if (signedIn) writeJson(path.join(dir, 'device.json'), { format: 'rulith-local-device/1', state: 'linked', origin: ACCOUNT.origin,
    account: { id: ACCOUNT.accountId, name: 'Owner' }, agents: [{ id: 'agent-1', name: 'One' }, { id: 'agent-2', name: 'Two' }] });
  writeJson(path.join(dir, 'model-defaults.json'), { version: 1, defaults: [
    { origin: ACCOUNT.origin, accountId: 'acct-other', url: 'https://api.deepseek.com', name: 'deepseek-chat', key: 'other-account-key' },
    { origin: ACCOUNT.origin, accountId: ACCOUNT.accountId, url: 'http://127.0.0.1:8080/v1', name: 'qwen', key: '' }] });
  const own = path.join(dir, 'instances', 'own'), inherits = path.join(dir, 'instances', 'inherits');
  writeJson(path.join(own, 'local.json'), { agent: { env: { RULITH_MODEL_URL: 'https://api.deepseek.com', RULITH_MODEL: 'deepseek-reasoner', RULITH_MODEL_KEY: SECRET } } });
  writeJson(path.join(inherits, 'local.json'), { agent: { env: { RULITH_MODEL_URL: 'https://stale.example/v1', RULITH_MODEL: 'stale', RULITH_MODEL_KEY: 'stale-key' } } });
  writeJson(path.join(dir, 'registry.json'), { instances: [
    // No model source recorded is the Runtime's "its own model" (instance-manager.mjs modelSource).
    { id: 'own', mode: 'local_agent', agentId: 'agent-1', origin: ACCOUNT.origin, accountId: ACCOUNT.accountId, directory: own },
    { id: 'inherits', mode: 'local_agent', agentId: 'agent-2', origin: ACCOUNT.origin, accountId: ACCOUNT.accountId, directory: inherits, modelSource: 'default' }] });
  return dir;
}

test('the model in force is the signed-in account\'s: an Agent\'s own model, else the account default, never another account\'s', (t) => {
  const dir = home(t);
  const account = signedInAccount(dir);
  assert.deepEqual(account, ACCOUNT);
  assert.deepEqual(effectiveModel({ home: dir }, account, 'agent-1'),
    { source: 'override', url: 'https://api.deepseek.com', name: 'deepseek-reasoner', key: SECRET });
  assert.deepEqual(effectiveModel({ home: dir }, account, 'agent-2'), { source: 'default', url: 'http://127.0.0.1:8080/v1', name: 'qwen', key: '' },
    'an Agent following the default never reads its own stale fields');
  assert.equal(effectiveModel({ home: dir }, account, undefined).name, 'qwen');
  // Switching account: the other account has no row here, so nothing of this one is inherited (ACC-LOCAL-10).
  assert.deepEqual(effectiveModel({ home: dir }, { ...ACCOUNT, accountId: 'acct-3' }, 'agent-1'), { source: 'default', url: '', name: '', key: '' });
  const signedOut = home(t, { signedIn: false });
  assert.equal(signedInAccount(signedOut), null);
  assert.equal(effectiveModel({ home: signedOut }, null, 'agent-1').key, '', 'signed out there is no model, and no key');
  // The page's view: no key, not even its length.
  const shown = publicModel(effectiveModel({ home: dir }, account, 'agent-1'), account);
  assert.deepEqual(shown, { source: 'override', url: 'https://api.deepseek.com', name: 'deepseek-reasoner', modelId: 'deepseek-reasoner',
    configured: true, keyConfigured: true, expectedOrigin: ACCOUNT.origin, expectedAccountId: ACCOUNT.accountId });
  assert.equal(JSON.stringify(shown).includes(SECRET), false);
});

test('a developer launcher reading another home\'s defaults (modelHome) matches them against that home\'s own sign-in', (t) => {
  const dir = home(t);
  const account = signedInAccount(dir);
  // Another manager home, signed in to a different account there, with that account's default saved there.
  const other = temp(t);
  const DEV = { origin: 'https://console.other.example', accountId: 'acct-dev' };
  writeJson(path.join(other, 'device.json'), { format: 'rulith-local-device/1', state: 'linked', origin: DEV.origin, account: { id: DEV.accountId } });
  writeJson(path.join(other, 'model-defaults.json'), { version: 1, defaults: [
    { origin: ACCOUNT.origin, accountId: ACCOUNT.accountId, url: 'https://stale.example/v1', name: 'not-this-row', key: 'stale' },
    { origin: DEV.origin, accountId: DEV.accountId, url: 'http://127.0.0.1:8091/v1', name: 'dev-model', key: '' }] });
  assert.deepEqual(effectiveModel({ home: dir, modelHome: other }, account, 'agent-2'),
    { source: 'default', url: 'http://127.0.0.1:8091/v1', name: 'dev-model', key: '' }, 'the row of the account signed in there');
  // An Agent's own model is still this home's; and this computer must still be signed in.
  assert.equal(effectiveModel({ home: dir, modelHome: other }, account, 'agent-1').source, 'override');
  assert.equal(effectiveModel({ home: dir, modelHome: other }, null, 'agent-2').name, '');
  // A modelHome nobody is signed in to has no account, so none of its rows counts.
  fs.rmSync(path.join(other, 'device.json'));
  assert.deepEqual(effectiveModel({ home: dir, modelHome: other }, account, 'agent-2'), { source: 'default', url: '', name: '', key: '' });
});

test('a model on this computer takes localContextWindow as its route\'s window; other models keep the 1M default', () => {
  const local = { url: 'http://127.0.0.1:8080/v1', name: 'qwen', key: '' };
  assert.equal(liveRoute(local, { localContextWindow: 262144 }).contextWindow, 262144);
  assert.equal(liveRoute({ ...local, url: 'http://localhost:8080/v1' }, { localContextWindow: 131072 }).contextWindow, 131072);
  assert.equal(liveRoute({ ...local, url: 'http://[::1]:8080/v1' }, { localContextWindow: 131072 }).contextWindow, 131072);
  assert.equal(liveRoute(local).contextWindow, 1_000_000, 'without the setting, the default');
  assert.equal(liveRoute(local, { localContextWindow: -1 }).contextWindow, 1_000_000, 'an invalid setting is no setting');
  assert.equal(liveRoute({ url: 'https://api.deepseek.com', name: 'deepseek-chat', key: 'k' }, { localContextWindow: 262144 }).contextWindow, 1_000_000);
  // The window is what the adapter tells dsh (context relief and compaction read it).
  return createRouteAdapter(liveRoute(local, { localContextWindow: 262144 }), 'rulith-live-test').then(async (adapter) => {
    const info = await adapter.resolveModel('rulith-live-test', 'qwen');
    assert.equal(info.context.contextWindow, 262144);
  });
});

test('the launcher\'s line for an Agent names its model source, id and endpoint, never a key', async () => {
  const { modelLine, attachedAgents } = await import('../../harness/web/model-runtime.mjs');
  assert.equal(modelLine('One', { source: 'override', url: 'https://api.deepseek.com', name: 'deepseek-reasoner', key: SECRET }),
    'Deep Rulith: Agent One uses its own model: deepseek-reasoner at https://api.deepseek.com.');
  assert.equal(modelLine('Two', { source: 'default', url: 'http://127.0.0.1:8080/v1/', name: 'qwen', key: '' }),
    'Deep Rulith: Agent Two uses the account default model: qwen at http://127.0.0.1:8080/v1.');
  assert.match(modelLine('Three', { source: 'default', url: '', name: '', key: '' }), /Agent Three has no usable model yet/);
  assert.equal(modelLine('One', { source: 'override', url: 'https://api.deepseek.com', name: 'x', key: SECRET }).includes(SECRET), false);
  assert.deepEqual(attachedAgents('Z:/nowhere', null), []);
});

test('saving a model goes through the manager for the signed-in account and answers without the key', async (t) => {
  const dir = home(t);
  const sent = [];
  const state = { device: { state: 'linked', origin: ACCOUNT.origin, account: { id: ACCOUNT.accountId }, agents: [{ id: 'agent-1' }, { id: 'agent-3' }] },
    instances: [{ id: 'own', agentId: 'agent-1', mode: 'local_agent', signedOutAt: '' }] };
  const manager = async (route, body) => { sent.push([route, body]); return route === '/manager/state' ? state : {}; };
  const read = (agentId) => { const account = signedInAccount(dir); return { account, model: effectiveModel({ home: dir }, account, agentId) }; };
  const routes = modelRoutes({ manager, read });
  const guard = { expectedOrigin: ACCOUNT.origin, expectedAccountId: ACCOUNT.accountId };
  const saved = await routes.save({ ...guard, url: 'https://api.deepseek.com', name: 'deepseek-chat', key: SECRET });
  assert.deepEqual(sent[1], ['/manager/model/default', { ...guard, url: 'https://api.deepseek.com', name: 'deepseek-chat', key: SECRET }]);
  assert.equal(saved.applies, 'next_turn');
  assert.equal(JSON.stringify(saved).includes(SECRET), false);
  await routes.save({ ...guard, agentId: 'agent-1', source: 'override', url: 'http://127.0.0.1:9000/v1', name: 'local' });
  assert.deepEqual(sent.at(-1), ['/manager/instances/model', { instanceId: 'own', source: 'custom', ...guard, url: 'http://127.0.0.1:9000/v1', name: 'local' }]);
  await routes.save({ ...guard, agentId: 'agent-1', source: 'default', url: 'ignored' });
  assert.deepEqual(sent.at(-1), ['/manager/instances/model', { instanceId: 'own', source: 'default', ...guard }]);
  await assert.rejects(routes.save({ ...guard, agentId: 'agent-3', source: 'override' }), (error) => error.errorCode === 'agent_not_set_up');
  await assert.rejects(routes.save({ ...guard, expectedAccountId: 'acct-other', url: 'x', name: 'y' }), (error) => error.errorCode === 'account_changed');
  await assert.rejects(modelRoutes({ manager, read, defaultsElsewhere: true }).save({ ...guard, url: 'x', name: 'y' }),
    (error) => error.errorCode === 'model_defaults_elsewhere');
  const got = await routes.get({ agentId: 'agent-1' });
  assert.equal(got.model.source, 'override');
  assert.equal(JSON.stringify(got).includes(SECRET), false);
});

/**
 * A stand-in for dsh's plugin context and one Agent of conversation `s-1`: the agent's `agent/pre-step` and
 * `agent/request` waterfalls, the plugin's `llm/stream` waterfall and other listeners, and the LLM adapter registry.
 * `header` is the route dsh logged last for the conversation (`session.requestHeader()`).
 */
function fakeDsh() {
  const registered = new Map(), listeners = new Map(), disposed = [];
  const ctx = {
    llm: { registerAdapter: (providers, adapter) => {
      for (const id of providers) { assert.equal(registered.has(id), false, `${id} registered twice`); registered.set(id, adapter); }
      return () => { for (const id of providers) { registered.delete(id); disposed.push(id); } };
    } },
    on: (event, fn) => listeners.set(event, fn),
  };
  const dsh = { ctx, registered, disposed, listeners, header: undefined };
  const agent = { session: { id: 's-1', requestHeader: () => dsh.header },
    ctx: { handlers: {}, on(event, fn, options) { assert.deepEqual(options, { prepend: true }); (this.handlers[event] ??= []).push(fn); } } };
  Object.assign(dsh, { agent,
    created: () => listeners.get('agent/created')({ agent }),
    preStep: (turn) => agent.ctx.handlers['agent/pre-step'][0]({ turn, step: 1 }, async () => ({ kind: 'enter' })),
    request: (turn, proposed = { provider: 'rulith-model', model: 'launch-model', reasoningEffort: 'high', maxTokens: 9 }) =>
      agent.ctx.handlers['agent/request'][0]({ turn, step: 1 }, async () => proposed),
    idle: () => listeners.get('agent/status')({ agent, status: 'idle' }),
    // One request through the `llm/stream` listener: what it sent on (`stream`, re-entering the waterfall) or let pass (`next`).
    side: async (options) => {
      const sent = [];
      const runtime = { stream: (request) => (async function* () { sent.push(['stream', request]); })() };
      const next = () => (async function* () { sent.push(['next', options]); })();
      for await (const _ of listeners.get('llm/stream').call(runtime, options, next)) { /* drained */ }
      return sent;
    } });
  return dsh;
}

test('every turn uses the model saved for its Agent; a running turn keeps its model and key; another account\'s key is never used', async () => {
  const dsh = fakeDsh();
  let model = { source: 'default', url: 'https://api.deepseek.com', name: 'deepseek-chat', key: 'key-x' };
  const built = [];
  const live = installLiveModels(dsh.ctx, { routeFor: () => ({ account: ACCOUNT, model }),
    createAdapter: async (route, id) => { built.push([id, route.key]); return { id }; } });
  assert.equal(live.installed, true);
  dsh.created();
  const first = await dsh.request(1);
  assert.match(first.provider, /^rulith-live-[0-9a-f]{12}$/);
  assert.deepEqual([first.model, first.maxTokens, Object.hasOwn(first, 'reasoningEffort')], ['deepseek-chat', 9, false]);
  assert.equal(live.searchKeyFor(dsh.agent), 'key-x', 'DeepSeek\'s own API: web search may use its key');
  // Saved mid-turn: the turn's later steps stay on X (ACC-LOCAL-10).
  model = { source: 'default', url: 'http://127.0.0.1:8080/v1', name: 'qwen', key: '' };
  assert.deepEqual(await dsh.request(1), first);
  // The next turn uses Y.
  const second = await dsh.request(2);
  assert.notEqual(second.provider, first.provider);
  assert.equal(second.model, 'qwen');
  assert.equal(live.searchKeyFor(dsh.agent), '', 'a model that is not DeepSeek\'s API gives web search no key');
  // A key change under the same endpoint and model is a new route generation; the earlier one stays registered.
  model = { source: 'default', url: 'https://api.deepseek.com', name: 'deepseek-chat', key: 'key-y' };
  const third = await dsh.request(3);
  assert.equal(third.provider, `${first.provider}-1`);
  assert.deepEqual(built, [[first.provider, 'key-x'], [second.provider, ''], [third.provider, 'key-y']]);
  assert.ok(dsh.registered.has(first.provider) && dsh.registered.has(third.provider));
  // The same settings again reuse their route: nothing new is built.
  await dsh.request(4);
  assert.equal(built.length, 3);
  // Signed out, or switched to an account with no model: the turn is refused, nothing falls back to an earlier key.
  model = { source: 'default', url: '', name: '', key: '' };
  await assert.rejects(dsh.request(5), /No model is set for this conversation's Agent/);
  // Hosts without dsh's LLM registry (tests, older dsh) are left alone.
  assert.equal(installLiveModels({ on() {} }, { routeFor: () => ({ account: ACCOUNT, model }) }).installed, false);
});

// PSC 0.2.27 ④ with dsh's compaction: dsh compacts at a turn's first step before its first request, measuring and
// summarizing on the route the conversation's log names last. The turn's route is chosen before that, and the
// conversation's compaction and title requests go to it; an account no longer signed in keeps no route.
test('a turn\'s route is chosen before dsh compacts; compaction and title requests follow the conversation; another account keeps no route', async () => {
  const dsh = fakeDsh();
  let account = ACCOUNT;
  let model = { source: 'default', url: 'https://x.example/v1', name: 'model-x', key: 'key-x' };
  const resolved = [];
  const live = installLiveModels(dsh.ctx, { routeFor: () => ({ account, model }),
    createAdapter: async (route, id) => ({ id, key: route.key,
      resolveModel: async (provider, name) => { resolved.push([id, provider, name]); return { provider, id: name, name, context: { contextWindow: 4096 } }; } }) });
  dsh.created();
  // Turn 1: the pre-step (outermost, before dsh's compaction) registers the route; the request uses it.
  await dsh.preStep(1);
  const [x] = [...dsh.registered.keys()];
  assert.match(x, /^rulith-live-[0-9a-f]{12}$/);
  assert.equal((await dsh.request(1)).provider, x);
  dsh.header = { config: { provider: x, model: 'model-x' } };
  // Y saved between turns: turn 2's pre-step registers Y before compaction runs, and the summary dsh asks for with the
  // logged route X is sent to Y (its key); a title likewise.
  model = { source: 'default', url: 'https://y.example/v1', name: 'model-y', key: 'key-y' };
  await dsh.preStep(2);
  const y = [...dsh.registered.keys()].find((id) => id !== x);
  for (const purpose of ['compaction', 'session-title']) {
    const [[how, sent]] = await dsh.side({ purpose, sessionId: 's-1', provider: x, model: 'model-x', messages: [] });
    assert.deepEqual([how, sent.provider, sent.model, sent.purpose], ['stream', y, 'model-y', purpose]);
  }
  assert.equal((await dsh.request(2)).provider, y);
  // Requests on the turn's own route, the agent loop's own requests and unknown conversations pass unchanged.
  for (const options of [{ purpose: 'compaction', sessionId: 's-1', provider: y, model: 'model-y' },
    { sessionId: 's-1', provider: y, model: 'model-y', toolHistory: [] }, { purpose: 'compaction', sessionId: 's-other', provider: x, model: 'model-x' }])
    assert.deepEqual((await dsh.side(options)).map(([how]) => how), ['next']);
  // Between turns (the agent is idle), a compaction the person asks for (/compact) uses the model in force now.
  dsh.idle();
  model = { source: 'default', url: 'https://z.example/v1', name: 'model-z', key: 'key-z' };
  const [[, now]] = await dsh.side({ purpose: 'compaction', sessionId: 's-1', provider: y, model: 'model-y' });
  assert.equal(now.model, 'model-z');
  const z = now.provider;
  // Another account signs in. At the next turn start every route of the previous account is unregistered, so its keys
  // leave memory; the conversation's logged route (the previous account's Y) is then answered by the new account's route,
  // so dsh's compaction can still measure the conversation, and sends its summary there.
  account = { origin: ACCOUNT.origin, accountId: 'acct-b' };
  model = { source: 'default', url: 'https://y.example/v1', name: 'model-y', key: 'key-b' };
  dsh.header = { config: { provider: y, model: 'model-y' } };
  await dsh.preStep(3);
  assert.deepEqual(dsh.disposed.sort(), [x, y, z].sort(), 'the previous account\'s routes are unregistered');
  const b = (await dsh.request(3)).provider;
  assert.equal(b, `${y}-1`, 'the same endpoint and model under another account is another route');
  assert.equal(live.searchKeyFor(dsh.agent), '', 'a model that is not DeepSeek\'s API gives web search no key');
  const alias = dsh.registered.get(y);
  assert.equal(alias.key, undefined, 'the logged id is an alias, not the previous account\'s adapter');
  resolved.length = 0;
  const info = await alias.resolveModel(y, 'model-y');
  assert.deepEqual([info.provider, info.id, info.context.contextWindow], [y, 'model-y', 4096]);
  assert.deepEqual(resolved, [[b, b, 'model-y']], 'measured with the current route');
  const [[, summary]] = await dsh.side({ purpose: 'compaction', sessionId: 's-1', provider: y, model: 'model-y' });
  assert.equal(summary.provider, b);
  // Signing out (the host's periodic check) unregisters everything; nothing of either account stays.
  live.forgetOtherAccounts(null);
  assert.equal(dsh.registered.size, 0);
});

// After a restart the route generations start again at 0, while a conversation's log still names the id an earlier run
// used, which an alias answers here. A route coming round to that id takes the next free one instead: registering it a
// second time (dsh's DUPLICATE_ADAPTER) would fail every turn on that route until the next restart.
test('a provider id an alias answers is never registered for a route as well, whichever generation comes round to it', async () => {
  const createAdapter = async (route, id) => ({ id, key: route.key });
  const x = { source: 'default', url: 'https://x.example/v1', name: 'model-x', key: 'key-1' };
  const routeX = liveRoute(x).id;
  // The previous run logged this route's second generation for the conversation; after the restart its first turn is on
  // the first generation, and the logged id is answered by an alias.
  let dsh = fakeDsh();
  let model = x;
  installLiveModels(dsh.ctx, { routeFor: () => ({ account: ACCOUNT, model }), createAdapter });
  dsh.created();
  dsh.header = { config: { provider: `${routeX}-1`, model: 'model-x' } };
  assert.equal((await dsh.request(1)).provider, routeX);
  assert.equal(dsh.registered.get(`${routeX}-1`).key, undefined, 'the logged id is an alias');
  // A new key: the next generation's id is the alias's, so the route takes the one after it, and every turn works.
  model = { ...x, key: 'key-2' };
  assert.equal((await dsh.request(2)).provider, `${routeX}-2`);
  assert.equal(dsh.registered.get(`${routeX}-2`).key, 'key-2');
  assert.equal(dsh.registered.get(`${routeX}-1`).key, undefined, 'the alias stays');
  assert.equal((await dsh.request(3)).provider, `${routeX}-2`);
  // Generation 0 likewise: the conversation logged this route's own id, and its first turn after the restart is on another
  // model, so an alias answers that id; when the conversation comes back to this model, the route skips it.
  dsh = fakeDsh();
  model = { source: 'default', url: 'https://q.example/v1', name: 'model-q', key: 'key-q' };
  installLiveModels(dsh.ctx, { routeFor: () => ({ account: ACCOUNT, model }), createAdapter });
  dsh.created();
  dsh.header = { config: { provider: routeX, model: 'model-x' } };
  assert.equal((await dsh.request(1)).provider, liveRoute(model).id);
  assert.equal(dsh.registered.get(routeX).key, undefined);
  model = x;
  assert.equal((await dsh.request(2)).provider, `${routeX}-1`);
  assert.equal(dsh.registered.get(`${routeX}-1`).key, 'key-1');
});

test('a conversation\'s turns use only its own Agent\'s model: an Agent not set up here under the account signed in now is refused', async (t) => {
  const dir = home(t);
  writeJson(path.join(dir, 'device.json'), { format: 'rulith-local-device/1', state: 'linked', origin: ACCOUNT.origin,
    account: { id: ACCOUNT.accountId, name: 'Owner' }, agents: [{ id: 'agent-1', name: 'One' }, { id: 'agent-2', name: 'Two' }, { id: 'agent-3', name: 'Three' }] });
  const registry = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  // An Agent of the account signed in before, still set up here under that account.
  registry.instances.push({ id: 'earlier', mode: 'local_agent', agentId: 'agent-a', agentName: 'Alpha', origin: ACCOUNT.origin,
    accountId: 'acct-other', directory: path.join(dir, 'instances', 'own') });
  writeJson(path.join(dir, 'registry.json'), registry);
  assert.deepEqual(conversationModel({ home: dir }, 'agent-1').model,
    { source: 'override', url: 'https://api.deepseek.com', name: 'deepseek-reasoner', key: SECRET }, 'its own model');
  assert.equal(conversationModel({ home: dir }, 'agent-2').model.name, 'qwen', 'the account default it follows');
  assert.equal(conversationModel({ home: dir }, undefined).model.name, 'qwen', 'a conversation without an Agent: the account default');
  // The other account's Agent, or an Agent of this account not set up on this computer: refused, with no model at all.
  for (const [agentId, name] of [['agent-a', 'Alpha'], ['agent-3', 'agent-3']]) {
    const refused = conversationModel({ home: dir }, agentId);
    assert.deepEqual(refused.account, ACCOUNT);
    assert.equal(refused.model, undefined);
    assert.match(refused.refusal, new RegExp(`belongs to Agent ${name}, which is not set up on this computer`));
  }
  assert.match(conversationModel({ home: home(t, { signedIn: false }) }, 'agent-1').refusal, /not set up on this computer/);
  // The live routes: the refused turn and the conversation's compaction send nothing, not even to the route its log names.
  const dsh = fakeDsh();
  let answer = { account: ACCOUNT, model: { source: 'default', url: 'https://x.example/v1', name: 'model-x', key: 'key-x' } };
  installLiveModels(dsh.ctx, { routeFor: () => answer, createAdapter: async (route, id) => ({ id }) });
  dsh.created();
  const before = await dsh.request(1);
  dsh.header = { config: { provider: before.provider, model: 'model-x' } };
  answer = conversationModel({ home: dir }, 'agent-a');
  await assert.rejects(dsh.request(2), /belongs to Agent Alpha/);
  await assert.rejects(dsh.side({ purpose: 'compaction', sessionId: 's-1', provider: before.provider, model: 'model-x', messages: [] }),
    /belongs to Agent Alpha/);
  assert.equal(dsh.registered.has(before.provider), true, 'the same account: its routes stay for its other conversations');
});

test('the host routes a conversation by the Agent recorded for it, attached or not, and refuses it under another account', async (t) => {
  // All I/O is mocked or local: no manager process, no socket to it, no credential of this computer.
  const net = (await import('node:net')).default;
  const { EventEmitter } = await import('node:events');
  const { apply } = await import('../../harness/web/rulith-runtime.mjs');
  const dir = home(t);
  const keyFile = path.join(dir, 'fixture-key.txt');
  fs.writeFileSync(keyFile, 'fixture-manager-key');
  // Recorded for agent-1, which has its own model; no Agent is attached (this home holds no Agent token).
  writeJson(path.join(dir, 'rulith-session-agents.json'), { 's-one': 'agent-1' });
  t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(net, 'connect', (_options, callback) => { const socket = new EventEmitter(); socket.destroy = () => {}; queueMicrotask(callback); return socket; });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, teaching: 'unexpected' }), { status: 404 }));
  const listeners = new Map(), registered = new Map(), effects = [];
  await apply({ on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    effect(fn) { effects.push(fn()); }, tools: { register: () => () => {} }, webServer: { register: () => () => {} },
    llm: { registerAdapter: (ids, adapter) => { for (const id of ids) registered.set(id, adapter); return () => { for (const id of ids) registered.delete(id); }; } } },
  { managerHome: dir, runtimeEntry: 'fixture-runtime', keyFile, shadow: { enabled: false } });
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  const agent = { session: { id: 's-one', header: {}, requestHeader: () => undefined },
    ctx: { handlers: {}, on(event, fn) { (this.handlers[event] ??= []).push(fn); } } };
  for (const fn of listeners.get('agent/created')) fn({ agent });
  const request = (turn) => agent.ctx.handlers['agent/request'][0]({ turn, step: 1 }, async () => ({ provider: 'rulith-model', model: 'launch-model' }));
  assert.equal((await request(1)).model, 'deepseek-reasoner', 'agent-1\'s own model, not the account default (qwen)');
  // Another account signs in on this computer: the conversation's Agent is not one of its Agents.
  await fs.promises.writeFile(path.join(dir, 'device.json'), JSON.stringify({ format: 'rulith-local-device/1', state: 'linked',
    origin: ACCOUNT.origin, account: { id: 'acct-b', name: 'Other' }, agents: [{ id: 'agent-b', name: 'B' }] }));
  await fs.promises.writeFile(path.join(dir, 'model-defaults.json'), JSON.stringify({ version: 1, defaults: [
    { origin: ACCOUNT.origin, accountId: 'acct-b', url: 'https://b.example/v1', name: 'model-b', key: 'key-b' }] }));
  await assert.rejects(request(2), /belongs to Agent agent-1, which is not set up on this computer/);
  assert.equal([...registered.keys()].length, 0, 'nothing of either account is serving this conversation');
});

test('a live route reaches the saved endpoint with the saved key and model, and only there', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, apiKey: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
      if (req.url !== '/v1/chat/completions') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"stand-in"}}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (choice) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen', choices: [choice] })}\n\n`;
      res.end(chunk({ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null })
        + chunk({ index: 0, delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const stream = async (model) => {
    const route = liveRoute(model);
    const adapter = await createRouteAdapter(route, route.id);
    const chunks = [];
    try {
      for await (const chunk of adapter.stream({ provider: route.id, model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] })) chunks.push(chunk);
    } catch (error) { chunks.push({ error: error.message }); }
    return chunks;
  };
  const chunks = await stream({ url: `${base}/v1`, name: 'qwen', key: SECRET });
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].auth, `Bearer ${SECRET}`);
  assert.equal(seen[0].body.model, 'qwen');
  assert.ok(JSON.stringify(chunks).includes('pong'), JSON.stringify(chunks).slice(0, 400));
  // A Chat Completions URL is the same route; a Messages URL speaks Anthropic's protocol with its key header.
  await stream({ url: `${base}/v1/chat/completions`, name: 'qwen', key: SECRET });
  assert.equal(seen[1].url, '/v1/chat/completions');
  await stream({ url: `${base}/v1/messages`, name: 'claude-test', key: SECRET });
  assert.match(seen[2].url, /^\/v1\/messages(\?|$)/);
  assert.equal(seen[2].apiKey, SECRET);
  assert.equal(seen[2].body.model, 'claude-test');
  // A loopback model without a key still sends a placeholder, never another route's key.
  await stream({ url: `${base}/v1`, name: 'qwen', key: '' });
  assert.equal(seen[3].auth, 'Bearer local');
});

test('the host serves setup and model on its guarded API; choosing an Agent not set up here sets it up first', async (t) => {
  // All I/O is mocked or local: no manager process, no socket to it, no credential of this computer.
  const net = (await import('node:net')).default;
  const { EventEmitter } = await import('node:events');
  const { apply } = await import('../../harness/web/rulith-runtime.mjs');
  const dir = home(t);
  const keyFile = path.join(dir, 'fixture-key.txt');
  fs.writeFileSync(keyFile, 'fixture-manager-key');
  t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(net, 'connect', (_options, callback) => { const socket = new EventEmitter(); socket.destroy = () => {}; queueMicrotask(callback); return socket; });
  const state = { device: { state: 'linked', origin: ACCOUNT.origin, account: { id: ACCOUNT.accountId, name: 'Owner' },
    agents: [{ id: 'agent-1', name: 'One' }, { id: 'agent-2', name: 'Two' }] },
    instances: [{ id: 'own', agentId: 'agent-1', mode: 'local_agent', paired: true, signedOutAt: '' }] };
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const route = new URL(url).pathname, body = init?.body ? JSON.parse(init.body) : undefined;
    sent.push([route, body]);
    if (route === '/manager/state') return new Response(JSON.stringify({ ok: true, ...state }));
    if (route === '/manager/instances/setup-local') {
      const requestId = body?.requestId ?? new URL(url).searchParams.get('requestId');
      return new Response(JSON.stringify({ ok: true, setup: { requestId, agentId: body?.agentId ?? 'agent-2', mode: body?.mode ?? 'setup', state: 'done',
        connectionId: 'conn-2', connectionDisposition: 'created', steps: [{ name: 'ready', state: 'done', reason: 'Done.' }] }, ...state }));
    }
    return new Response(JSON.stringify({ ok: false, teaching: 'unexpected' }), { status: 404 });
  });
  let server;
  const effects = [];
  await apply({ on() {}, effect(fn) { effects.push(fn()); }, tools: { register: () => () => {} }, webServer: { register(route) { server = route; return () => {}; } } },
    { managerHome: dir, runtimeEntry: 'fixture-runtime', keyFile, shadow: { enabled: false } });
  t.after(() => { for (const dispose of effects.reverse()) dispose?.(); });
  const call = async (method, route, body) => {
    const req = new EventEmitter();
    Object.assign(req, { method, url: '/rulith/api/' + route, headers: { host: '127.0.0.1:3080', 'x-deep-rulith': '1' } });
    let reply;
    const done = server.handler(req, { writeHead() {}, end(text) { reply = JSON.parse(text); } });
    queueMicrotask(() => { if (body) req.emit('data', JSON.stringify(body)); req.emit('end'); });
    await done;
    return reply;
  };
  sent.length = 0;
  const started = await call('POST', 'setup', { agentId: 'agent-2', requestId: 'setup-host-0001' });
  assert.deepEqual([started.ok, started.state, started.connectionDisposition], [true, 'done', 'created']);
  assert.deepEqual(sent[0], ['/manager/instances/setup-local', { requestId: 'setup-host-0001', agentId: 'agent-2', mode: 'setup' }]);
  assert.equal((await call('GET', 'setup?requestId=setup-host-0001')).state, 'done');
  const model = await call('GET', 'model?agentId=agent-1');
  assert.deepEqual([model.model.source, model.model.modelId, model.model.keyConfigured], ['override', 'deepseek-reasoner', true]);
  assert.equal(JSON.stringify(model).includes(SECRET), false, 'the key never reaches the page');
  // The settings page's 「在本机设置」 for an Agent already set up here runs the same operation in repair mode; nothing else
  // is accepted as a mode, and no reconnect-or-create choice exists.
  sent.length = 0;
  const repaired = await call('POST', 'setup', { agentId: 'agent-1', mode: 'repair', requestId: 'setup-host-0002' });
  assert.equal(repaired.ok, true, repaired.teaching);
  assert.deepEqual(sent[0], ['/manager/instances/setup-local', { requestId: 'setup-host-0002', agentId: 'agent-1', mode: 'repair' }]);
  await call('POST', 'setup', { agentId: 'agent-2', mode: 'rewrite', requestId: 'setup-host-0003' });
  assert.deepEqual(sent.at(-1)[1], { requestId: 'setup-host-0003', agentId: 'agent-2', mode: 'setup' });
  assert.equal(sent.some(([, body]) => body && Object.hasOwn(body, 'newConnection')), false);
  // The Agent radio list and the Worker checkbox are gone from the page, and so are their routes.
  for (const route of ['select', 'worker']) assert.match((await call('POST', route, { agentId: 'agent-1' })).teaching, /No such/);
  // The account entry: the account, this computer and each Agent's state here; no selection, Connection or tool count.
  const summary = await call('GET', 'state');
  assert.deepEqual(Object.keys(summary).sort(), ['account', 'agents', 'computer', 'deviceState', 'ok', 'origin', 'signedIn', 'teaching']);
  assert.deepEqual(summary.agents.map((agent) => Object.keys(agent).sort()), [['id', 'name', 'paired', 'worker'], ['id', 'name', 'paired', 'worker']]);
});

// Installed-dsh contract (ACC-LOCAL-10): dsh's real agent loop, LlmRuntime and agent/request waterfall, with dsh's own
// pi-ai adapter speaking to local stand-in model servers. A model saved during a turn is used from the next turn; the
// running turn's later steps stay on the model and key it started with.
test('installed dsh: a turn finishes on the model it started with, and the next turn uses the newly saved one', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async (t) => {
  const { pathToFileURL } = await import('node:url');
  const root = path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai');
  const load = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib/index.js')));
  const kernel = ['cordis-plugin-timer', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop'];
  const [cordis, ...plugins] = await Promise.all(['cordis', ...kernel].map(load));
  const { createUserMessage } = plugins[1];
  const seen = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      seen.push({ url: req.url, auth: req.headers.authorization, model: request.model });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (choice) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: request.model, choices: [choice] })}\n\n`;
      // The first request of the first turn asks for a tool; every other request answers in text.
      if (calls++ === 0) {
        res.end(chunk({ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function',
          function: { name: 'save_model', arguments: '{}' } }] }, finish_reason: null })
          + chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
      } else {
        res.end(chunk({ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null })
          + chunk({ index: 0, delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = new cordis.Context();
  const config = { 'dsh-system-prompt': { includeHarnessIdentity: false, includeRuntimeContext: false }, 'dsh-agent-loop': { agents: [] } };
  for (const [index, name] of kernel.entries()) await ctx.plugin(plugins[index].default, config[name] ?? {});
  let model = { source: 'default', url: `${base}/x/v1`, name: 'model-x', key: 'key-x' };
  const live = installLiveModels(ctx, { routeFor: () => ({ account: ACCOUNT, model }) });
  assert.equal(live.installed, true);
  // Saving Y while turn 1 is between its two requests: what the person does in the app's settings during a turn.
  ctx.tools.register({ name: 'save_model', description: 'stand-in for saving a model', parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: () => [{ type: 'text', text: 'saved' }] },
    async execute() { model = { source: 'default', url: `${base}/y/v1`, name: 'model-y', key: 'key-y' }; return 'saved'; } });
  // The conversation starts on the launch route; every request is routed to the live one.
  const handle = await ctx.agents.create({ sessionId: 'live-model-integration', agentOptions: { provider: 'rulith-model', model: 'launch-model' } });
  try {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
  } finally {
    await handle.dispose();
  }
  assert.deepEqual(seen.map(({ url, auth, model: id }) => [url, auth, id]), [
    ['/x/v1/chat/completions', 'Bearer key-x', 'model-x'],
    ['/x/v1/chat/completions', 'Bearer key-x', 'model-x'],
    ['/y/v1/chat/completions', 'Bearer key-y', 'model-y'],
  ]);
});

// Installed-dsh contract (ACC-LOCAL-10 with dsh's compaction): dsh's real agent loop, token meter and step compaction
// (compaction-basic) with scripted adapters per route. dsh compacts at a turn's first step, before the turn's first
// request, measuring and summarizing on the route the conversation logged last. After a model change, and after an
// account switch (the previous account's routes unregistered, as after a restart), the compaction is measured against the
// new turn's route and its summary is made there, with that route's key; nothing reaches the earlier route.
test('installed dsh: after a model change or an account switch, step compaction measures and summarizes on the new turn\'s route', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const { pathToFileURL } = await import('node:url');
  const root = path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai');
  const load = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib/index.js')));
  const kernel = ['cordis-plugin-timer', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent',
    'dsh-agent-loop', 'dsh-token-meter', 'dsh-compaction-basic'];
  const [cordis, ...plugins] = await Promise.all(['cordis', ...kernel].map(load));
  const { LlmAdapter, createUserMessage } = plugins[1];
  const ctx = new cordis.Context();
  const config = { 'dsh-system-prompt': { includeHarnessIdentity: false, includeRuntimeContext: false }, 'dsh-agent-loop': { agents: [] },
    // Compaction at half of a 4096-token window, with no headroom, so one long message crosses it.
    'dsh-compaction-basic': { thresholdRatio: 0.5, headroomTokens: 0, maxTokens: 512 } };
  for (const [index, name] of kernel.entries()) await ctx.plugin(plugins[index].default, config[name] ?? {});
  const seen = [];
  // One scripted adapter per route: it records which route served each request, with which key and for what.
  const createAdapter = async (route, providerId) => new (class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: route.contextWindow } }; }
    async *stream(options) {
      seen.push([providerId, route.model, route.key, options.purpose ?? 'turn']);
      const text = options.purpose === 'compaction' ? 'Summary of the earlier messages.' : 'done';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  })();
  // Models on this computer (loopback), so the launcher's localContextWindow is their window.
  let account = ACCOUNT;
  let model = { source: 'default', url: 'http://127.0.0.1:9/x/v1', name: 'model-x', key: 'key-x' };
  const live = installLiveModels(ctx, { routeFor: () => ({ account, model }), createAdapter, localContextWindow: 4096 });
  const handle = await ctx.agents.create({ sessionId: 'live-model-compaction', agentOptions: { provider: 'rulith-model', model: 'launch-model' } });
  const say = async (text) => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
  };
  // About 4500 tokens: above the 2048-token line by itself. About 1000: enough for dsh to keep it as the recent tail, so
  // what comes before it can be compacted (a lone message, or the newest one, never is).
  const long = (tag) => `${tag} `.repeat(3000);
  const medium = (tag) => `${tag} `.repeat(600);
  const served = () => seen.splice(0).map(([, name, key, purpose]) => [name, key, purpose]);
  // A turn whose step compaction ran (once, or again while still above the line), then its request: all on one route.
  const onRoute = (requests, name, key) => {
    assert.ok(requests.every(([n, k]) => n === name && k === key), JSON.stringify(requests));
    assert.deepEqual([requests[0]?.[2], requests.at(-1)?.[2]], ['compaction', 'turn'], JSON.stringify(requests));
  };
  try {
    await say(long('first'));
    await say(medium('second'));
    assert.deepEqual(served(), [['model-x', 'key-x', 'turn'], ['model-x', 'key-x', 'turn']], 'nothing compactable yet');
    // Y saved between turns: turn 3's step compaction (before its first request) summarizes on Y with Y's key, though the
    // log names X; then the turn runs on Y.
    model = { source: 'default', url: 'http://127.0.0.1:9/y/v1', name: 'model-y', key: 'key-y' };
    await say(long('third'));
    onRoute(served(), 'model-y', 'key-y');
    // Another account with its own key: the previous account's routes are unregistered at turn 4's start (as after a
    // restart, nobody serves the route the log names), so that route is answered by the new one: the compaction is
    // measured and summarized there.
    account = { origin: ACCOUNT.origin, accountId: 'acct-b' };
    model = { source: 'default', url: 'http://127.0.0.1:9/z/v1', name: 'model-z', key: 'key-b' };
    live.forgetOtherAccounts(account);   // the host's periodic check saw the new account first
    await say('fourth');
    onRoute(served(), 'model-z', 'key-b');
    const providers = ctx.llm.listProviders().map((row) => row.id).filter((id) => id.startsWith('rulith-live-'));
    assert.equal(providers.length, 2, 'the new route, and the logged route answered by it; none of the previous account.');
  } finally {
    await handle.dispose();
  }
});

test('web search takes its key from the turn\'s model: DeepSeek\'s own API only, never a key captured at launch', async () => {
  const { installLiveSearch } = await import('../../harness/web/model-runtime.mjs');
  const dsh = fakeDsh();
  let model = { source: 'default', url: 'https://api.deepseek.com', name: 'deepseek-chat', key: 'deepseek-key' };
  const live = installLiveModels(dsh.ctx, { routeFor: () => ({ account: ACCOUNT, model }), createAdapter: async (route, id) => ({ id }) });
  dsh.created();
  let provider;
  const ctx = { inject: (names, callback) => { assert.deepEqual(names, ['web']);
      callback({ effect: (fn) => fn(), web: { registerSearchProvider: (registered) => { provider = registered; return () => {}; } } }); },
    get: (name) => (name === 'agents' ? { currentInitiator: () => dsh.agent } : undefined) };
  assert.equal(await installLiveSearch(ctx, live), true);
  assert.equal(provider.id, 'deepseek-official', 'the provider the web profile selects');
  await dsh.request(1);
  assert.equal(await provider.resolveOptions().resolveApiKey(), 'deepseek-key');
  assert.equal(provider.resolveOptions().baseURL, 'https://api.deepseek.com/anthropic/v1');
  // The account switched to a model that is not DeepSeek's API: the next turn's searches have no key at all.
  model = { source: 'default', url: 'http://127.0.0.1:8080/v1', name: 'qwen', key: '' };
  await dsh.request(2);
  assert.equal(await provider.resolveOptions().resolveApiKey(), undefined);
  assert.equal(provider.resolveOptions().apiKeyEnv, 'RULITH_DSH_WEB_SEARCH_KEY', 'dsh\'s own missing-key words, as before');
});
