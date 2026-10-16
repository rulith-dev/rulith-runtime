import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { generalSettings } from './general-settings.mjs';

export const sha = value => createHash('sha256').update(value).digest('hex');
export function fileDigest(file) {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(65536); const fd = fs.openSync(file,'r');
  try { let n; while ((n = fs.readSync(fd,buffer,0,buffer.length,null)) > 0) hash.update(buffer.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function clip(bytes, tail = false) {
  let text = (tail ? bytes.subarray(-1024) : bytes.subarray(0,1024)).toString('utf8');
  while (Buffer.byteLength(text) > 1024) text = tail ? text.slice(1) : text.slice(0,-1);
  return text;
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const refuse = code => { throw new Error(code); };
export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
// Resolve the nearest existing ancestor too, for new files below symlinked directories.
export function fenced(root, name = '.') {
  if (typeof name !== 'string' || name.includes('\0')) refuse('path refused');
  const target = path.resolve(root, name);
  if (!inside(root, target)) refuse('path refused');
  let ancestor = target;
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    // A dangling link must not be treated as an absent file.
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) refuse('path refused'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) refuse('path refused');
    ancestor = parent;
  }
  const real = path.join(fs.realpathSync(ancestor), ...missing);
  if (!inside(root, real)) refuse('path refused');
  return real;
}
// Inspect the lexical path before realpath can erase a link or junction component.
// Descend a finite list of components instead of comparing realpath spellings in a parent loop.
export function plainFenced(root, name) {
  if (typeof name !== 'string' || name.includes('\0')) refuse('path refused');
  const target = path.resolve(root, name);
  if (!inside(root, target)) refuse('path refused');
  let cursor = root;
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) refuse('path refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return fenced(root, name);
}
export function context(env = process.env) {
  if (env.RULITH_SOURCE_TYPE !== 'file' || !env.RULITH_SOURCE_ACCESS || !path.isAbsolute(env.RULITH_SOURCE_ACCESS)) refuse('file Source required');
  const root = fs.realpathSync(env.RULITH_SOURCE_ACCESS);
  if (!fs.statSync(root).isDirectory()) refuse('file Source required');
  if (!env.ENG_KIT_HOME || !path.isAbsolute(env.ENG_KIT_HOME)) refuse('pin directory required');
  // The owner creates this directory, never the model.
  const home = fs.realpathSync(env.ENG_KIT_HOME);
  if (inside(root, home) || inside(home, root)) refuse('pin directory refused');
  return { root, home, stateFile: path.join(home, `tree-${sha(root)}.json`), jobFile: path.join(home, `job-${sha(root)}.json`) };
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export function save(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function pin(ctx, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) refuse('spec refused: spec_id is letters, digits, - and _ (at most 64)');
  const file = path.join(ctx.home, 'specs', `${id}.json`);
  // A spec the agent wrote itself (spec_id self-<name>, from <project>/.deep-rulith/measure/<name>.json) is frozen into
  // the kit home when a measurement first runs on it (after the spec passed every check, so a refused spec can still
  // be corrected under its name) and never changes afterwards: runs of one spec_id stay comparable without waiting for
  // the owner. The self- prefix stays on every receipt, so its provenance is visible; the owner's specs have no prefix.
  if (id.startsWith('self-') && !fs.existsSync(file)) {
    const source = fenced(ctx.root, `.deep-rulith/measure/${id.slice(5)}.json`);
    if (!fs.existsSync(source)) refuse('spec refused: no such spec');
    const bytes = fs.readFileSync(source);
    if (bytes.length > 16384) refuse('spec refused: larger than 16 KiB');
    let spec; try { spec = JSON.parse(bytes); } catch { refuse('spec refused: not valid JSON'); }
    const freeze = () => {
      try { fs.writeFileSync(file, bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (sha(fs.readFileSync(file)) !== sha(bytes)) refuse('spec refused: another spec was frozen under this id first');
    };
    return { spec, digest: sha(bytes), freeze };
  }
  if (!fs.existsSync(file)) refuse('spec refused: no such spec');
  if (!inside(ctx.home, fs.realpathSync(file))) refuse('spec refused');
  const bytes = fs.readFileSync(file);
  return { spec: JSON.parse(bytes), digest: sha(bytes) };
}
export function exclusions(ctx) {
  const names = new Set(['.git']);
  // The owner's treeExclude (settings.json): large or generated folders the tree digest skips, like the output_dirs
  // of the owner's pinned specs in the kit home. Project acceptance specs add nothing: the model writes them.
  for (const name of settings(ctx.home).treeExclude) names.add(name.replaceAll('\\', '/').replace(/\/$/, ''));
  const directory = path.join(ctx.home, 'specs');
  if (!inside(ctx.home, fs.realpathSync(directory))) refuse('spec refused');
  for (const entry of fs.readdirSync(directory).sort()) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(entry)) continue;
    const { spec } = pin(ctx, entry.slice(0, -5));
    for (const name of spec.output_dirs ?? []) {
      if (typeof name !== 'string' || !name || name === '.' || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) refuse('spec refused');
      names.add(name.replaceAll('\\', '/').replace(/\/$/, ''));
    }
  }
  return [...names].sort();
}
// A skip entry is a path from the project root, or **/<name> for every folder of that name at any depth
// (dependency folders such as node_modules).
export function skipped(skip, name) {
  const parts = name.split('/');
  return skip.some(s => s.startsWith('**/') ? parts.includes(s.slice(3)) : name === s || name.startsWith(`${s}/`));
}
export function excluded(ctx, name) { return name !== '' && skipped(exclusions(ctx), name); }
// The files under a folder the tree digest skips, walked on demand (at most 20000; .git and **/ folders skipped).
export function filesUnder(ctx, prefix) {
  const skip = exclusions(ctx).filter(s => s.startsWith('**/'));
  const start = fenced(ctx.root, prefix);
  if (!fs.statSync(start).isDirectory()) return [prefix];
  const out = []; const queue = [prefix];
  while (queue.length && out.length < 20000) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(fenced(ctx.root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = `${dir}/${entry.name}`;
      if (entry.name === '.git' || entry.isSymbolicLink() || skipped(skip, name)) continue;
      if (entry.isDirectory()) queue.push(name); else if (entry.isFile() && out.length < 20000) out.push(name);
    }
  }
  return out;
}
export function tree(ctx) {
  const skip = exclusions(ctx);
  const files = {};
  // Large trees (a large source checkout can be tens of GB) cannot be rehashed on every step: a file whose size and
  // modification time are unchanged since the last walk keeps its recorded digest. The cache lives in the kit home,
  // outside the project. It is a speed-up for an honest tree, not a guard against deliberate mtime forgery.
  const cacheFile = path.join(ctx.home, 'tree-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  const next = {};
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix + entry.name;
      // Every nested repository's .git is skipped, not only the top one.
      if (entry.name === '.git') continue;
      if (skipped(skip, name)) continue;
      const file = fenced(ctx.root, name);
      // Links are recorded, never followed (cycles and aliases do not duplicate files).
      if (entry.isSymbolicLink()) files[name] = sha(`link:${fs.readlinkSync(path.join(dir, entry.name))}`);
      else if (entry.isDirectory()) { files[`${name}/`] = 'directory'; visit(file, `${name}/`); }
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        const known = cache[name];
        const digest = known && known[0] === stat.size && known[1] === stat.mtimeMs ? known[2] : fileDigest(file);
        next[name] = [stat.size, stat.mtimeMs, digest];
        files[name] = `${stat.mode & 0o777}:${digest}`;
      }
      else refuse('path refused');
    }
  }
  visit(ctx.root);
  try { fs.writeFileSync(cacheFile, JSON.stringify(next)); } catch {}
  const specs = fs.readdirSync(path.join(ctx.home,'specs')).filter(e => /^[a-zA-Z0-9_-]+\.json$/.test(e)).sort().map(e => [e, pin(ctx,e.slice(0,-5)).digest]);
  return { files, digest: sha(JSON.stringify({ skip, specs, files })) };
}
export function changed(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(p => before.files[p] !== after.files[p]).sort();
}
export function textLimit(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) refuse('text exceeds 16 KiB');
  return text;
}
// A command line split into argv here, never handed to a shell: quotes group words; pipes, redirects,
// command separators and substitutions are refused below. The Gateway authorizes only scalar inputs for
// directly used run Actions, so the model sends one string. This is a side-effect classifier, not a sandbox.
export function argv(command) {
  if (Array.isArray(command)) return command;
  if (typeof command !== 'string') refuse('command refused');
  const out = []; let word = ''; let quote = null; let open = false;
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = null; else word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; open = true; continue; }
    if (/\s/.test(ch)) { if (open) { out.push(word); word = ''; open = false; } continue; }
    word += ch; open = true;
  }
  if (quote) refuse('command refused');
  if (open) out.push(word);
  return out;
}
export function classify(ctx, input, cwd = '.') {
  const opts = settings(ctx.home);
  const command = argv(input);
  if (command.length === 0 || command.some(x => typeof x !== 'string' || !x || /[\0\r\n]/.test(x))) refuse('command refused');
  const resolvedCwd = fenced(ctx.root, cwd);
  if (!fs.statSync(resolvedCwd).isDirectory()) refuse('path refused');
  const exe = path.basename(command[0]).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  const words = command.map(x => x.toLowerCase());
  const joined = words.join(' ');
  const has = (rule) => opts.allow.has(rule);
  // A git subcommand anywhere in the line, so `cd x && git commit` is seen as well as `git commit`.
  const git = (subcommands) => new RegExp(`\\bgit\\b[^;&|]*\\b(${subcommands})\\b`).test(joined);
  // Always refused: privilege, process and service control, publishing, global installs.
  if (/^(sudo|doas|runas|taskkill|kill|killall|pkill|env)$/.test(exe)) refuse('command refused');
  if (/\b(push|publish)\b/.test(joined)) refuse('command refused');
  if (words.some(x => ['-g', '--global', '--system'].includes(x))) refuse('command refused');
  if ((['net', 'sc', 'systemctl', 'service', 'docker', 'supervisorctl', 'launchctl', 'brew'].includes(exe) && /\b(stop|restart|kill|delete|down)\b/.test(joined))
    || /\b(stop-service|stop-process)\b/.test(joined)) refuse('command refused');
  if (git('config')) refuse('command refused');
  // Inline code is a command the classifier cannot read. The fence is about visible intent, not a sandbox: a script
  // file named on the line can still do anything the Worker's user can, but its text is a project file anyone reads.
  // node: -e/-p/-r alone, combined (-pe, -ep) or attached (-e<code>); the long forms; and data: URLs, the inline
  // module a loader or import flag (--loader, --experimental-loader, --import, -r) would run.
  // python: -c alone, attached (-c<code>) or after no-argument flags (-Ic). perl/ruby: -e/-E likewise (-ne, -le).
  if ((exe === 'node' && words.some(x => /^-[a-z]*[epr]/.test(x) || /^(--eval|--print|--require|--import)(=|$)/.test(x)
      || /^(--loader|--experimental-loader|--import|-r)=data:/.test(x) || x.startsWith('data:')))
    || (/^python[0-9.]*$|^py$/.test(exe) && command.some(x => /^-[bBdEhiIOPqsSuvVx]*c/.test(x)))
    || (/^(perl|ruby)$/.test(exe) && command.some(x => /^-[acdlnpsStTuUvwWx0-9]*[eE]/.test(x)))) refuse('command refused');
  // Relaxable by the owner's settings.
  if (/^(sh|bash|cmd|powershell|pwsh|wscript|cscript)$/.test(exe) && !opts.shell) refuse('command refused');
  if (!opts.shell && command.some(x => /[;&|<>`]/.test(x) || /\$\(|%[^%]+%/.test(x))) refuse('command refused');
  if (/^(rm|rmdir|del|erase|remove-item|rd|unlink)$/.test(exe) && !has('delete')) refuse('command refused');
  if (/\b(delete|rmdir|erase|unlink|remove-item)\b/.test(joined) && !has('delete')) refuse('command refused');
  if ((['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'cargo', 'gem', 'uv'].includes(exe) && /\b(install|add|update|upgrade|i)\b/.test(joined)) && !has('install')) refuse('command refused');
  if (git('clean|reset') && !has('git_rewrite')) refuse('command refused');
  // Recording history is the owner's: commits, merges, rebases and tags need allow: ["git_commit"].
  if (git('commit|merge|rebase|cherry-pick|revert|am|tag') && !has('git_commit')) refuse('command refused');
  // Paths: inside the project, or under a directory the owner listed.
  for (const arg of command) {
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (/^[a-z]+:\/\//i.test(value)) continue;
    if (path.isAbsolute(value) || /^[a-z]:[\/]/i.test(value) || value.startsWith('\\')) commandPath(ctx.root, opts.allowedPaths, value);
    if (value.split(/[\/]/).includes('..')) commandPath(ctx.root, opts.allowedPaths, path.resolve(resolvedCwd, value));
    const drive = value.match(/[a-z]:[\/].*/i)?.[0]; if (drive) commandPath(ctx.root, opts.allowedPaths, drive);
    if (/^-[IL]/.test(value) && path.isAbsolute(value.slice(2))) commandPath(ctx.root, opts.allowedPaths, value.slice(2));
  }
  return { command, cwd: resolvedCwd, line: typeof input === 'string' ? input : undefined, shell: opts.shell };
}
export async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const code = await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve(-1)); killer.once('close', resolve);
    });
    if (code !== 0) {
      // Do not pretend that a failed system tree kill confirmed descendants stopped.
      try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code === 'ESRCH') return; }
      throw new Error('process tree termination failed');
    }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}
function capture() {
  const hash = createHash('sha256'); let bytes = 0; let head = Buffer.alloc(0); let tail = Buffer.alloc(0);
  return {
    add(chunk) { hash.update(chunk); bytes += chunk.length; if (head.length < 1024) head = Buffer.concat([head, chunk]).subarray(0, 1024); tail = Buffer.concat([tail, chunk]).subarray(-1024); },
    finish() { return { digest: hash.digest('hex'), bytes, head: clip(head), tail: bytes > 1024 ? clip(tail,true) : '' }; },
  };
}
// 时限是主人的设置项（ENG_KIT_HOME/settings.json，单位秒）：runDeadlineSeconds 一条命令（缺省 35），
// jobLimitSeconds 一个后台任务（缺省 0 = 不限），pollMaxWaitSeconds job_poll 一次最多等多久（缺省 35）。
// 本机 Worker 对每个适配器另有硬上限（RULITH_WORKER_RUN_TIMEOUT_SECONDS，缺省 60）：它必须大于这里的命令与轮询时限，
// 否则 Worker 会先把适配器停掉，结果交不回去。
export function settings(home = process.env.ENG_KIT_HOME) {
  let s = {};
  if (home) try { s = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') refuse('settings refused'); }
  const seconds = (value, fallback, zeroAllowed) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < (zeroAllowed ? 0 : 1) || value > 7 * 86400) refuse('settings refused');
    return value;
  };
  // allowedPaths：命令可以引用的项目外目录（例如模型文件、SDK）；只放宽命令里的路径检查，工作区读写仍只在项目里。
  // allow：放宽的规则名——install（项目内安装依赖）、delete（项目内删除）、git_rewrite（git reset／clean）、git_commit（提交、合并、变基、打标签）。
  // shell：命令交给系统 shell 执行（可用管道、重定向、.cmd 脚本）。推送／发布、全局安装、停服务、杀进程、提权始终拒绝。
  const allowedPaths = s.allowedPaths === undefined ? [] : s.allowedPaths;
  if (!Array.isArray(allowedPaths) || allowedPaths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) refuse('settings refused');
  const allow = s.allow === undefined ? [] : s.allow;
  if (!Array.isArray(allow) || allow.some((r) => !['install', 'delete', 'git_rewrite', 'git_commit'].includes(r))) refuse('settings refused');
  if (s.shell !== undefined && typeof s.shell !== 'boolean') refuse('settings refused');
  const treeExclude = s.treeExclude === undefined ? [] : s.treeExclude;
  if (!Array.isArray(treeExclude) || treeExclude.some((n) => typeof n !== 'string' || !n || n === '.' || path.isAbsolute(n) || n.split(/[\\/]/).includes('..'))) refuse('settings refused');
  return { runSeconds: seconds(s.runDeadlineSeconds, 35), jobSeconds: seconds(s.jobLimitSeconds, 0, true), pollSeconds: seconds(s.pollMaxWaitSeconds, 35),
    allowedPaths: allowedPaths.map((p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }), allow: new Set(allow), shell: s.shell === true, treeExclude };
}
// 命令里的一个路径：在项目里，或在主人列出的项目外目录里（不存在的路径按字面判断）。
function commandPath(root, extra, value) {
  const target = path.resolve(root, value);
  let real = target; try { real = fs.realpathSync(target); } catch {}
  if ([root, ...extra].some((dir) => inside(dir, real) || inside(dir, target))) return;
  refuse('path refused');
}
// POSIX needs its own process group so the whole tree can be stopped; Windows stops the tree with taskkill /T, and a
// detached console there loses a shell redirect's output.
const GROUP = process.platform !== 'win32';
export async function execute(command, cwd, { deadlineMs = 35000, onStart, shell = false, line } = {}) {
  const stdout = capture(); const stderr = capture(); const start = Date.now();
  let timedOut = false;
  // With the owner's shell setting the command line goes to the system shell as written; otherwise argv, no shell.
  const child = shell
    ? spawn(line ?? command.join(' '), { cwd, shell: true, detached: GROUP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(command[0], command.slice(1), { cwd, shell: false, detached: GROUP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  onStart?.(child.pid);
  child.stdout.on('data', b => stdout.add(b)); child.stderr.on('data', b => stderr.add(b));
  let rejectExecution;
  // deadlineMs 为 0 表示不限时（只用于主人设成不限的后台任务）；停止仍走 job_stop。
  const timer = !deadlineMs ? null : setTimeout(() => { timedOut = true; void killTree(child.pid).catch(error => { child.stdout.destroy(); child.stderr.destroy(); rejectExecution(error); }); }, deadlineMs);
  const exitCode = await new Promise((resolve, reject) => { rejectExecution = reject; child.once('error', reject); child.once('close', (code) => resolve(code ?? -1)); }).finally(() => clearTimeout(timer));
  // A leader can exit while descendants still hold pipes or perform work.
  if (timedOut || process.platform !== 'win32') await killTree(child.pid);
  return { exit_code: exitCode, timed_out: timedOut, duration_ms: Date.now() - start, stdout: stdout.finish(), stderr: stderr.finish() };
}
// Shared by installation and stale-lock recovery, clamped to the Worker's maximum.
// Recovery grants another 60 seconds beyond this deadline before reclaiming a pid.
export function workerRunTimeoutSeconds(home) {
  const limits = settings(home);
  return Math.min(7 * 86400, Math.max(limits.runSeconds, limits.pollSeconds, generalSettings(home).webTimeoutSeconds) + 60);
}

export async function locked(ctx, action) {
  ctx = { ...ctx, home: ctx.home ?? path.dirname(ctx.stateFile) };
  const leaseMs = workerRunTimeoutSeconds(ctx.home) * 1000 + 60_000;
  const retryDeadline = performance.now() + 2000;
  const busy = Symbol('busy');
  for (;;) {
    const result = await tryLocked(ctx, action, leaseMs, busy);
    if (result !== busy) return result;
    const remaining = retryDeadline - performance.now();
    if (remaining <= 0) refuse('adapter busy');
    await sleep(Math.min(remaining, 20 + Math.random() * 40));
  }
}

async function tryLocked(ctx, action, leaseMs, busy) {
  const lock = `${ctx.stateFile}.lock`;
  const claims = `${lock}.claims`, token = `${process.pid}-${randomUUID()}`, claim = path.join(claims, token);
  const holder = { pid: process.pid, startedAt: new Date().toISOString(), token };
  // A clock correction can leave a reused pid with a far-future start time.
  const expired = timestamp => Math.abs(Date.now() - timestamp) > leaseMs;
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; } // EPERM/unknown stays live.
  };
  const removeClaim = directory => {
    // Only our uniquely named participant's files; never follow a directory recursively.
    try {
      for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
      fs.rmdirSync(directory);
    } catch {}
  };
  const participants = () => fs.readdirSync(claims).flatMap(name => {
    if (name === token) return [];
    const match = /^(\d+)-[a-f0-9-]{36}$/.exec(name);
    if (!match) return [];
    const pid = Number(match[1]), directory = path.join(claims, name);
    let stat;
    try { stat = fs.statSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    // Directory creation announces choosing, before the ticket is written.
    if (expired(stat.mtimeMs)) { removeClaim(directory); return []; }
    if (!Number.isSafeInteger(pid) || pid <= 0) return [];
    if (!alive(pid)) { removeClaim(directory); return []; }
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(directory, 'ticket.json'), 'utf8')); }
    catch (error) {
      // An absent ticket is a participant still choosing. A vanished participant
      // may already have finished; conservatively treating it as choosing is safe.
      if (error.code === 'ENOENT') return [{ token: name, choosing: true }];
      return [];
    }
    if (expired(Date.parse(record?.startedAt))) { removeClaim(directory); return []; }
    if (!Number.isSafeInteger(record?.ticket) || record.ticket < 1) return [];
    return [{ token: name, ticket: record.ticket }];
  });
  // A filesystem bakery try-lock serializes acquisition AND stale recovery. The
  // stable participant directory announces choosing before its ticket is published
  // by atomic rename. Losers remove their own claim before a bounded retry.
  fs.mkdirSync(claims, { recursive: true });
  fs.mkdirSync(claim);
  try {
    const ticket = Math.max(0, ...participants().filter(p => !p.choosing).map(p => p.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) refuse('adapter busy');
    save(path.join(claim, 'ticket.json'), { ...holder, ticket });
    if (participants().some(p => p.choosing || p.ticket < ticket || p.ticket === ticket && p.token < token)) return busy;
    // Only the elected participant can touch the shared legacy lock path.
    let record;
    try { record = JSON.parse(fs.readFileSync(lock, 'utf8')); }
    catch (error) {
      // The legacy kit can die between wx open and writing its pid. Treat a
      // partial/empty record as live until its filesystem lease expires.
      if (error instanceof SyntaxError) record = null;
      else if (error.code !== 'ENOENT') return busy;
    }
    if (record !== undefined) {
      const pid = typeof record === 'number' ? record : record?.pid;
      const timestamp = Date.parse(record?.startedAt);
      try {
        if (!expired(Number.isFinite(timestamp) ? timestamp : fs.statSync(lock).mtimeMs)
          && (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid))) return busy;
        fs.unlinkSync(lock);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Only known kit save names, and only older than any possible adapter run.
    // A killed write/rename or write/link leaves these behind; fresh temps belong
    // to callers that may still be active (including another Source).
    for (const entry of fs.readdirSync(ctx.home, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:tree-[a-f0-9]{64}\.json(?:\.lock)?|job-[a-f0-9]{64}\.json|tree-cache\.json)\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue;
      const file = path.join(ctx.home, entry.name);
      try { if (Date.now() - fs.statSync(file).mtimeMs > leaseMs) fs.unlinkSync(file); }
      catch {} // Stale save cleanup is best-effort, including locked/read-only files.
    }
    // Publish the holder atomically too: death between open and write must never
    // leave an empty shared lock whose owner cannot be identified.
    const tmp = `${lock}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(holder), { mode: 0o600, flag: 'wx' });
      // link is atomic and exclusive, including against the legacy kit's wx open.
      try { fs.linkSync(tmp, lock); }
      catch (error) {
        if (error.code === 'EEXIST') return busy;
        if (!['ENOTSUP', 'ENOSYS', 'EISDIR', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
        // Filesystems without hard links still arbitrate with legacy wx holders.
        // A crash before the write leaves an empty lock, recovered by its lease.
        let fd;
        try { fd = fs.openSync(lock, 'wx', 0o600); }
        catch (error) { if (error.code === 'EEXIST') return busy; throw error; }
        try { fs.writeFileSync(fd, JSON.stringify(holder)); }
        finally { fs.closeSync(fd); }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      return await action();
    } finally {
      try { if (JSON.parse(fs.readFileSync(lock, 'utf8'))?.token === token) fs.unlinkSync(lock); }
      catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
    }
  } finally { removeClaim(claim); }
}
export function resultText(result) {
  // stdout and stderr share the head/tail budget.
  const head = clip(Buffer.from(result.stdout.head + result.stderr.head));
  const tail = clip(Buffer.from(result.stdout.tail + result.stderr.tail),true);
  return { head, tail };
}
