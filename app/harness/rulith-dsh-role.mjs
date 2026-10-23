import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RulithMcp, surfaceAccepted } from './rulith-mcp.mjs';
import { webSearchKey } from './web-tools.mjs';
import { inside, killTree, readJson, save } from './host-utils.mjs';

export const CAPS = Object.freeze({ steps: 150, wallMs: 90 * 60 * 1000, promptTokens: 25000000 });
// The model is the one set in the Runtime manager; there is no default provider.
const requiredModel = (value) => { if (!value) throw new Error('no model is set in the Runtime manager'); return value; };
export function parseArgs(argv) {
  const input = [...argv]; if (input.at(-1) === '--serve') input.pop();
  const options = {};
  for (let i=0;i<input.length;i++) {
    const flag = input[i];
    if (!['--dsh-entry','--dsh-home','--cwd','--persona','--task','--session-id'].includes(flag) || options[flag.slice(2)] !== undefined || i+1 === input.length) throw new Error('wrapper arguments refused');
    options[flag.slice(2)] = input[++i];
  }
  for (const flag of ['dsh-entry','dsh-home','cwd','persona']) if (!options[flag] || !path.isAbsolute(options[flag])) throw new Error('wrapper paths required');
  return options;
}
export function dshArgv(options, task, sessionId) {
  const args = [options['dsh-entry'], '--profile', 'rulith-agent', '--patch', fileURLToPath(new URL('./rulith.cordis.yml', import.meta.url)), '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  // stdin avoids command-line limits and option interpretation of the task.
  return args;
}
export class Budget {
  constructor(caps = CAPS, now = Date.now) { this.caps = caps; this.now = now; this.started = now(); this.steps = 0; this.promptTokens = 0; }
  event(event) {
    if (this.now()-this.started >= this.caps.wallMs) return 'wall time cap';
    if (event.type === 'status' && event.phase === 'step_start') {
      if (this.steps >= this.caps.steps) return 'step cap';
      this.steps++;
    }
    if (event.type === 'status' && event.phase === 'step_end') {
      if (!Number.isSafeInteger(event.usage?.inputTokens) || event.usage.inputTokens < 0) return 'prompt usage missing';
      const read = event.usage.cacheReadTokens ?? 0; const write = event.usage.cacheWriteTokens ?? 0;
      if (![read,write].every(value => Number.isSafeInteger(value) && value>=0)) return 'prompt usage missing';
      let prompt = event.usage.inputTokens + read + write;
      if (event.usage.totalTokens !== undefined && event.usage.outputTokens !== undefined) {
        if (![event.usage.totalTokens,event.usage.outputTokens].every(value=>Number.isSafeInteger(value)&&value>=0) || event.usage.totalTokens-event.usage.outputTokens<prompt) return 'prompt usage missing';
        // pi-ai prompt buckets are disjoint; total includes cached prompt too.
        // dsh may omit an optional cache bucket while aggregating retries.
        prompt = event.usage.totalTokens-event.usage.outputTokens;
      }
      this.promptTokens += prompt;
      if (!Number.isSafeInteger(this.promptTokens)) return 'prompt usage missing';
      if (this.promptTokens >= this.caps.promptTokens) return 'prompt token cap';
      if (this.steps >= this.caps.steps) return 'step cap';
    }
    return null;
  }
}
export async function startRole(options, { client, emit = defaultEmit, caps = CAPS, env = process.env, terminate = killTree } = {}) {
  const home = fs.realpathSync(options['dsh-home']); const cwd = fs.realpathSync(options.cwd);
  if (home === cwd || inside(cwd, home) || inside(home, cwd)) throw new Error('separate dsh home and cwd required');
  if (env.RULITH_SOURCE_ACCESS) { const root = fs.realpathSync(env.RULITH_SOURCE_ACCESS); if (inside(root,home) || inside(root,cwd)) throw new Error('dsh directories must be outside Source'); }
  fs.accessSync(options['dsh-entry']); fs.accessSync(options.persona);
  const connection = client ?? new RulithMcp({ url: env.RULITH_DSH_MCP_URL ?? `${(env.RULITH_URL ?? 'https://api.rulith.ai').replace(/\/$/,'')}/mcp`, token: env.RULITH_TOKEN });
  const agentId = await connection.initialize();
  const surface = await connection.list();
  if (!surfaceAccepted(surface)) throw new Error('MCP tool surface refused');
  let active; let stopping = false; let reloading = false;
  const stateFile = path.join(home,'rulith-role-state.json');
  const persisted = readJson(stateFile,{agentId,sessions:[],receipts:[]});
  if (persisted.agentId !== agentId) throw new Error('wrapper state identity refused');
  const sessions = new Map(); const events = []; const receipts = new Map(persisted.receipts);
  for (const [key,data] of persisted.sessions) {
    if (![data.started,data.steps,data.promptTokens].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new Error('wrapper state refused');
    const budget=new Budget(caps);Object.assign(budget,{started:data.started,steps:data.steps,promptTokens:data.promptTokens});
    sessions.set(key,{id:data.id,capped:data.capped,budget});
  }
  if (options['session-id'] && ![...sessions.values()].some(slot=>slot.id===options['session-id'])) throw new Error('resume state required');
  const persist = () => save(stateFile,{agentId,sessions:[...sessions].map(([key,slot])=>[key,{id:slot.id,capped:slot.capped,started:slot.budget.started,steps:slot.budget.steps,promptTokens:slot.budget.promptTokens}]),receipts:[...receipts]});
  const report = (type,data) => { const event = { type, ...data }; events.push(event); if (events.length > 256) events.shift(); emit(type,data); };
  async function run(task, sessionKey = 'default', requestedId) {
    if (active || stopping || reloading) throw new Error('wrapper busy');
    let slot = sessions.get(sessionKey);
    if (!slot) { if(options['session-id'])throw new Error('resume state required'); slot = { budget: new Budget(caps) }; sessions.set(sessionKey,slot); }
    if (slot.capped) throw new Error(slot.capped);
    if (Date.now()-slot.budget.started >= caps.wallMs) { slot.capped='wall time cap'; throw new Error(slot.capped); }
    if (slot.budget.steps >= caps.steps || slot.budget.promptTokens >= caps.promptTokens) throw new Error('session cap');
    const taskId = requestedId ?? randomUUID(); persist();
    const childEnv = { ...env, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native', RULITH_DSH_PROXY: 'ipc', RULITH_DSH_PERSONA: options.persona,
      RULITH_DSH_MODEL: requiredModel(env.RULITH_MODEL), RULITH_DSH_MODEL_BASE: modelBase(requiredModel(env.RULITH_MODEL_URL)) };
    delete childEnv.RULITH_TOKEN; delete childEnv.RULITH_SERVE_KEY;
    // D-1015c: web_search only with DeepSeek's own key (web-tools.mjs); otherwise the overlay leaves it unregistered.
    const searchKey = webSearchKey({ url: env.RULITH_MODEL_URL, key: env.RULITH_MODEL_KEY });
    if (searchKey) childEnv.RULITH_DSH_WEB_SEARCH_KEY = searchKey; else delete childEnv.RULITH_DSH_WEB_SEARCH_KEY;
    const child = spawn(process.execPath, dshArgv(options,task,slot.id), { cwd, env: childEnv, detached: true, windowsHide: true, stdio: ['pipe','pipe','pipe','ipc'] });
    active = { child, taskId };
    const stopChild = async reason => { if (slot.capped) return; slot.capped = reason; persist(); report('cap',{ reason, session: sessionKey, task: taskId }); try { await terminate(child.pid); } catch { failure = 'process tree termination failed'; } };
    const remaining = caps.wallMs - (Date.now()-slot.budget.started);
    const timer = setTimeout(() => void stopChild('wall time cap'), Math.max(1,remaining));
    let pending = ''; let failure;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (Buffer.byteLength(pending) > 1024*1024) { void stopChild('dsh output refused'); return; }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0,end); pending = pending.slice(end+1);
        let event; try { event = JSON.parse(line); } catch { void stopChild('dsh output refused'); continue; }
        if (event.type === 'session') slot.id = event.sessionId;
        const reason = slot.budget.event(event); if (reason) void stopChild(reason);
        persist();
        report('dsh', { session: sessionKey, task: taskId, event });
      }
    });
    // Never forward dsh's startup diagnostics: they may contain credential-bearing config.
    child.stderr.resume();
    child.on('message', async message => {
      if (message?.protocol !== 'rulith-dsh-rpc') return;
      let result; let error;
      try {
        if (message.method === 'identity') result = agentId;
        else if (message.method === 'list') result = await connection.list();
        else if (message.method === 'call') result = await connection.call(message.args.name,message.args.args);
        else throw new Error('tool refused');
      } catch (e) { error = e.message; }
      if (child.connected) child.send({ protocol:'rulith-dsh-rpc', id: message.id, ...(error ? { error } : { result }) });
    });
    child.once('error', () => { failure = 'dsh launch failed'; });
    child.stdin.on('error', () => {}); child.stdin.end(task);
    report('task-start', { id:taskId, session:sessionKey });
    await new Promise(resolve => child.once('close', code => { if (code !== 0 && !slot.capped) failure = 'dsh task failed'; resolve(); }));
    clearTimeout(timer); if (process.platform !== 'win32') await terminate(child.pid); active = undefined; persist();
    report('task-end', { id:taskId, session:sessionKey, reason: failure ?? slot.capped ?? 'completed' });
    if (reloading) await stop();
    return taskId;
  }
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url,'http://127.0.0.1');
    const key = env.RULITH_SERVE_KEY;
    const deny = (code,message) => { res.writeHead(code,{'content-type':'application/json'}); res.end(JSON.stringify({ ok:false,error:message })); };
    if (!key || (req.headers['x-rulith-serve'] !== key && url.searchParams.get('k') !== key) || req.headers.origin) return deny(403,'task access refused');
    if (req.method === 'GET' && url.pathname === '/runs') { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ events, busy:!!active })); return; }
    if (req.method !== 'POST' || url.pathname !== '/task' || !String(req.headers['content-type']).startsWith('application/json')) return deny(400,'task refused');
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of req) { bytes+=chunk.length; if (bytes>65536) return deny(413,'task refused'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks));
      if (typeof body.text !== 'string' || !body.text.trim() || Object.keys(body).some(k => !['text','sessionKey','requestId'].includes(k))) return deny(400,'task refused');
      if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId))) return deny(400,'task refused');
      const sessionKey = body.sessionKey ?? randomUUID();
      if (typeof sessionKey !== 'string' || sessionKey.length>100 || sessions.size>=32 && !sessions.has(sessionKey)) return deny(400,'task refused');
      const fingerprint=createHash('sha256').update(JSON.stringify({text:body.text,sessionKey:body.sessionKey??''})).digest('hex');
      const previous=body.requestId&&receipts.get(body.requestId);
      if(previous){if(previous.fingerprint!==fingerprint)return deny(409,'request changed');res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify(previous.receipt));return;}
      if (active || stopping || reloading) return deny(409,'wrapper busy');
      if (sessions.get(sessionKey)?.capped) return deny(409,sessions.get(sessionKey).capped);
      const budget=sessions.get(sessionKey)?.budget;
      if(budget&&(Date.now()-budget.started>=caps.wallMs||budget.steps>=caps.steps||budget.promptTokens>=caps.promptTokens))return deny(409,'session cap');
      const id=randomUUID();const receipt={ok:true,id,sessionKey};
      if(body.requestId){receipts.set(body.requestId,{fingerprint,receipt});if(receipts.size>256)receipts.delete(receipts.keys().next().value);persist();}
      void run(body.text,sessionKey,id).catch(() => report('error',{ reason:'dsh launch failed' }));
      res.writeHead(202,{'content-type':'application/json'}); res.end(JSON.stringify(receipt));
    } catch { deny(400,'task refused'); }
  });
  const port = Number(env.RULITH_SERVE_PORT ?? 7799);
  if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('task port refused');
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
  async function stop() {
    if (stopping) return; stopping = true;
    let failure;
    if (active) { try { await terminate(active.child.pid); } catch (e) { failure=e; active.child.stdout.destroy(); active.child.stderr.destroy(); if(active.child.connected)active.child.disconnect(); } }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); connection.close();
    if (failure) throw failure;
  }
  async function control(message) {
    if (message?.protocol !== 'rulith-local-control') return;
    if (message.operation === 'stop') await stop();
    if (message.operation === 'reload') { reloading = true; if (!active) await stop(); }
  }
  report('start',{ agentId, managedStop:true, concurrency:1 });
  return { run,stop,control,server,sessions };
}
function modelBase(raw) {
  const url = new URL(raw);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('model endpoint refused');
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/,''); return url.toString().replace(/\/$/,'');
}
function defaultEmit(type,data) {
  const event = { t:Date.now(),src:'agent',type,...data };
  if (process.send) process.send({ protocol:'rulith-local-event', event }); else process.stdout.write(`${JSON.stringify(event)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2)); const role = await startRole(options);
    const failed = () => { process.stderr.write('wrapper failed\n'); process.exitCode=2; };
    process.on('message', message => void role.control(message).catch(failed));
    process.on('disconnect', () => void role.stop().catch(failed));
    process.on('SIGINT', () => void role.stop().catch(failed)); process.on('SIGTERM', () => void role.stop().catch(failed));
    if (options.task) { try { await role.run(options.task); } finally { await role.stop(); } }
  } catch { process.stderr.write('wrapper failed\n'); process.exitCode = 2; }
}
