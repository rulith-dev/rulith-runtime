// Model-command isolation (D-1024a / PSC 0.2.28 ①), Windows backend facts.
//
// 这个文件把本批在 Windows 上实测到的隔离边界钉成回归测试（ACC-ISO-04）：复用 dsh-sandbox-windows-acl 的受限 token
// 后端能把“写”限制在工作区与私有临时目录，但“读”不受限（该包自述如此，本测亦实测）。所以仅靠这个后端堵不住凭据“读”
// 取；真正堵住读需要 AppContainer 或带 NoReadUp 的完整性标签（都要原生 FFI，且 adapter 的实现边界禁止在适配器进程内加载
// 原生插件）。此测记录当前真实行为，给将来的 AppContainer 实现一个回归目标，并证明写约束确实成立。
//
// Windows-only; skips with a clear reason elsewhere or when the backend cannot initialize on this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { credentialRootRefusal, ensureCredentialRootLabels, ensureHomeLabel, ensureLowLabel, homeLabelVerified, labelOps, labelProjectOpen,
  releaseProjectLabel } from '../../../local/sandbox-home-label.mjs';
import { confinedLaunch, adapterSandboxMode, confinementIdentity, credentialRoots, workRootFor } from '../../../worker/adapter-confinement.mjs';
import { adapterEnv } from '../../../worker/rulith-worker.mjs';

const NL = String.fromCharCode(10);
const fwd = (p) => p.split(path.sep).join('/');
const dshModules = process.env.DSH_MODULES_DIR;
let AclSandbox, tempWriteSid, workspaceWriteSid, loadError;
if (process.platform === 'win32' && dshModules) {
  try {
    const url = new URL('@deepseek-ai/dsh-sandbox-windows-acl/', `${new URL('file://')}${dshModules.replace(/\\/g, '/')}/`);
    ({ AclSandbox, tempWriteSid, workspaceWriteSid } = await import(new URL('lib/index.js', url)));
  } catch (error) { loadError = error; }
}
const reason = process.platform !== 'win32' ? 'Windows ACL sandbox is a win32 mechanism'
  : !dshModules ? 'DSH_MODULES_DIR not set (dsh sandbox backend not resolvable)'
  : !AclSandbox ? `dsh-sandbox-windows-acl did not load: ${loadError?.message ?? 'unknown'}` : undefined;

async function confinedProbe(secretPath, secretText) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-acc-')));
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const child = path.join(work, 'child.mjs');
  const lines = [
    "import fs from 'node:fs';",
    "const S=process.env.ISO_SECRET, W=process.env.ISO_WS, NL=String.fromCharCode(10), o=[];",
    "try{o.push('READ='+fs.readFileSync(S,'utf8'))}catch(e){o.push('READ_'+e.code)}",
    "try{fs.writeFileSync(W+'/out.txt','W');o.push('WRITEWS='+fs.readFileSync(W+'/out.txt','utf8'))}catch(e){o.push('WRITEWS_'+e.code)}",
    "try{fs.writeFileSync(S+'.evil','X');o.push('WRITEOUT_OK')}catch(e){o.push('WRITEOUT_'+e.code)}",
    "process.stdout.write(o.join(NL));",
  ];
  fs.writeFileSync(child, lines.join(NL));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-tmp-'));
  const sb = new AclSandbox({ writableDirs: [work], tempDir: temp, writeSid: workspaceWriteSid(work),
    tempWriteSid: tempWriteSid(temp), mode: 'workspace-write' });
  const saved = { s: process.env.ISO_SECRET, w: process.env.ISO_WS };
  try {
    await sb.init();
    // AclSandbox.spawn inherits the parent environment (it does not apply a per-spawn env); the kit's childEnv is what
    // scrubs secrets in production. We set the probe's own two variables on the parent so the child inherits them.
    process.env.ISO_SECRET = secretPath; process.env.ISO_WS = work;
    const c = sb.spawn({ command: process.execPath, args: [child.split('\\').join('/')], cwd: work });
    const r = await c.wait();
    const out = (Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout)).split(NL);
    return Object.fromEntries(out.map((l) => { const i = l.indexOf('='); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; }));
  } finally {
    process.env.ISO_SECRET = saved.s; process.env.ISO_WS = saved.w;
    try { sb.dispose(); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('ACC-ISO-04 the Windows restricted-token backend confines writes to the workspace', { skip: reason }, async () => {
  const secretDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-secret-')));
  const secret = path.join(secretDir, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET');
  try {
    let probe;
    try { probe = await confinedProbe(secret, 'SECRET'); }
    catch (error) { return void test.skip?.(`sandbox unavailable on this host: ${error.message}`); }
    assert.equal(probe.WRITEWS, 'W', 'the confined command may write its own workspace');
    assert.ok(probe.WRITEOUT !== 'OK' && 'WRITEOUT' in probe === false
      ? probe.WRITEOUT_EPERM !== undefined || probe.WRITEOUT_EACCES !== undefined : probe.WRITEOUT_OK === undefined,
      `a write outside the workspace is denied (got ${JSON.stringify(probe)})`);
  } finally { fs.rmSync(secretDir, { recursive: true, force: true }); }
});

// This test PINS THE KNOWN GAP, so it fails (alerting us) if a future change makes it look closed without being verified:
// the restricted-token backend does NOT confine reads. Closing the read path needs AppContainer or a NoReadUp label.
test('ACC-ISO-04 the restricted-token backend does NOT confine reads (documented residual gap)', { skip: reason }, async () => {
  const secretDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-secret-')));
  const secret = path.join(secretDir, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET');
  try {
    let probe;
    try { probe = await confinedProbe(secret, 'SECRET'); }
    catch (error) { return void test.skip?.(`sandbox unavailable on this host: ${error.message}`); }
    assert.equal(probe.READ, 'SECRET',
      'reads are unconfined by this backend; read closure requires AppContainer or a NoReadUp label (see docs/model-command-isolation.md)');
  } finally { fs.rmSync(secretDir, { recursive: true, force: true }); }
});

// ACC-ISO-06 (model-command isolation, D-1024a): the Windows read-closure mechanism end to end. The real label helper
// gives ~/.rulith a Medium no-read-up label; a Low-IL confined child (the dsh runner's token) is then denied reading a
// file in the labeled home — including a file created AFTER labeling (OICI inheritance) — while the normal Medium-IL
// process reads it, and the confined child still reads/writes its own project folder.

test('ACC-ISO-06 a labeled Rulith home is read-denied to a Low-IL command, readable to the Medium owner', { skip: reason }, async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-home6-')));
  const home = path.join(base, 'home'), work = path.join(base, 'work');
  fs.mkdirSync(home); fs.mkdirSync(work);
  fs.writeFileSync(path.join(home, 'before.txt'), 'BEFORE');
  try {
    const res = ensureHomeLabel(home);
    assert.equal(res.ok, true, `label applied: ${JSON.stringify(res)}`);
    assert.equal(homeLabelVerified(home), true, 'label verified by read-back');
    fs.writeFileSync(path.join(home, 'after.txt'), 'AFTER'); // inherits via OICI
    // Medium owner (this process) reads both files.
    assert.equal(fs.readFileSync(path.join(home, 'before.txt'), 'utf8'), 'BEFORE');
    assert.equal(fs.readFileSync(path.join(home, 'after.txt'), 'utf8'), 'AFTER');
    // Low-IL confined child: denied reading both, still writes its workspace.
    const childFile = path.join(work, 'child.mjs');
    const NL = String.fromCharCode(10);
    fs.writeFileSync(childFile, [
      "import fs from 'node:fs';const H=process.env.H,W=process.env.W,NL=String.fromCharCode(10),o=[];",
      "for(const f of ['before.txt','after.txt']){try{o.push(f+'=READ_'+fs.readFileSync(H+'/'+f,'utf8'))}catch(e){o.push(f+'=DENIED_'+e.code)}}",
      "try{fs.writeFileSync(W+'/out.txt','W');o.push('WRITEWS='+fs.readFileSync(W+'/out.txt','utf8'))}catch(e){o.push('WRITEWS_'+e.code)}",
      "process.stdout.write(o.join(NL));",
    ].join(NL));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-tmp6-'));
    const sb = new AclSandbox({ writableDirs: [work], tempDir: temp, writeSid: workspaceWriteSid(work),
      tempWriteSid: tempWriteSid(temp), mode: 'workspace-write' });
    const saved = { h: process.env.H, w: process.env.W };
    let probe;
    try {
      await sb.init();
      process.env.H = home; process.env.W = work;
      const c = sb.spawn({ command: process.execPath, args: [childFile.split(path.sep).join('/')], cwd: work });
      const r = await c.wait();
      probe = (Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout));
    } catch (error) { return void test.skip?.(`sandbox unavailable on this host: ${error.message}`); }
    finally { process.env.H = saved.h; process.env.W = saved.w; try { sb.dispose(); } catch {} fs.rmSync(temp, { recursive: true, force: true }); }
    assert.match(probe, /before\.txt=DENIED_/, 'pre-existing file read-denied to the Low child');
    assert.match(probe, /after\.txt=DENIED_/, 'file created after labeling read-denied too (OICI)');
    assert.match(probe, /WRITEWS=W/, 'the confined child still reads/writes its project folder');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ACC-ISO-07 (model-command isolation, D-1024a / PSC 0.2.29): END TO END through the shipped Worker confinement. The
// same confinedLaunch handRun uses launches a command tree at Low integrity via the compiled launcher; with the Rulith
// home labeled no-read-up and the project labeled Low, the command (1) writes and reads its project, (2) is DENIED
// reading a file in the labeled home, (3) its env carries no secret (scrubbed by the Worker's adapterEnv), and (4) a
// descendant "job" process inherits the same confinement. Windows only.
const e2eSkip = process.platform !== 'win32' ? 'the low-integrity launcher is a win32 mechanism' : false;
test('ACC-ISO-07 a confined command tree writes its project but cannot read the labeled Rulith home', { skip: e2eSkip }, async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-e2e-')));
  const home = path.join(base, 'home'), proj = path.join(base, 'proj'), bin = path.join(base, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(proj); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(home, 'manager.key'), 'SECRET-KEY-BYTES');
  assert.equal(ensureHomeLabel(home).ok, true, 'home gets the no-read-up label');
  assert.equal(ensureLowLabel(proj).ok, true, 'project gets the Low label');
  // The job stand-in: a grandchild the command spawns, which must also be confined (Low) — it writes the project and
  // reports whether it can read the home. Run synchronously so the result is deterministic.
  const grandchild = path.join(proj, 'job.mjs');
  fs.writeFileSync(grandchild, [
    "import fs from 'node:fs';const H=process.env.H,P=process.env.P;",
    "let r='JOB_READHOME_'; try{fs.readFileSync(H+'/manager.key');r+='READ'}catch(e){r+='DENIED_'+e.code}",
    "try{fs.writeFileSync(P+'/job-out.txt','J')}catch(e){}",
    "fs.writeFileSync(P+'/job-result.txt', r);",
  ].join(NL));
  const child = path.join(proj, 'cmd.mjs');
  fs.writeFileSync(child, [
    "import fs from 'node:fs';import {spawnSync} from 'node:child_process';",
    "const H=process.env.H,P=process.env.P,NL=String.fromCharCode(10),o=[];",
    "try{fs.writeFileSync(P+'/out.txt','W');o.push('WRITEPROJ='+fs.readFileSync(P+'/out.txt','utf8'))}catch(e){o.push('WRITEPROJ_'+e.code)}",
    "try{o.push('READHOME='+fs.readFileSync(H+'/manager.key','utf8'))}catch(e){o.push('READHOME_DENIED_'+e.code)}",
    "o.push('ENV_SECRET=['+(process.env.OPENAI_API_KEY||'')+']');",
    "spawnSync(process.execPath,[" + JSON.stringify(fwd(grandchild)) + "],{env:process.env});",
    "try{o.push('JOB='+fs.readFileSync(P+'/job-result.txt','utf8'))}catch(e){o.push('JOB_'+e.code)}",
    "process.stdout.write(o.join(NL));",
  ].join(NL));
  // The command's environment is what the Worker's adapterEnv hands an adapter: an ambient OPENAI_API_KEY is stripped.
  const childEnv = { ...adapterEnv({ ...process.env, OPENAI_API_KEY: 'leaky-secret' }), H: home, P: proj };
  const policyEnv = { ...process.env, RULITH_ADAPTER_SANDBOX: 'required' };
  assert.equal(adapterSandboxMode(policyEnv), 'required');
  let launch;
  // The launcher verifies the labeled home before it starts anything (roots given explicitly, so this test never looks at
  // the account's real ~/.rulith).
  try { launch = confinedLaunch({ execPath: process.execPath, argv: [fwd(child)], cwd: proj, binDir: bin, roots: [home], env: policyEnv }); }
  catch (error) { return void test.skip?.(`launcher unavailable: ${error.message}`); }
  assert.equal(launch.confined, true);
  const r = spawnSync(launch.file, launch.args, { encoding: 'utf8', env: childEnv });
  const out = String(r.stdout || '');
  try {
    assert.match(out, /WRITEPROJ=W/, `command writes its project (${out} ${r.stderr || ''})`);
    assert.match(out, /READHOME_DENIED_/, 'command denied reading the labeled Rulith home');
    assert.match(out, /ENV_SECRET=\[\]/, 'no ambient secret reached the command');
    assert.match(out, /JOB=JOB_READHOME_DENIED_/, 'a descendant job also denied reading the home');
    assert.ok(fs.existsSync(path.join(proj, 'job-out.txt')), 'the descendant job wrote the project');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('ACC-ISO-07 overhead: the launcher adds a bounded per-command cost', { skip: e2eSkip }, async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-ovh-')));
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  const noop = path.join(base, 'noop.mjs'); fs.writeFileSync(noop, 'process.exit(0)');
  let launch;
  try { launch = confinedLaunch({ execPath: process.execPath, argv: [fwd(noop)], cwd: base, binDir: bin, roots: [], env: { RULITH_ADAPTER_SANDBOX: 'required' } }); }
  catch (error) { return void test.skip?.(`launcher unavailable: ${error.message}`); }
  const timeN = (fn) => { const s = Date.now(); for (let i = 0; i < 6; i++) fn(); return (Date.now() - s) / 6; };
  const bare = timeN(() => spawnSync(process.execPath, [fwd(noop)], { cwd: base }));
  assert.equal(spawnSync(launch.file, launch.args, { cwd: base }).status, 0, 'the launcher runs the command');
  const viaLow = timeN(() => spawnSync(launch.file, launch.args, { cwd: base }));
  console.log(`ACC-ISO-07 overhead: bare=${bare.toFixed(0)}ms viaLauncher=${viaLow.toFixed(0)}ms delta=${(viaLow - bare).toFixed(0)}ms`);
  assert.ok(viaLow - bare < 2000, 'launcher overhead is well under 2s per command');
  fs.rmSync(base, { recursive: true, force: true });
});

// ACC-ISO-05 (model-command isolation, D-1024a): the Linux bwrap adapter profile and the required fail-closed gate.
import { bwrapAdapterArgv } from '../../../worker/adapter-confinement.mjs';
test('ACC-ISO-05 the Linux bwrap profile makes project/kit/temp writable, host read-only, Rulith home masked, network kept', () => {
  const argv = bwrapAdapterArgv({ execPath: '/usr/bin/node', argv: ['adapter.mjs', 'run'], cwd: '/proj',
    writableRoots: ['/proj', '/home/u/.rulith/app/kit', '/tmp/x'], hideRoots: ['/home/u/.rulith/app', '/home/u/.rulith'] });
  const s = argv.join(' ');
  assert.ok(s.includes('--ro-bind / /'), 'host root is read-only');
  for (const w of ['/proj', '/home/u/.rulith/app/kit', '/tmp/x']) assert.ok(s.includes(`--bind ${w} ${w}`), `${w} writable`);
  for (const h of ['/home/u/.rulith/app', '/home/u/.rulith']) assert.ok(s.includes(`--tmpfs ${h}`), `${h} masked`);
  assert.ok(!argv.includes('--unshare-net'), 'the network is NOT unshared (web tools need it)');
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['/usr/bin/node', 'adapter.mjs', 'run']);
});

test('ACC-ISO-05 (Linux) required confinement fails closed when bwrap is absent', {
  skip: process.platform !== 'linux' ? 'bwrap confinement is a Linux mechanism'
    : spawnSync('bwrap', ['--version']).status === 0 ? 'bwrap is installed here; this test asserts the absent-bwrap path' : false,
}, () => {
  assert.throws(() => confinedLaunch({ execPath: process.execPath, argv: ['x'], cwd: process.cwd(),
    env: { RULITH_ADAPTER_SANDBOX: 'required' } }), /bubblewrap|bwrap/);
});

// ACC-ISO-08 (model-command isolation, D-1024a): END TO END through the product. A child process with a throwaway
// account home (USERPROFILE/HOME/LOCALAPPDATA in a temporary directory) and no RULITH_* variable at all runs the app's
// appSettings, a real manager (createManagerServer, signed in and paired against the devices test gateway), the instance
// host that starts the Worker, and the project-open label store; the Worker claims one real eng.run from a fake Work
// endpoint. Every label is applied by that product code, never by the test. The command, a project script that reads by
// code, is denied manager.key, local.json (freshly rewritten atomically), model-defaults.json, a *.tmp and a backup, and
// writes both its project and the instance's kit home in the work root. Then the Source is revoked while no Worker runs,
// and the next Worker start restores the project's prior label; and an instance in the old layout is moved out of the
// credential roots by the next manager start and confirmed (old copy removed) by the one after.
const managedSkip = process.platform !== 'win32' ? 'the low-integrity launcher is a win32 mechanism' : false;
test('ACC-ISO-08 the managed product path confines a real eng.run, restores the project label on revoke, migrates the layout', { skip: managedSkip, timeout: 300_000 }, () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-acc08-')));
  const user = path.join(base, 'user'), local = path.join(base, 'local');
  fs.mkdirSync(user); fs.mkdirSync(local);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^RULITH_/i.test(name)));
  Object.assign(env, { USERPROFILE: user, HOME: user, LOCALAPPDATA: local });
  try {
    const driver = new URL('./support/managed-isolation-run.mjs', import.meta.url);
    const run = spawnSync(process.execPath, [fileURLToPath(driver), base], { env, encoding: 'utf8', timeout: 280_000, windowsHide: true });
    const file = path.join(base, 'result.json');
    assert.ok(fs.existsSync(file), `the driver wrote its result (status ${run.status}; ${String(run.stderr).slice(-1500)})`);
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(r.error, undefined, r.error);
    const shown = JSON.stringify({ probe: r.probe, labels: r.labels, events: r.events });
    // Labels, applied by the product: credential roots no-read-up, the kit home and the project Low.
    for (const name of ['appHome', 'backstop', 'managerHome', 'instanceDir', 'localJson', 'key'])
      assert.match(r.labels[name], /Medium Mandatory Level:.*NR/, `${name} is read-protected (${shown})`);
    for (const name of ['kitHome', 'project']) assert.match(r.labels[name], /Low Mandatory Level/, `${name} is Low (${shown})`);
    // The layout: what the confined command needs is outside every credential root.
    for (const name of ['workerRoot', 'kitHome']) assert.ok(r.layout[name].startsWith(r.layout.workRoot), `${name} in the work root`);
    assert.ok(!r.layout.workRoot.toLowerCase().startsWith(path.join(user, '.rulith').toLowerCase()), 'the work root is not under ~/.rulith');
    // The command ran through the Worker and the launcher.
    assert.ok(r.seen.includes('ClaimWork') && r.seen.includes('ReportWork'), `the Worker claimed and reported (${r.seen})`);
    assert.ok(r.probe, `the command ran (${shown})`);
    for (const name of ['key', 'local', 'defaults', 'tmp', 'backup']) assert.match(r.probe[name], /^DENIED_/, `${name} read denied (${shown})`);
    assert.equal(r.probe.project, 'W', 'the command writes its project');
    assert.equal(r.probe.work, 'K', 'the command writes its kit home in the work root');
    // Revoked while no Worker ran: the next Worker start restored the folder's prior (absent) label.
    assert.equal(r.projectOpen.prior, '');
    assert.equal(r.projectAfterRevoke, '(none)', 'the project label was restored');
    // The old layout moved out (copied, switched, old kept), then confirmed (old removed).
    assert.ok(r.migration.workerRoot.startsWith(r.layout.workRoot) && r.migration.kitHome.startsWith(r.layout.workRoot), 'switched to the work root');
    assert.equal(r.migration.copiedKit, true); assert.equal(r.migration.copiedWorker, true); assert.equal(r.migration.oldKept, true);
    assert.ok(r.migration.marker?.worker && r.migration.marker?.kit, 'the move is recorded until it is confirmed');
    assert.deepEqual(r.migration.confirmed, { marker: null, oldWorkerGone: true, oldKitGone: true });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ACC-ISO-09 (Worker side): even if a folder got past the open, the Worker refuses to launch a confined command in a
// project that contains or lies inside a credential root or the instance's work root — before any launcher is built.
test('ACC-ISO-09 the Worker refuses a confined launch in a project overlapping a credential or work root', {
  skip: !['win32', 'linux'].includes(process.platform) ? 'confinement is a win32/linux mechanism' : false,
}, () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-overlap-')));
  const root = path.join(base, 'cred'), work = path.join(base, 'work'), proj = path.join(base, 'proj');
  for (const d of [path.join(root, 'inner'), path.join(work, 'kit'), proj]) fs.mkdirSync(d, { recursive: true });
  const env = { RULITH_ADAPTER_SANDBOX: 'required' };
  const launch = (project) => confinedLaunch({ execPath: process.execPath, argv: ['x'], cwd: project, binDir: path.join(base, 'bin'),
    roots: [root], workRoot: work, project, env });
  try {
    for (const project of [base, root, path.join(root, 'inner'), work, path.join(work, 'kit')])
      assert.throws(() => launch(project), /credential|work root|Rulith/i, project);
    assert.ok(!fs.existsSync(path.join(base, 'bin')), 'no launcher was built for a refused launch');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ACC-ISO-09 (kit home): a writable folder other than the project (the kit home) that reaches into a credential root is
// refused too — on Linux its read-write bind would re-expose what the mask hides.
test('ACC-ISO-09 a confined launch refuses a kit home inside a credential root', {
  skip: !['win32', 'linux'].includes(process.platform) ? 'confinement is a win32/linux mechanism' : false,
}, () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-kitroot-')));
  const root = path.join(base, 'cred'), kit = path.join(root, 'kit'), proj = path.join(base, 'proj');
  for (const d of [kit, proj]) fs.mkdirSync(d, { recursive: true });
  try {
    assert.throws(() => confinedLaunch({ execPath: process.execPath, argv: ['x'], cwd: proj, binDir: path.join(base, 'bin'), roots: [root],
      writableRoots: [proj, kit], project: proj, env: { RULITH_ADAPTER_SANDBOX: 'required' } }), /kit home/);
    assert.ok(!fs.existsSync(path.join(base, 'bin')), 'refused before any launcher was built');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ACC-ISO-10 (identity): a Worker whose instance directory lies outside the manager home still checks the manager home
// and uses the instance id the manager gave it: the same id the project open recorded its label under, and the same id
// the manager's work root uses.
test('ACC-ISO-10 an instance outside the manager home checks the manager home and releases under the open id', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-identity-')));
  const manager = path.join(base, 'manager'), outside = path.join(base, 'elsewhere', 'agent-desk'), proj = path.join(base, 'proj');
  for (const d of [manager, outside, proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(manager, 'registry.json'), '{}');
  const env = { RULITH_LOCAL_CONFIG: path.join(outside, 'local.json'), LOCALAPPDATA: path.join(base, 'local'), XDG_DATA_HOME: path.join(base, 'xdg') };
  try {
    // Without the manager naming it, nothing above the instance directory leads to the manager home.
    assert.equal(confinementIdentity(env).managerHome, undefined);
    assert.equal(confinementIdentity(env).instanceId, 'agent-desk');
    const named = { ...env, RULITH_MANAGER_HOME: manager, RULITH_INSTANCE_ID: 'inst-0123456789ab' };
    const identity = confinementIdentity(named);
    assert.equal(identity.managerHome, manager);
    assert.equal(identity.instanceId, 'inst-0123456789ab');
    assert.equal(identity.workRoot, workRootFor('inst-0123456789ab', named));
    const roots = credentialRoots(named).map((p) => p.toLowerCase());
    for (const p of [manager, outside]) assert.ok(roots.includes(p.toLowerCase()), `${p} is a checked root`);
    if (process.platform === 'win32') {
      assert.equal(labelProjectOpen({ managerHome: manager, directory: proj, holder: 'inst-0123456789ab' }).ok, true);
      // The Worker releases under its identity's id, the open's holder, so the folder goes back to its prior label.
      const released = releaseProjectLabel({ managerHome: identity.managerHome, directory: proj, holder: identity.instanceId });
      assert.equal(released.ok, true); assert.equal(released.restored, 'S:');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ACC-ISO-11 (settings-file key file): a credential root may be a single file. The credential roots handed on by the
// launcher include it; the launcher verifies it before every command and refuses while it is unlabeled (fail-closed,
// English refusal naming the file); once labelled, the command runs and cannot read it.
test('ACC-ISO-11 a key file kept outside Rulith folders is a verified credential root', { skip: e2eSkip }, () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-keyfile-')));
  const key = path.join(base, 'workbench-key.txt'), proj = path.join(base, 'proj'), bin = path.join(base, 'bin');
  fs.mkdirSync(proj); fs.writeFileSync(key, 'WORKBENCH-KEY-SECRET');
  fs.writeFileSync(path.join(proj, 'probe.mjs'),
    "import fs from 'node:fs';try{fs.readFileSync(process.env.K);process.stdout.write('READ')}catch(e){process.stdout.write('DENIED_'+e.code)}");
  const env = { RULITH_ADAPTER_SANDBOX: 'required', RULITH_CREDENTIAL_ROOTS: JSON.stringify([key]) };
  try {
    assert.ok(credentialRoots(env).some((p) => p.toLowerCase() === key.toLowerCase()), 'the key file is a credential root');
    assert.equal(ensureLowLabel(proj).ok, true);
    let launch;
    try { launch = confinedLaunch({ execPath: process.execPath, argv: [fwd(path.join(proj, 'probe.mjs'))], cwd: proj, binDir: bin, roots: [key], env }); }
    catch (error) { return void test.skip?.(`launcher unavailable: ${error.message}`); }
    const refused = spawnSync(launch.file, launch.args, { encoding: 'utf8', env: { ...process.env, K: key } });
    assert.equal(refused.status, 126, 'refused while the file is unlabeled');
    assert.match(refused.stderr, /rulith-isolation-refused: .*workbench-key\.txt is not read-protected/);
    assert.equal(refused.stdout, '', 'nothing ran');
    const labelled = ensureCredentialRootLabels([key]);
    assert.deepEqual(labelled.unlabeled, [], JSON.stringify(labelled));
    assert.equal(homeLabelVerified(key), true);
    const ran = spawnSync(launch.file, launch.args, { encoding: 'utf8', env: { ...process.env, K: key } });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /^DENIED_/, 'the command cannot read the key file');
    assert.equal(fs.readFileSync(key, 'utf8'), 'WORKBENCH-KEY-SECRET', 'the owner still reads it');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ACC-ISO-12 (labelling verifies inside): a file inside a root that keeps a different label after propagation (here an
// explicit Low label, as an elevated or foreign run might leave) makes the root count as unprotected: its new label is
// taken off again, the launcher refuses as for an unlabeled root, and the English refusal names the file.
test('ACC-ISO-12 a root with a child that kept another label is refused, naming the child', { skip: e2eSkip }, () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-taint-')));
  const root = path.join(base, 'root'), clean = path.join(base, 'clean'), odd = path.join(root, 'sub', 'odd.json');
  fs.mkdirSync(path.dirname(odd), { recursive: true }); fs.mkdirSync(path.join(clean, 'sub'), { recursive: true });
  fs.writeFileSync(odd, 'SECRET'); fs.writeFileSync(path.join(root, 'ok.json'), 'SECRET'); fs.writeFileSync(path.join(clean, 'sub', 'a.json'), 'A');
  try {
    const [explicitLow] = labelOps([{ op: 'set', path: odd, sddl: 'S:(ML;;NW;;;LW)' }]);
    assert.equal(explicitLow.ok, true, JSON.stringify(explicitLow));
    const result = ensureCredentialRootLabels([root, clean]);
    assert.deepEqual(result.unlabeled.map((p) => p.toLowerCase()), [root.toLowerCase()], JSON.stringify(result));
    assert.match(result.reasons[result.unlabeled[0]], /odd\.json inside it keeps a different integrity label/);
    assert.equal(homeLabelVerified(root), false, 'the root label was taken off again');
    assert.equal(homeLabelVerified(clean), true, 'a clean root is labelled');
    const refusal = credentialRootRefusal(result);
    assert.match(refusal, /^Model-command isolation refused: .*odd\.json/);
    assert.doesNotMatch(refusal, /[一-鿿]/, 'the refusal is English');
    let launch;
    try {
      launch = confinedLaunch({ execPath: process.execPath, argv: ['-e', '0'], cwd: base, binDir: path.join(base, 'bin'), roots: [root, clean],
        env: { RULITH_ADAPTER_SANDBOX: 'required' } });
    } catch (error) { return void test.skip?.(`launcher unavailable: ${error.message}`); }
    assert.equal(spawnSync(launch.file, launch.args, { encoding: 'utf8' }).status, 126, 'the launcher refuses the unprotected root');
    // The host hands the named refusal to its Worker; confinedLaunch then refuses with it before building anything.
    assert.throws(() => confinedLaunch({ execPath: process.execPath, argv: ['x'], cwd: base, binDir: path.join(base, 'bin2'), roots: [],
      env: { RULITH_ADAPTER_SANDBOX: 'required', RULITH_CONFINEMENT_REFUSAL: refusal } }), /odd\.json/);
    assert.ok(!fs.existsSync(path.join(base, 'bin2')));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
