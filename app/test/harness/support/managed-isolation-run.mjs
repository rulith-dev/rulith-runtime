// ACC-ISO-08 driver: the managed product path, end to end, in a throwaway account home. Spawned by
// model-command-isolation.test.mjs with USERPROFILE/HOME/LOCALAPPDATA pointing into a temporary directory and WITHOUT
// RULITH_ADAPTER_SANDBOX (so confinement is the product default). Every label is applied by product code — the app
// (appSettings), the manager (createManagerServer → createInstanceManager, at its start), the instance host (before it
// starts the Worker) and the project-open store (labelProjectOpen) — never by this script. The manager is signed in and
// paired against the devices test gateway; its Worker is then pointed at a fake Work endpoint served here, claims one
// real eng.run, and the command (a project script) tries to read the credential files by code. Writes <base>/result.json.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = process.argv[2];
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const at = (rel) => pathToFileURL(path.join(repo, rel)).href;
const { appSettings } = await import(at('app/harness/web/app-home.mjs'));
const { createManagerServer } = await import(at('local/manager-server.mjs'));
const { loadInstanceConfig, saveInstanceConfig } = await import(at('local/instance-manager.mjs'));
const { installGeneralForInstance } = await import(at('kits/general/installer.mjs'));
const { labelProjectOpen } = await import(at('local/sandbox-home-label.mjs'));
const { workRootFor } = await import(at('worker/adapter-confinement.mjs'));
const { createDevicesGateway } = await import(at('test/support/local-devices-gateway.mjs'));
const { actionRow, activeLease, grantFor, signGrant, CONNECTION, CONNECTION_KEY } = await import(at('test/support/worker-harness.mjs'));

const result = { steps: [] };
const done = (extra = {}) => { fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ ...result, ...extra }, null, 2)); };
const label = (p) => {
  try {
    const line = execFileSync('icacls', [p], { encoding: 'latin1', windowsHide: true }).split(/\r?\n/).find((l) => /Mandatory Level/i.test(l));
    return line ? line.slice(line.indexOf('Mandatory Label')).trim() : '(none)';
  } catch { return '(missing)'; }
};
const cleanup = [];
try {
  // 1. The app: app home, manager key, its label (product: appSettings). The launcher hands its roots on.
  const appHome = path.join(process.env.USERPROFILE ?? process.env.HOME, '.rulith', 'app');
  const settings = await appSettings(appHome, { ports: async () => [0, 0] });
  process.env.RULITH_CREDENTIAL_ROOTS = JSON.stringify([settings.dshHome, appHome]);
  result.steps.push('app');
  // 2. The manager (product: createManagerServer; it labels its home, the backstop and the app's roots at start),
  //    signed in to the devices test gateway, and one Agent paired.
  const gateway = createDevicesGateway();
  await gateway.listen(); cleanup.push(() => gateway.close());
  const manager = createManagerServer({ root: settings.managerHome, port: 0, key: randomUUID().replace(/-/g, ''), startConfirmMs: 8000 });
  await manager.listen(); cleanup.unshift(() => manager.close());
  const started = await manager.device.start({ consoleUrl: gateway.origin, name: 'Isolation computer' });
  gateway.approve(started.code, ['agent-alpha']);
  await manager.device.poll();
  const instance = await manager.instances.create({ name: 'iso' });
  await manager.instances.pair(instance.id, { agentId: 'agent-alpha' });
  await manager.instances.closeHost(instance.id);
  const directory = instance.directory, workRoot = workRootFor(instance.id);
  result.steps.push('instance');
  // 3. The general kit, into the work root the product chose for this instance (the kit op's own rule).
  installGeneralForInstance({ directory, kitHome: path.join(workRoot, 'kit') });
  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  // 4. Secrets that appear AFTER every label: a model-defaults file, a temp file, a backup, and local.json itself rewritten
  //    atomically (product saveInstanceConfig) right before the Worker starts. All must inherit the no-read-up label.
  fs.writeFileSync(path.join(settings.managerHome, 'model-defaults.json'), JSON.stringify({ key: 'PROVIDER-KEY-SECRET' }));
  fs.writeFileSync(path.join(directory, 'local.json.tmp'), 'TEMP-SECRET');
  fs.mkdirSync(path.join(directory, 'tools-before-environment'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'tools-before-environment', 'worker-secrets.json'), 'BACKUP-SECRET');

  const sources = [{ name: 'project', type: 'file', access: project }];
  let sent = false; const seen = []; const held = [];
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const work = http.createServer((req, res) => {
    if ((req.method ?? 'GET') === 'GET') return send(res, 200, { sources });
    let raw = ''; req.setEncoding('utf8'); req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let op; try { op = JSON.parse(raw).operation ?? {}; } catch { op = {}; }
      seen.push(op.kind);
      if (op.kind === 'Poll') {
        if (sent) return void held.push(res);
        sent = true;
        const digest = (op.tools ?? []).find((t) => t.id === 'eng.run@1')?.digest;
        const row = actionRow({ tool: 'eng.run', toolContractId: 'eng.run@1', toolDigest: digest, sourceRecordId: 'project',
          args: JSON.stringify({ source: 'project', command: 'node probe.mjs', cwd: '.' }),
          toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'eng.run@1', kind: 'run', params: { command: 'string', cwd: 'string' }, sourceTypes: ['file'] }) });
        row.executionGrant = signGrant(grantFor(row, { workerId: op.workerId, workerGeneration: 7 }));
        return send(res, 200, { accepted: true, payload: { work: [row] }, lease: activeLease({ workerId: op.workerId, workerGeneration: 7 }) });
      }
      if (op.kind === 'RenewLease') return send(res, 200, { accepted: true, lease: activeLease({ workerId: op.workerId, workerGeneration: 7 }) });
      return send(res, 200, { accepted: true, revision: 'r1' });
    });
  });
  await new Promise((ready) => work.listen(0, '127.0.0.1', ready));
  cleanup.push(() => { for (const res of held) res.destroy(); work.closeAllConnections(); work.close(); });
  const config = loadInstanceConfig(directory);
  config.roles = ['worker'];
  config.worker = { ...config.worker, enabled: true, env: { ...config.worker.env,
    RULITH_WORK_URL: `http://127.0.0.1:${work.address().port}/work`, RULITH_CONNECTION: CONNECTION, RULITH_CONNECTION_KEY: CONNECTION_KEY } };
  saveInstanceConfig(directory, config);            // the fresh atomic rewrite of local.json
  const kitHome = loadInstanceConfig(directory).worker.env.ENG_KIT_HOME;
  // The kit's command classifier admits `node` from this Node's folder; the SANDBOX is what must stop probe.mjs.
  fs.writeFileSync(path.join(kitHome, 'settings.json'), JSON.stringify({ allowedPaths: [path.dirname(process.execPath)] }));
  // 5. The project folder, opened through the product store (records its prior label, applies Low).
  result.projectOpen = labelProjectOpen({ managerHome: settings.managerHome, directory: project, holder: instance.id });
  const targets = { key: settings.keyFile, local: path.join(directory, 'local.json'), defaults: path.join(settings.managerHome, 'model-defaults.json'),
    tmp: path.join(directory, 'local.json.tmp'), backup: path.join(directory, 'tools-before-environment', 'worker-secrets.json'),
    work: path.join(kitHome, 'probe-work.txt') };
  fs.writeFileSync(path.join(project, 'paths.json'), JSON.stringify(targets));
  fs.writeFileSync(path.join(project, 'probe.mjs'), [
    "import fs from 'node:fs';",
    "const t = JSON.parse(fs.readFileSync('paths.json', 'utf8')), o = {};",
    "for (const name of ['key', 'local', 'defaults', 'tmp', 'backup']) { try { fs.readFileSync(t[name]); o[name] = 'READ'; } catch (e) { o[name] = 'DENIED_' + e.code; } }",
    "try { fs.writeFileSync('out.txt', 'W'); o.project = fs.readFileSync('out.txt', 'utf8'); } catch (e) { o.project = 'FAIL_' + e.code; }",
    "try { fs.writeFileSync(t.work, 'K'); o.work = fs.readFileSync(t.work, 'utf8'); } catch (e) { o.work = 'FAIL_' + e.code; }",
    "fs.writeFileSync('probe-result.json', JSON.stringify(o));",
  ].join('\n'));
  // 6. The host (product) re-verifies the labels and starts the Worker with the managed isolated environment.
  await manager.instances.open(instance.id, '/');
  result.steps.push('host');
  const resultFile = path.join(project, 'probe-result.json');
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 500));
  result.seen = seen;
  result.probe = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  result.events = manager.instances.hosts.get(instance.id)?.host.events().filter((e) => e.src === 'worker').slice(-12)
    .map((e) => String(e.line ?? e.text ?? e.type ?? '').slice(0, 300));
  result.labels = { managerHome: label(settings.managerHome), appHome: label(appHome), backstop: label(path.dirname(appHome)),
    instanceDir: label(directory), localJson: label(targets.local), key: label(targets.key), kitHome: label(kitHome),
    project: label(project), workRoot: label(workRoot) };
  result.layout = { workerRoot: loadInstanceConfig(directory).worker.env.RULITH_WORKER_ROOT, kitHome, workRoot, directory,
    managerHome: settings.managerHome, appHome };
  // 7. Revoked while no Worker ran: the Source disappears, the Worker is stopped and started again; at its first Source
  //    refresh the Worker (product) releases the folder and restores the label it had before it was opened.
  sources.length = 0;
  await manager.instances.stop(instance.id);
  await manager.instances.open(instance.id, '/');
  const restoreBy = Date.now() + 60_000;
  while (label(project) !== '(none)' && Date.now() < restoreBy) await new Promise((r) => setTimeout(r, 250));
  result.projectAfterRevoke = label(project);
  await manager.instances.stop(instance.id);
  await manager.close(); cleanup.shift();
  // 8. An instance left in the old layout (Worker root and kit home inside the credential roots) is moved out by the
  //    next manager start (copy, switch, keep the old copy), and the start after that confirms and removes the old copy.
  const oldWorker = path.join(directory, 'workspace'), oldKit = path.join(appHome, 'kit');
  fs.cpSync(result.layout.workerRoot, oldWorker, { recursive: true });
  fs.writeFileSync(path.join(oldKit, 'old-state.txt'), 'OLD');
  fs.rmSync(workRoot, { recursive: true, force: true });
  const legacy = loadInstanceConfig(directory);
  legacy.worker.env = { ...legacy.worker.env, RULITH_WORKER_ROOT: oldWorker, ENG_KIT_HOME: oldKit };
  saveInstanceConfig(directory, legacy);
  const restart = () => createManagerServer({ root: settings.managerHome, port: 0, key: randomUUID().replace(/-/g, '') });
  const first = restart();
  const moved = loadInstanceConfig(directory);
  result.migration = { workerRoot: moved.worker.env.RULITH_WORKER_ROOT, kitHome: moved.worker.env.ENG_KIT_HOME,
    marker: moved.isolationMigration ?? null, copiedKit: fs.existsSync(path.join(workRoot, 'kit', 'old-state.txt')),
    copiedWorker: fs.existsSync(path.join(workRoot, 'worker', 'adapters', 'engineering-work')),
    oldKept: fs.existsSync(oldWorker) && fs.existsSync(path.join(oldKit, 'old-state.txt')) };
  await first.close();
  const second = restart();
  const confirmed = loadInstanceConfig(directory);
  result.migration.confirmed = { marker: confirmed.isolationMigration ?? null, oldWorkerGone: !fs.existsSync(oldWorker), oldKitGone: !fs.existsSync(oldKit) };
  await second.close();
  done();
} catch (error) {
  done({ error: String(error?.stack ?? error).slice(0, 3000) });
} finally {
  for (const step of cleanup) { try { await step(); } catch { /* best-effort */ } }
}
process.exit(0);
