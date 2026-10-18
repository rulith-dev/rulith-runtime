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
// 项目内的相对路径不能含冒号：在 NTFS 上 `src/impl.txt:code` 是 impl.txt 的一个备用数据流，读写都能成功，
// 但目录遍历（tree()）看不见它，被测代码却能读到。所有工具（包括读工具）一律拒绝，与 apply_patch 和验收规格的路径
// 规则一致。只检查相对于项目根的部分，所以 Windows 盘符不受影响。
// A project-relative path never contains a colon: on NTFS `src/impl.txt:code` is an alternate data stream of
// impl.txt that reads and writes succeed on but no directory walk (tree()) sees, while tested code can read it.
// Every tool refuses it, reads too, as apply_patch and acceptance spec paths do. Only the part relative to the
// project root is checked, so a Windows drive letter is unaffected.
export function fenced(root, name = '.') {
  if (typeof name !== 'string' || name.includes('\0')) refuse('path refused');
  const target = path.resolve(root, name);
  if (!inside(root, target) || path.relative(root, target).includes(':')) refuse('path refused');
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
  if (!inside(root, target) || path.relative(root, target).includes(':')) refuse('path refused');
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
  // 项目根有两种写法：canonical 是文件系统自己的拼写（Windows 上取原生 realpath：大小写、短名都按磁盘），只用于显示；
  // folded 是身份写法（Windows 上再转小写，因为路径不分大小写），代数状态、根登记与项目身份都按它记——所以只改大小写的
  // 改名（Proj -> proj）仍是同一个项目、同一份代数。拿不到原生写法（个别虚拟卷）时退回原写法。升级时：身份写法的状态文件
  // 还不存在、原写法的存在，就从原写法的状态接着数（spelledStateFile / spelledJobFile），代数不归零。
  // A project root has two spellings: `canonical`, the file system's own (the native realpath on Windows: case and short
  // names as on disk), for display only; and `folded`, the identity spelling (lower-cased on Windows, whose paths ignore
  // case), which keys the generation state, the root record and the project identity, so a case-only rename (Proj ->
  // proj) is the same project with the same counter. Where no native spelling is available (some virtual volumes) the
  // given one stands. On upgrade, state kept under the caller's spelling is continued (spelledStateFile, spelledJobFile).
  const canonical = canonicalRoot(root);
  const folded = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const key = sha(folded), spelled = sha(root);
  const ctx = { root, home, canonical, folded, stateFile: path.join(home, `tree-${key}.json`), jobFile: path.join(home, `job-${key}.json`),
    rootFile: path.join(home, `root-${key}.json`), cacheFile: path.join(home, `tree-cache-${key}.json`),
    ...(spelled === key ? {} : { spelledStateFile: path.join(home, `tree-${spelled}.json`), spelledJobFile: path.join(home, `job-${spelled}.json`) }) };
  recordRoot(ctx);
  return ctx;
}
function canonicalRoot(root) {
  if (process.platform !== 'win32') return root;
  try { return fs.realpathSync.native(root); } catch { return root; }
}
// 每个用过的项目根都登记在 kit home（root-<key>.json）。一个根若在另一个已登记的根里面、或包着它，就拒绝：代数按根计，
// 经外层根的写入不会撤回内层根的通过（反之亦然）。先登记、再检查，所以两个同时第一次出现的嵌套根至少有一个被拒绝；
// 被拒绝的根撤回它这次刚写下的登记。要改用旧项目里面或外面的目录，主人删掉旧项目的 root-*.json。
// Every project root used is recorded in the kit home (root-<key>.json). A root inside or around another recorded root
// is refused: generations are counted per root, so a write through the outer root would not withdraw a pass of the
// inner one (or the reverse). The record is written before the check, so of two nested roots appearing at once at least
// one is refused; a refused root removes the record it has just written. To use a directory inside or around a former
// project, the owner removes that project's root-*.json.
function recordRoot(ctx) {
  let created = false;
  if (!fs.existsSync(ctx.rootFile)) { save(ctx.rootFile, { root: ctx.canonical }); created = true; }
  for (const other of recordedRoots(ctx.home)) {
    if (other.file === path.basename(ctx.rootFile)) continue;
    if (inside(other.folded, ctx.folded) || inside(ctx.folded, other.folded)) {
      if (created) try { fs.unlinkSync(ctx.rootFile); } catch {}
      refuse('project root overlaps another project');
    }
  }
}
function recordedRoots(home) {
  const out = [];
  for (const file of fs.readdirSync(home).filter(name => /^root-[a-f0-9]{64}\.json$/.test(name))) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(home, file), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; refuse('pin directory refused'); }
    if (typeof record?.root !== 'string' || !path.isAbsolute(record.root)) refuse('pin directory refused');
    out.push({ file, folded: process.platform === 'win32' ? record.root.toLowerCase() : record.root });
  }
  return out;
}
// 本 kit home 的随机身份（<kit home>/kit-id）：只在一个项目第一次需要身份时读，用来算这个新项目的身份。先写临时文件再
// 改名，读者永远看不到半个文件；缺了或坏了就重写一个——已有项目的身份已经固定（见 projectIdentity），不受影响。
// This kit home's random identity (<kit home>/kit-id), read only when a project first needs an identity, to derive it.
// Written to a temporary file and renamed, so no reader ever sees part of it; a missing or damaged one is written
// anew, which changes no existing project: their identities are already fixed (projectIdentity).
const KIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function kitId(home) {
  const file = path.join(home, 'kit-id');
  const read = () => { try { const value = fs.readFileSync(file, 'utf8'); return KIT_ID.test(value) ? value : null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const known = read();
  if (known) return known;
  saveText(file, randomUUID());
  // Two first uses may each write one; whichever stands is read back and used from here on.
  return read() ?? refuse('pin directory refused');
}
// 项目身份第一次用时定下，之后随代数状态保存（state.project），根登记里另存一份（root-<key>.json 的 project）；以后只读
// 保存的值，从不重算。所以删 kit-id、或同一目录换个大小写写法，都不会让同一份代数换一个身份（换了身份，旧身份下的通过
// 就再也没有树步撤回）。两份都没有时才由 kit-id 与身份写法算出，并在根锁内写下。
// A project's identity is fixed at first use and kept with its generation state (state.project), with a copy in its root
// record (root-<key>.json `project`); from then on the kept value is read, never recomputed. Removing kit-id, or
// another spelling of the same directory, therefore never gives one counter a new identity (under which a pass made with
// the old identity would never again meet a tree step). Only when neither copy exists is it derived from kit-id and the
// identity spelling, and written under the root's lock.
const PROJECT = /^[0-9a-f]{64}$/;
export function keptProject(ctx, state = readJson(ctx.stateFile, null) ?? (ctx.spelledStateFile ? readJson(ctx.spelledStateFile, null) : null)) {
  if (PROJECT.test(state?.project ?? '')) return state.project;
  const record = readJson(ctx.rootFile, {});
  return PROJECT.test(record?.project ?? '') ? record.project : undefined;
}
export const projectIdentity = (ctx, state) => keptProject(ctx, state) ?? sha(`${kitId(ctx.home)}\n${ctx.folded}`);
// The root record after a save of the generation state: the identity and the last generation, so a lost state file
// resumes from that generation with a step out of it (see the adapter) instead of restarting at 0.
export function keepRoot(ctx, state) {
  const record = readJson(ctx.rootFile, {});
  const project = state.project ?? record.project, gen = state.gen ?? record.gen;
  const next = { root: ctx.canonical, ...(project ? { project } : {}), ...(gen === undefined ? {} : { gen }) };
  if (JSON.stringify(record) !== JSON.stringify(next)) save(ctx.rootFile, next);
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export function save(file, value) { saveText(file, JSON.stringify(value)); }
// Written whole to a fresh temporary file, then renamed over the target: a reader sees the old bytes or the new ones.
export function saveText(file, text) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function pin(ctx, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) refuse('spec refused: spec_id is letters, digits, - and _ (at most 64)');
  // self- 规格只认小写的规范写法：在不区分大小写的文件系统上 SELF-x 会打开冻结的 specs/self-x.json，却走主人规格的
  // 分支（不过分类器、可用 shell、解释器不受限）。任何大小写变体都拒绝。
  // A self- spec_id is canonical lower case: on a case-insensitive file system SELF-x opens the frozen specs/self-x.json
  // through the owner's branch (no classifier, shell honoured, any interpreter). Every other case is refused.
  if (/^self-/i.test(id) && !/^self-[a-z0-9_-]+$/.test(id)) refuse('spec refused: a self- spec_id is lower case');
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
  // 模型写的 self- 测量规格（冻结到 kit home 后也一样）不贡献任何排除：否则模型写一个 output_dirs 就能让
  // 每个工具的树摘要都看不见那里的改动。只有主人写的规格和 treeExclude 算数。
  // A self- spec is model-written even once frozen into the kit home: its output_dirs never hide anything.
  for (const name of settings(ctx.home).treeExclude) names.add(name.replaceAll('\\', '/').replace(/\/$/, ''));
  const directory = path.join(ctx.home, 'specs');
  if (!inside(ctx.home, fs.realpathSync(directory))) refuse('spec refused');
  for (const entry of fs.readdirSync(directory).sort()) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(entry) || /^self-/i.test(entry)) continue;
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
// The files under a folder the tree digest skips, walked on demand (at most 20000; **/ folders and links skipped).
export function filesUnder(ctx, prefix) {
  const skip = exclusions(ctx).filter(s => s.startsWith('**/'));
  const start = fenced(ctx.root, prefix);
  if (!fs.statSync(start).isDirectory()) return [prefix];
  const out = []; const queue = [prefix];
  while (queue.length && out.length < 20000) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(fenced(ctx.root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink() || skipped(skip, name)) continue;
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
  // outside the project, one per project root (tree-cache-<key>.json), so alternating projects do not evict each other.
  // It is a speed-up for an honest tree, not a guard against deliberate mtime forgery.
  const cacheFile = ctx.cacheFile ?? path.join(ctx.home, 'tree-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  const next = {};
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix + entry.name;
      // 只有项目根的 .git 被排除（它在 exclusions() 里）；更深处名为 .git 的文件或目录和其他文件一样计入摘要，
      // 否则模型可以把代码藏进 src/.git。主人可以在 treeExclude 里写 **/.git 排除嵌套仓库。
      // Only <root>/.git is excluded (it is in exclusions()); a .git entry deeper down is hashed like any other, or
      // code could hide under src/.git. The owner may add **/.git to treeExclude for nested repositories.
      if (skipped(skip, name)) continue;
      const file = fenced(ctx.root, name);
      // Links are recorded, never followed (cycles and aliases do not duplicate files).
      if (entry.isSymbolicLink()) files[name] = sha(`link:${fs.readlinkSync(path.join(dir, entry.name))}`);
      else if (entry.isDirectory()) { files[`${name}/`] = 'directory'; visit(file, `${name}/`); }
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        const known = cache[name];
        // 刚改过的文件不信缓存（与 git 的 racy 处理相同）：文件时间按系统时钟节拍（Windows 约 15 ms）更新，同一节拍内两次
        // 等长写入的 size 与 mtime 相同，缓存会把第二次写入当成没变，一步就被看漏（2026-10-17 在 apply_patch 回放测试里实测）。
        // A file modified within the last two seconds is always rehashed (git's racy-timestamp rule): file times move
        // at the clock tick (about 15 ms on Windows), so two equal-size writes inside one tick share size and mtime
        // and the cache would call the second one unchanged, losing a step (seen in the apply_patch replay test).
        const racy = Date.now() - stat.mtimeMs < 2000;
        const digest = !racy && known && known[0] === stat.size && known[1] === stat.mtimeMs ? known[2] : fileDigest(file);
        next[name] = [stat.size, stat.mtimeMs, digest];
        files[name] = `${stat.mode & 0o777}:${digest}`;
      }
      else refuse('path refused');
    }
  }
  visit(ctx.root);
  try { fs.writeFileSync(cacheFile, JSON.stringify(next)); } catch {}
  // 只哈希主人的规格。冻结的 self- 副本由测量第一次写入且之后不变，它的来源（.deep-rulith/measure/）本来就在项目树里；
  // 把它算进来会让第一次测量凭空记一步。
  // Only the owner's specs: a frozen self- copy is written by its first measurement and never changes, and its source
  // (.deep-rulith/measure/) is in the project tree already; counting it made that first measurement a spurious step.
  const specs = fs.readdirSync(path.join(ctx.home,'specs')).filter(e => /^[a-zA-Z0-9_-]+\.json$/.test(e) && !/^self-/i.test(e)).sort().map(e => [e, sha(fs.readFileSync(path.join(ctx.home, 'specs', e)))]);
  return { files, digest: sha(sha(JSON.stringify({ specs, files })) + treeSettings(ctx, skip)) };
}
// 树的身份包括决定“哪些文件被哈希、什么可以运行”的设置：生效的排除集合、shell、allow 与 allowedPaths。
// 放宽 treeExclude（或改动其中任何一项）会改变 tree_digest，所以和一次写入一样记一步，之前的通过随之失效。
// The tree's identity includes the settings that decide what is hashed and what may run: the effective exclusions,
// shell, allow and allowedPaths. tree_digest = sha256(file-tree digest ‖ this digest), so widening treeExclude (or
// changing any of these settings) changes the digest and is a tree step like a write: earlier passes stop being current.
function treeSettings(ctx, skip) {
  const opts = settings(ctx.home);
  return sha(JSON.stringify({ exclusions: [...skip].sort(), shell: opts.shell, allow: [...opts.allow].sort(), allowedPaths: [...opts.allowedPaths].sort() }));
}
// The spellings a project path can be known by: as given, and as the file system spells its existing part (case,
// Windows 8.3 short names); each component in lower case without the trailing dots and spaces Windows drops. Used
// only to refuse or to force a step, so a spelling that matches too much costs a refusal or a step, never a gap.
function spellings(ctx, target) {
  const names = [path.relative(ctx.root, target)];
  let ancestor = target; const missing = [];
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  try { names.push(path.relative(fs.realpathSync.native(ctx.root), path.join(fs.realpathSync.native(ancestor), ...missing))); } catch {}
  return names.map(name => name.split(/[\\/]/).map(part => part.toLowerCase().replace(/[. ]+$/, '')).join('/'));
}
// <root>/.git is always excluded from the tree digest, so the kit never writes there or runs a command inside it.
export function refuseRootGit(ctx, target) {
  if (spellings(ctx, target).some(name => name.split('/')[0] === '.git')) refuse('path refused');
}
// 主人的排除不是放被测代码的地方：写工具或 apply_patch 写到排除路径下时强制记一步（当作树身份的改变）。
// Owner exclusions are not a place for tested code: a write tool or apply_patch touching a path under an exclusion
// forces a tree step, as a change to the tree's identity.
export function underExclusion(ctx, targets) {
  const skip = exclusions(ctx).map(name => name.toLowerCase());
  return targets.some(target => spellings(ctx, target).some(name => skipped(skip, name)));
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
// Inline code is a command the classifier cannot read. The fence is about visible intent, not a sandbox: a script
// file named on the line can still do anything the Worker's user can, but its text is a project file anyone reads.
// 解释器只把脚本（或 python -m）之前的词当作自己的选项；之后的词是脚本的参数（`node test.mjs -p 8080`、
// `python run.py -config a.yml`），不再检查。带值的选项连同它的值一起读过；不认识、没有 `=` 的长选项按“带值”处理，
// 这样一个未知的带值选项不会让扫描提前停在它的值上（宁可误拒，不可漏放）。
// An interpreter reads options only before its script (or python -m); later words are the script's arguments and are
// not inline code. An option's separate value is read with it; an unknown long option without `=` is taken to have
// one (fail closed: a value-taking option must not end the scan early).
const basename = word => path.basename(word).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
const NODE_FLAGS = new Set(('abort-on-uncaught-exception allow-addons allow-child-process allow-inspector allow-wasi allow-worker '
  + 'build-snapshot check completion-bash cpu-prof disable-sigusr1 disable-wasm-trap-handler disallow-code-generation-from-strings '
  + 'enable-etw-stack-walking enable-fips enable-source-maps entry-url enable-network-family-autoselection experimental-addon-modules '
  + 'experimental-default-config-file experimental-eventsource experimental-import-meta-resolve experimental-inspector-network-resource '
  + 'experimental-network-inspection experimental-print-required-tla experimental-require-module experimental-strip-types '
  + 'experimental-test-coverage experimental-test-module-mocks experimental-transform-types experimental-vm-modules '
  + 'experimental-webstorage experimental-worker-inspection expose-gc expose-internals force-context-aware force-fips '
  + 'force-node-api-uncaught-exceptions-policy frozen-intrinsics heap-prof help insecure-http-parser inspect inspect-brk inspect-wait '
  + 'interactive interpreted-frames-native-stack jitless node-memory-debug openssl-legacy-provider openssl-shared-config '
  + 'pending-deprecation permission preserve-symlinks preserve-symlinks-main prof prof-process report-compact report-exclude-env '
  + 'report-exclude-network report-on-fatalerror report-on-signal report-uncaught-exception test test-force-exit test-only '
  + 'test-update-snapshots throw-deprecation tls-max-v1.2 tls-max-v1.3 tls-min-v1.0 tls-min-v1.1 tls-min-v1.2 tls-min-v1.3 '
  + 'trace-deprecation trace-env trace-env-js-stack trace-env-native-stack trace-exit trace-promises trace-sigint trace-sync-io '
  + 'trace-tls trace-uncaught trace-warnings track-heap-objects use-bundled-ca use-env-proxy use-openssl-ca use-system-ca '
  + 'v8-options version watch watch-preserve-output zero-fill-buffers').split(' '));
// A short option takes a separate value when its first value letter ends the word (`-W x`, `-Ilib` has it attached).
const valueAtEnd = (word, letters) => { const at = [...word.slice(1)].findIndex(c => letters.includes(c)); return at >= 0 && at + 2 === word.length; };
// 每种解释器：inline 认出内联代码选项（单独、组合或附带值的写法）；flags 是不带值的长选项；value 判断短选项是否带一个
// 单独的值。认不出的短选项一律按“带值”处理（宁可误拒）：把带值的当作不带值，会让它的值被当成脚本而提前结束扫描。
// Per interpreter: `inline` recognises an inline-code option (alone, combined or attached); `flags` names the long
// options without a value; `value` says whether a short option takes a separate value. Where unsure a short option is
// taken to have one (fail closed): reading a value-taking option as a flag would end the scan early on its value.
const INTERPRETERS = {
  // node and the runners that take its flags (nodejs, bun, tsx, ts-node): -e/-p alone, combined (-pe) or attached
  // (-e<code>); --eval and --print. -r/--require/--import/--loader preload a module named by their value: a module
  // (tsx, ts-node/register) is a file anyone can read, a data: URL is inline code.
  node: { flags: name => NODE_FLAGS.has(name) || name.startsWith('no-'),
    value: word => !['-v', '-h', '-i', '-b', '-T'].includes(word),
    inline: x => /^-[a-z]*[ep]/i.test(x) && !x.startsWith('--') || /^--(eval|print)(=|$)/.test(x) },
  // python (python3, pythonw, pypy3, py): c in a short cluster before m, W or X (-c, -Ic, -Rc); -m ends the options,
  // and the modules that evaluate their own arguments (timeit, pdb, profile, cProfile, code, IPython) count as inline.
  python: { flags: name => ['help', 'version', 'help-env', 'help-xoptions', 'help-all'].includes(name),
    inline: x => /^-[^-mWX]*c/.test(x),
    cluster: x => { const at = x.slice(1).search(/[mWX]/); return at < 0 ? 'none' : x[at + 1] === 'm' ? 'end' : at + 2 === x.length ? 'value' : 'none'; } },
  // perl: e/E in a cluster before a letter that takes a value (-ne, -lE).
  perl: { flags: () => false, value: word => valueAtEnd(word, 'IMmxiCdD'), inline: x => /^-[^-IMmxiCdD]*[eE]/.test(x) },
  // ruby: e in a cluster before a letter that takes a value; -E is the encoding (ruby -E UTF-8 x.rb runs).
  ruby: { flags: name => ['verbose', 'version', 'help', 'copyright', 'yjit', 'jit'].includes(name),
    value: word => valueAtEnd(word, 'IrCExFi'), inline: x => /^-[^-IrCExFi]*e/.test(x) },
  // php: -r, -B, -R, -E run code.
  php: { flags: () => false, value: word => valueAtEnd(word, 'bcdfFStz'), inline: x => /^-[^-bcdfFStz]*[rBRE]/.test(x) },
  // R and Rscript: -e.
  r: { flags: name => ['vanilla', 'verbose', 'version', 'help', 'no-environ', 'no-site-file', 'no-init-file', 'restore',
    'no-restore', 'save', 'no-save', 'quiet', 'silent', 'slave', 'interactive', 'no-echo'].includes(name),
    value: word => valueAtEnd(word, 'fdg'), inline: x => /^-[^-fdg]*e/.test(x) },
};
const INLINE_MODULES = new Set(['timeit', 'pdb', 'profile', 'cprofile', 'code', 'ipython']);
const interpreterKind = exe => ['node', 'nodejs', 'bun', 'tsx', 'ts-node'].includes(exe) ? 'node'
  : /^(python[0-9.]*w?|pythonw[0-9.]*|pypy[0-9.]*|pyw?)$/.test(exe) ? 'python'
  : ['perl', 'ruby', 'php'].includes(exe) ? exe : ['r', 'rscript'].includes(exe) ? 'r' : null;
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'wscript', 'cscript'];
// deno options that take a separate value; the others are flags or use `=`.
const DENO_VALUES = ['-c', '--config', '--import-map', '--lock', '--cert', '--location', '--seed', '--filter', '--reporter',
  '--coverage', '--log-level', '-L', '--preload', '--ext', '--junit-path', '--env-file'];
// Launcher options that take no value; every other launcher option without `=` is taken to have one (fail closed).
const LAUNCHER_FLAGS = ['-y', '--yes', '--no', '-q', '--quiet', '--silent', '-s', '--no-install', '--ignore-existing',
  '--prefer-offline', '--offline', '--verbose', '-v', '--no-capture-output', '--live-stream', '--frozen', '--locked',
  '--isolated', '--no-sync', '--no-project', '-0', '-t', '-r'];
// Where a launcher's own options start: it runs another program named on the line. 0 when the word is no launcher.
function launcherAt(command) {
  const exe = basename(command[0]), sub = command[1];
  if (['npx', 'bunx', 'pnpx', 'uvx', 'time', 'nice', 'nohup', 'timeout', 'xargs', 'find', 'stdbuf'].includes(exe)) return 1;
  if ((['npm', 'pnpm', 'yarn', 'bun', 'deno'].includes(exe) && ['exec', 'x', 'dlx'].includes(sub))
    || (['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'pipx', 'conda', 'rye'].includes(exe) && sub === 'run')
    || (exe === 'bundle' && sub === 'exec')) return 2;
  if (exe === 'uv' && sub === 'tool' && command[2] === 'run') return 3;
  return 0;
}
// shellAllowed: the owner's shell setting. A shell named after a launcher is refused without it, like one named first.
function inlineCode(command, shellAllowed, depth = 0) {
  // A launcher inside a launcher inside ...: past four levels the line is refused rather than read further.
  if (depth > 4) return true;
  const exe = basename(command[0]);
  if (SHELLS.includes(exe)) return !shellAllowed && depth > 0;
  // git -c and --config-env set configuration for one command (alias.*, core.pager, core.sshCommand, ... run programs).
  if (exe === 'git') {
    for (let i = 1; i < command.length; i++) {
      const word = command[i];
      if (word === '-c' || /^--config-env(=|$)/.test(word)) return true;
      if (['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--attr-source'].includes(word)) { i++; continue; }
      if (!word.startsWith('-')) break;
    }
    return false;
  }
  // awk runs the program text given on the line; only a program file (-f) is read from the project.
  if (/^[gmn]?awk$/.test(exe)) {
    const words = command.slice(1);
    return !words.some(w => /^(-f|--file)(=|$)/.test(w) || /^-f./.test(w)) || words.some(w => /^(-e|--source)(=|$)/.test(w) || /^-e./.test(w));
  }
  // deno evaluates code with eval (and repl --eval), --eval/--print/-e/-p before the script, and any data: module.
  if (exe === 'deno' && !['exec', 'x', 'dlx'].includes(command[1])) {
    if (command[1] === 'eval' || command.some(w => /^data:/i.test(w))) return true;
    if (command[1] === 'repl' && command.some(w => /^--eval(=|$)/.test(w))) return true;
    for (let i = command[1] && !command[1].startsWith('-') ? 2 : 1; i < command.length; i++) {
      const word = command[i];
      if (word === '--' || !word.startsWith('-')) return false;
      if (/^--(eval|print)(=|$)|^-[ep]$/.test(word)) return true;
      if (DENO_VALUES.includes(word)) i++;
    }
    return false;
  }
  const launcher = launcherAt(command);
  if (launcher) {
    // yarn exec runs its argument as a shell line.
    if (exe === 'yarn' && command[1] === 'exec' && !shellAllowed) return true;
    // The launcher's options up to the program it runs: -c/--call/--shell-mode hand npx, npm exec and pnpm exec a shell line.
    for (let i = launcher; ['npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'bun'].includes(exe) && i < command.length; i++) {
      const word = command[i];
      if (word === '--' || !word.startsWith('-')) break;
      if (/^-[^-]*c/.test(word) || /^--(call|shell-mode)(=|$)/.test(word)) return true;
      if (!word.includes('=') && !LAUNCHER_FLAGS.includes(word)) i++;
    }
    // Every later word may be the program (or a value the scan above took for it): each is read as a command.
    for (let i = launcher; i < command.length; i++) if (inlineCode(command.slice(i), shellAllowed, depth + 1)) return true;
    return false;
  }
  const kind = interpreterKind(exe);
  if (!kind) return false;
  const rules = INTERPRETERS[kind];
  // `bun run` may stand before bun's options; they are read after it as well.
  for (let i = exe === 'bun' && command[1] === 'run' ? 2 : 1; i < command.length; i++) {
    const word = command[i];
    // The script: node cannot be handed an inline data: module in its place either.
    if (word === '--' || word === '-' || !word.startsWith('-')) return kind === 'node' && /^data:/i.test(word);
    if (rules.inline(word)) return true;
    const long = word.startsWith('--');
    const shape = !long && rules.cluster ? rules.cluster(word) : null;
    if (shape === 'end') {
      const attached = word.slice(word.indexOf('m') + 1);
      return INLINE_MODULES.has((attached || command[i + 1] || '').toLowerCase());
    }
    const value = long ? !word.includes('=') && !rules.flags(word.slice(2)) : rules.cluster ? shape === 'value' : rules.value(word);
    if (value && i + 1 < command.length) { i++; if (rules.inline(command[i]) || /^data:/i.test(command[i])) return true; }
  }
  return false;
}
export function classify(ctx, input, cwd = '.') {
  const opts = settings(ctx.home);
  const command = argv(input);
  if (command.length === 0 || command.some(x => typeof x !== 'string' || !x || /[\0\r\n]/.test(x))) refuse('command refused');
  const resolvedCwd = fenced(ctx.root, cwd);
  if (!fs.statSync(resolvedCwd).isDirectory()) refuse('path refused');
  refuseRootGit(ctx, resolvedCwd);
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
  if (inlineCode(command, opts.shell)) refuse('command refused');
  // A data: URL given to any option (--import=data:..., --test-reporter=data:..., --loader=data:...) is inline code.
  if (command.some(x => /^-[^=]*=data:/i.test(x))) refuse('command refused');
  // Relaxable by the owner's settings.
  if (SHELLS.includes(exe) && !opts.shell) refuse('command refused');
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
    // The root .git is outside the tree digest: no command names a path in it.
    const named = path.resolve(resolvedCwd, value);
    if (inside(ctx.root, named)) refuseRootGit(ctx, named);
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
// 子进程不继承 kit 与 Worker 的变量：ENG_*（ENG_KIT_HOME 指向主人的 settings.json、规格、树缓存与状态文件，脚本拿到
// 它就能放宽 treeExclude 或改写状态）和 RULITH_*。变量名在 Windows 上不分大小写，所以按不分大小写比较。
// Children never inherit the kit's or the Worker's variables: ENG_* (ENG_KIT_HOME names the owner's settings.json,
// specs, tree cache and state file, which a script could rewrite) and RULITH_*. Compared without case (Windows).
// Windows 上程序名还会先在当前目录里找：项目里一个 node.exe 就能顶替 PATH 上的 node，而验收规格冻结的是命令字，
// 不是它找到的程序。NoDefaultCurrentDirectoryInExePath=1 关掉这一步：给子进程（cmd.exe 与它再启动的程序读它），也给
// 本进程（Node 不经 shell 启动程序时，查找按本进程的环境）。
// On Windows a bare program name is looked up in the current directory first: a node.exe in the project would stand in
// for the node on PATH, while an acceptance spec freezes the command words, not what they find.
// NoDefaultCurrentDirectoryInExePath=1 turns that lookup off, for the child (cmd.exe and what it starts read it) and for
// this process (Node's own lookup without a shell follows this process's environment).
const WINDOWS_NO_CWD_LOOKUP = 'NoDefaultCurrentDirectoryInExePath';
export const childEnv = (env = process.env) => ({
  ...Object.fromEntries(Object.entries(env).filter(([name]) => !/^(ENG_|RULITH_)/i.test(name)
    && !(process.platform === 'win32' && name.toLowerCase() === WINDOWS_NO_CWD_LOOKUP.toLowerCase()))),
  ...(process.platform === 'win32' ? { [WINDOWS_NO_CWD_LOOKUP]: '1' } : {}),
});
// 命令字会启动哪个文件，与真正运行时的查找一致（都不看当前目录，见 execute）。
// 不经 shell：Node 交给 libuv。Windows 上 libuv 只在名字自带扩展名时试原名，然后试 .com、.exe——从不试 PATHEXT 里的
// .cmd、.bat；其他系统按 execvp：带 / 的相对 cwd，裸名查 PATH（空项是当前目录，缺 PATH 用 /usr/bin:/bin），只认可执行文件。
// 带路径的名字相对 cwd；PATH 里的相对项也相对 cwd。返回第一个命中，就是会运行的那个。
// 经 shell（规格 shell: true）：shell 自己找程序（cmd.exe 用 PATHEXT），一行还能启动好几个程序。这里不模仿 shell 的
// 解析，而是返回这个词所有可能被启动的文件（Windows 上原名加每个 PATHEXT 扩展名，所有目录），调用方对行里每个词都查：
// 多查只会多拒，不会漏。变量与替换展开出来的名字看不见（README：shell 下分类器只是参考）。
// The file a command word starts, found as the run finds it (neither looks in the current directory; see execute).
// Without a shell Node hands the word to libuv. On Windows libuv tries the name itself only when it has an extension,
// then name.com and name.exe, never PATHEXT's .cmd or .bat; elsewhere it follows execvp: a word with / is relative to
// cwd, a bare name is looked up on PATH (an empty entry is the current directory, no PATH means /usr/bin:/bin), and
// only executable files count. A relative PATH entry is taken relative to cwd. The first hit is what runs.
// With a shell (a spec with shell: true) the shell finds programs itself (cmd.exe with PATHEXT) and one line can start
// several. Rather than imitate its parsing, `shell` returns every file the word could start (on Windows the name and
// the name with each PATHEXT extension, in every directory), and the caller checks every word of the line: checking
// more can only refuse more, never miss one. Names produced by variables or substitutions are not seen (the README:
// with a shell the classifier is advisory).
export function programCandidates(word, cwd, { env = childEnv(), shell = false } = {}) {
  const windows = process.platform === 'win32';
  const value = name => Object.entries(env).find(([key]) => windows ? key.toLowerCase() === name.toLowerCase() : key === name)?.[1];
  const base = word.split(windows ? /[\\/:]/ : '/').at(-1), dot = base.lastIndexOf('.');
  const extensions = !windows ? [''] : shell ? ['', ...(value('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [...(dot >= 0 && dot < base.length - 1 ? [''] : []), '.com', '.exe'];
  const named = windows ? /[\\/:]/.test(word) : word.includes('/');
  const entries = (value('PATH') ?? (windows ? '' : '/usr/bin:/bin')).split(path.delimiter).map(dir => dir.replace(/^"(.*)"$/, '$1'));
  const directories = named ? [cwd] : entries.flatMap(dir => dir ? [path.resolve(cwd, dir)] : windows ? [] : [cwd]);
  const found = [];
  for (const directory of directories) for (const extension of extensions) {
    const candidate = path.resolve(directory, word + extension);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
      found.push(fs.realpathSync(candidate));
      if (!shell) return found;
    } catch {}
  }
  return found;
}
export const resolveProgram = (word, cwd, env = childEnv()) => programCandidates(word, cwd, { env })[0];
export async function execute(command, cwd, { deadlineMs = 35000, onStart, shell = false, line } = {}) {
  const stdout = capture(); const stderr = capture(); const start = Date.now();
  let timedOut = false;
  if (process.platform === 'win32') process.env[WINDOWS_NO_CWD_LOOKUP] = '1';
  const env = childEnv();
  // With the owner's shell setting the command line goes to the system shell as written; otherwise argv, no shell.
  const child = shell
    ? spawn(line ?? command.join(' '), { cwd, env, shell: true, detached: GROUP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(command[0], command.slice(1), { cwd, env, shell: false, detached: GROUP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (!entry.isFile() || !/^(?:tree-[a-f0-9]{64}\.json(?:\.lock)?|job-[a-f0-9]{64}\.json|root-[a-f0-9]{64}\.json|kit-id|tree-cache(?:-[a-f0-9]{64})?\.json)\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue;
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
