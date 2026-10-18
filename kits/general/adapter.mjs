import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { applyPatch } from './apply-patch.mjs';
import { globFiles } from './glob-files.mjs';
import { readImage } from './image.mjs';
import { fetchPage, searchWeb } from './web.mjs';
import { acceptanceSpec, acceptanceRows, verifyAcceptanceFiles, checkSpecRow, checkKey, FIELD_ERRORS, isFieldError } from './acceptance-specs.mjs';
import { settings, context, keptProject, projectIdentity, keepRoot, resolveProgram, inside, fenced, tree, excluded, filesUnder, changed, sha, fileDigest, clip, textLimit, classify, execute, childEnv, refuseRootGit, underExclusion, locked, readJson, save, pin, refuse, sleep, resultText } from './lib.mjs';
const ROW_BYTES = 1800;
const READ_TOOLS = ['list', 'read', 'read_v2', 'search', 'tree_state', 'glob', 'read_image', 'web_fetch', 'web_search'];
// 项目版工具（官方编程能力，编程包第三版）：行为与括号里的原工具相同，只是回执带上项目——每行带 project（所以
// eng.tree_step 带它），检查结果与规格还带验收键 key。代数仍是这一个项目根的同一份；原版本的回执一字不改。
// The project tools (official engineering capability, program v3) behave exactly as the tool named beside them; their
// receipts also carry the project: every row has `project` (so eng.tree_step does), and check results and specs the
// check key `key`. The generation counter is the root's one counter; the original versions' receipts are unchanged.
const PROJECT_TOOLS = { write_file_v2: 'write_file', patch_file_v2: 'patch_file', apply_patch_v2: 'apply_patch', run_v2: 'run',
  job_start_v2: 'job_start', job_poll_v2: 'job_poll', job_stop_v2: 'job_stop', test_v3: 'test_v2', acceptance_v2: 'acceptance' };
const baseTool = name => Object.hasOwn(PROJECT_TOOLS, name) ? PROJECT_TOOLS[name] : name;
// A receipt carries every row twice (the result text and its facts) inside the Worker's inline budget (8 KiB on
// rulith.ai). Listing and search keep at most ROW_BYTES of rows, whole rows at a time, and say when they stopped short.
function fitRows(tool, rows, per) {
  let out = rows; let cut = false;
  if (tool === 'list' || tool === 'search')
    while (out.length > per && Buffer.byteLength(JSON.stringify(out)) > ROW_BYTES) { out = out.slice(0, out.length - per); cut = true; }
  return { rows: out, cut };
}
const READ_TEXT_BYTES = 5000;
// The bytes a text takes inside the Worker's receipt: once as adapter output JSON, once more as a JSON string.
const encoded = (text) => Buffer.byteLength(JSON.stringify(JSON.stringify(text)));
// The longest prefix of `bytes` that ends on a character boundary and whose text fits `budget` encoded bytes.
function fit(bytes, budget) {
  let low = 0, high = bytes.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoded(bytes.subarray(0, mid).toString('utf8')) <= budget) low = mid; else high = mid - 1;
  }
  let end = low;
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

export async function perform(name, args = {}, env = process.env, dependencies = {}) {
  const ctx = context(env);
  const tool = baseTool(name);
  const projectTool = tool !== name;
  // The project as an eng.check_spec row names it: identity, Source name, root (see checkSpecRow).
  const named = id => ({ id, source: env.RULITH_SOURCE_NAME ?? '', root: ctx.canonical });
  // Web receipts use lab's accreditation but neither observe nor mutate its files.
  if (tool === 'web_fetch') return fetchPage(ctx, args, dependencies);
  if (tool === 'web_search') return searchWeb(ctx, args, env, dependencies);
  if (tool === 'acceptance') {
    if (!projectTool) return acceptanceRows(ctx, args);
    if (Object.keys(args).length) refuse('acceptance takes no arguments');
    // A project's first identity is fixed under its root's lock (one value however many first calls race).
    const id = keptProject(ctx) ?? await locked(ctx, async () => {
      const id = projectIdentity(ctx);
      keepRoot(ctx, { project: id });
      return id;
    });
    return acceptanceRows(ctx, args, named(id));
  }
  return locked(ctx, async () => {
    // 升级窗口：原写法下还有一个在跑的任务时，照样认它（写与运行照旧被拒，轮询与停止找得到它）。
    // Upgrade window: a job still running under the caller's former spelling is found there (writes and runs stay
    // refused, poll and stop reach it).
    const jobFile = !fs.existsSync(ctx.jobFile) && ctx.spelledJobFile && fs.existsSync(ctx.spelledJobFile) ? ctx.spelledJobFile : ctx.jobFile;
    let job = readJson(jobFile, {});
    const prior = readJson(ctx.stateFile, null) ?? (ctx.spelledStateFile ? readJson(ctx.spelledStateFile, null) : null);
    const kept = keptProject(ctx, prior);
    const project = projectTool ? kept ?? projectIdentity(ctx, prior) : undefined;
    // 一个根一旦有了项目身份（项目版工具用过），旧版本的写、运行、测试与测量就拒绝：它们的树步不带项目，撤回不了
    // 第三版的通过。读工具照旧（它们不记树步，见下）。
    // Once a root has a project identity (a project tool used it), the older versions that write, run, test or measure
    // are refused: their tree steps carry no project and could not withdraw a program v3 pass. Reads are unaffected
    // (they report no tree step; see below).
    if (!projectTool && kept && !READ_TOOLS.includes(tool)) refuse('project tools required');
    // While a job runs it owns the tree's changes: other writes and runs wait, but reads go ahead. Such a read leaves
    // the recorded tree state alone; the job's poll accounts for what changed.
    const live = ['starting', 'running', 'stopping'].includes(job.status);
    const observing = live && READ_TOOLS.includes(tool);
    if (live && !observing && !['job_poll', 'job_stop'].includes(tool)) refuse('job live: only poll, stop and reads accepted');
    let acceptance;
    if (tool === 'test_v2') {
      if (Object.keys(args).length !== 1 || !Object.hasOwn(args, 'check')) refuse('acceptance check invalid');
      acceptance = acceptanceSpec(ctx, args.check);
      // A spec the person cannot read in full on the Board (eng.check_spec) can never pass.
      checkSpecRow(args.check, acceptance, project === undefined ? undefined : named(project));
      verifyAcceptanceFiles(ctx, acceptance.spec);
      acceptance.command = acceptanceCommand(ctx, acceptance.spec);
    }
    const before = observing && tool !== 'search' ? null : tree(ctx);
    // 状态文件丢了而根登记还记得上一个代数 H：从 H 接着数，摘要未知，所以这次一定记一步 H -> H+1，并像"通过之后的
    // 第一步"一样重放，H 时的通过因此被撤回，而不是从 0 重数让它一直有效。
    // A lost state file whose root record still knows the last generation H resumes at H with an unknown digest: this
    // call records the step H -> H+1 and replays it like the first step after a pass, so a pass at H is withdrawn
    // instead of outliving a counter restarted at 0.
    const record = readJson(ctx.rootFile, {});
    const state = prior ?? (Number.isSafeInteger(record.gen) ? { gen: record.gen, digest: '', test_gen: record.gen }
      : { gen: 0, digest: before?.digest ?? '' });
    let rows = []; let text = {}; let more = false; let unreadable = 0;
    const file = () => fenced(ctx.root, args.path);
    switch (tool) {
      case 'glob': { const out = globFiles(ctx, args); rows = out.rows; more = out.truncated; break; }
      case 'apply_patch': rows = applyPatch(ctx, args.patch, project); break;
      case 'read_image': { const out = readImage(ctx, args); text = { 'rulith.artifacts': out['rulith.artifacts'] }; break; }
      case 'list': {
        const target = file();
        const entries = fs.readdirSync(target, { withFileTypes: true }); more = entries.length > 128;
        rows = entries.sort((a,b) => a.name.localeCompare(b.name)).slice(0, 128).map(e => {
          const name = path.relative(ctx.root, path.join(target, e.name)).replaceAll('\\', '/');
          fenced(ctx.root, name);
          return { path: name, kind: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'link' : 'file' };
        });
        // A receipt holds at most 32 rows: the count of all entries says how much a truncated listing left out.
        text = { entries: entries.length }; break;
      }
      case 'read_v2':
      case 'read': {
        const target = file(); const size = fs.statSync(target).size; const fd = fs.openSync(target,'r');
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) { fs.closeSync(fd); refuse('offset refused'); }
        // A read returns as much text as the receipt can carry. The receipt holds the adapter's output as one JSON
        // string inside the Worker's own JSON (8 KiB inline on rulith.ai), so the text is measured encoded twice and
        // the window ends where that measure reaches READ_TEXT_BYTES: about 5 KB of plain code, less where the text
        // is mostly quotes, backslashes or line breaks. Without an offset: the start of the file, plus its last KiB
        // when the rest does not fit; with one: the window from it. The text says where the unread part starts.
        const paged = args.offset !== undefined;
        const tailOffset = paged ? size : Math.max(offset, size - 1024);
        const tail = Buffer.alloc(size - tailOffset);
        const window = Buffer.alloc(Math.min(size - offset, 3 * READ_TEXT_BYTES));
        try { fs.readSync(fd, window, 0, window.length, offset); if (tail.length) fs.readSync(fd, tail, 0, tail.length, tailOffset); } finally { fs.closeSync(fd); }
        const whole = !paged && window.length === size && encoded(window.toString('utf8')) <= READ_TEXT_BYTES;
        let tailText = paged || whole ? '' : clip(tail, true);
        // A tail of mostly escaped characters is shortened from its start, so the window keeps most of the budget.
        while (encoded(tailText) > READ_TEXT_BYTES / 4) tailText = tailText.slice(Math.ceil(tailText.length / 10));
        const head = whole ? window : fit(paged ? window : window.subarray(0, Math.max(0, tailOffset - offset)), READ_TEXT_BYTES - encoded(tailText));
        const headEnd = offset + head.length;
        const nextOffset = headEnd < (paged || whole ? size : tailOffset) ? headEnd : null;
        rows = [{ path: path.relative(ctx.root, target).replaceAll('\\', '/'), digest: fileDigest(target), bytes: size, offset,
          tail_offset: paged || whole ? headEnd : tailOffset }];
        text = { head: head.toString('utf8'), tail: tailText, next_offset: nextOffset, complete: nextOffset === null,
          start_line: lineAt(target, offset) }; break;
      }
      case 'search': {
        if (typeof args.query !== 'string' || !args.query || Buffer.byteLength(args.query) > 1024) refuse('query refused');
        const prefix = path.relative(ctx.root, file()).replaceAll('\\','/');
        // A folder the tree digest skips (settings treeExclude, for example a reference checkout under tmp/) is
        // searched when the path names it or something inside it.
        const names = excluded(ctx, prefix) ? filesUnder(ctx, prefix) : Object.keys(before.files);
        for (const name of names) {
          if (rows.length === 128) { more = true; break; }
          if (name.endsWith('/') || (prefix && name !== prefix && !name.startsWith(`${prefix}/`))) continue;
          // A file that vanished or is locked by another program while the search runs is skipped and counted,
          // instead of failing the whole search.
          let lines;
          try {
            const target = fenced(ctx.root, name);
            if (fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).size > 1024 * 1024) continue;
            lines = fs.readFileSync(target, 'utf8').split('\n');
          } catch { unreadable++; continue; }
          lines.forEach((line, i) => { if (line.includes(args.query) && rows.length < 128) rows.push({ path: name, line: i + 1, digest: sha(line) }); });
        }
        if (unreadable) text = { unreadable_files: unreadable };
        break;
      }
      case 'tree_state': rows = [{ gen: state.gen, tree_digest: before?.digest ?? state.digest }]; text = { measure_specs: measureSpecs(ctx) }; break;
      case 'write_file':
      case 'patch_file': {
        const target = file(); const content = textLimit(args.text);
        refuseRootGit(ctx, target);
        const original = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
        // expect_digest is the digest of the file being replaced; an empty one creates a file that must not exist yet.
        if (typeof args.expect_digest !== 'string') refuse('file digest changed');
        if (args.expect_digest === '' ? fs.existsSync(target) || tool === 'patch_file' : args.expect_digest !== sha(original)) refuse('file digest changed');
        let output = content;
        if (tool === 'patch_file') {
          const old = textLimit(args.old_text);
          if (Buffer.byteLength(old) + Buffer.byteLength(content) > 16384) refuse('text exceeds 16 KiB');
          const source = original.toString('utf8');
          if (!old || source.indexOf(old) < 0 || source.indexOf(old) !== source.lastIndexOf(old)) refuse('patch must match once');
          output = source.replace(old, content);
        }
        // Do not create missing parent directories implicitly.
        fenced(ctx.root, path.dirname(target));
        if (!fs.existsSync(path.dirname(target))) refuse('parent directory missing');
        fs.writeFileSync(fenced(ctx.root, args.path), output);
        const readback = fs.readFileSync(fenced(ctx.root, args.path));
        if (!readback.equals(Buffer.from(output))) refuse('read-back failed');
        rows = [{ path: path.relative(ctx.root, target).replaceAll('\\','/'), prev_digest: sha(original), digest: sha(readback), readback_digest: sha(readback), bytes: readback.length }]; break;
      }
      case 'run': {
        const command = classify(ctx, args.command, args.cwd);
        const result = await execute(command.command, command.cwd, { deadlineMs: settings(ctx.home).runSeconds * 1000, shell: command.shell, line: command.line });
        rows = [commandRow(result, args.command, before.digest)]; text = resultText(result); break;
      }
      case 'job_start': {
        const command = classify(ctx, args.command, args.cwd);
        job = { id: randomUUID(), status: 'starting', root: ctx.root, home: ctx.home, command: command.command, line: command.line, shell: command.shell, cwd: command.cwd, before: before.digest, pid: 0, supervisor_pid: 0, exit_code: -1 };
        save(jobFile, job);
        // 任务文件经 ENG_ 变量交给监督进程而不是命令行：任务命令是监督进程的子进程，读父进程的命令行就会找到 kit home；
        // 监督进程运行命令时 childEnv() 去掉所有 ENG_ 变量。这不是保密（见 README），只是不把位置递到脚本手里。
        // The job file reaches the supervisor through ENG_ variables, not argv: the job's command is the supervisor's child
        // and could read its parent's command line to find the kit home. execute() strips every ENG_ variable again for
        // the command itself. Not secrecy (see README), just not handing the location to the script.
        const child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url))], { env: { ...childEnv(), ENG_JOB_FILE: jobFile, ENG_JOB_ID: job.id }, detached: true, windowsHide: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        const limit = Date.now() + 5000;
        do { await sleep(25); job = readJson(jobFile); } while (job.status === 'starting' && Date.now() < limit);
        if (job.status === 'starting') refuse('job unavailable');
        rows = [jobRow(job)]; break;
      }
      case 'job_poll':
      case 'job_stop': {
        if (!job.id || args.job_id !== job.id) refuse('job refused');
        if (tool === 'job_stop' && ['starting','running','stopping'].includes(job.status)) fs.writeFileSync(`${jobFile}.stop`, job.id, { mode: 0o600 });
        const limits = settings(ctx.home);
        // Stopping has its own grace period; shorter poll settings must not refuse it.
        const budget = (tool === 'job_stop' ? limits.runSeconds : limits.pollSeconds) * 1000;
        const wait = tool === 'job_stop' ? Math.min(5000, budget) : (args.wait_s ?? 0) * 1000;
        if (!Number.isInteger(wait) || wait < 0 || wait > budget) refuse('wait refused');
        const until = Date.now() + wait;
        while (['starting','running','stopping'].includes(job.status) && Date.now() < until) { await sleep(Math.min(100, Math.max(1,until-Date.now()))); job = readJson(jobFile); }
        if (tool === 'job_stop' && ['starting','running','stopping'].includes(job.status)) refuse('job stop unconfirmed');
        rows = [jobRow(job)];
        if (job.result) text = resultText(job.result);
        break;
      }
      case 'test_v2':
      case 'test': {
        if (tool === 'test' && Object.keys(args).length) refuse('test takes no arguments');
        const pinned = tool === 'test' ? pin(ctx, 'test') : acceptance;
        const command = tool === 'test' ? pinnedCommand(ctx, pinned.spec) : acceptance.command;
        const result = await execute(command.command, command.cwd, { deadlineMs: settings(ctx.home).runSeconds * 1000, shell: command.shell, line: command.line });
        if (tool === 'test_v2') {
          verifyAcceptanceFiles(ctx, pinned.spec);
          if (acceptanceSpec(ctx, args.check).digest !== pinned.digest) refuse('acceptance spec changed');
        }
        rows = [{ ...(project === undefined ? {} : { key: checkKey(project, args.check, pinned.digest) }),
          ...(tool === 'test_v2' ? { check: args.check } : {}), spec_digest: pinned.digest, gen: state.gen, tree_digest: '', exit_code: result.exit_code }];
        text = resultText(result); break;
      }
      case 'measure_pinned': {
        if (Object.keys(args).some(k => k !== 'spec_id')) refuse('spec refused: the only argument is spec_id');
        const pinned = pin(ctx, args.spec_id); const spec = pinned.spec;
        const command = pinnedCommand(ctx, spec, args.spec_id.startsWith('self-'));
        // Each refusal names the field at fault (field names and fixed words only: never a path or a value).
        // Two ways to read the number: the measuring program prints one small JSON object with an integer milli-value
        // (json_integer_milli), or it writes a JSON result file inside the project and the spec names the path to one
        // number in it, scaled to milli (json_file_number_milli; the file must be rewritten by this run).
        const parser = spec.parser ?? {};
        const fileParser = parser.kind === 'json_file_number_milli';
        const pathOk = Array.isArray(parser.path) && parser.path.length >= 1 && parser.path.length <= 8
          && parser.path.every((k) => (typeof k === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(k)) || Number.isSafeInteger(k));
        if (!['ms','us','tokens_per_second','bytes_per_second'].includes(spec.unit)) refuse('spec refused: unit must be ms, us, tokens_per_second or bytes_per_second');
        if (!Number.isInteger(spec.repeats) || spec.repeats < 1 || spec.repeats > 16) refuse('spec refused: repeats must be 1 to 16');
        if (!['json_integer_milli', 'json_file_number_milli'].includes(parser.kind)) refuse('spec refused: parser kind must be json_integer_milli or json_file_number_milli');
        if (fileParser ? typeof parser.file !== 'string' || !pathOk : !/^[a-zA-Z0-9_]+$/.test(parser.field))
          refuse(fileParser ? 'spec refused: parser needs file and a path of 1 to 8 keys or indexes' : 'spec refused: parser needs field');
        for (const key of ['binary_digest', 'workload_digest', 'config_digest']) if (!/^[a-f0-9]{64}$/.test(spec[key])) refuse(`spec refused: ${key} must be a sha256 hex digest`);
        // binary, candidate_binary, workload and config are files in the project; a script that makes its own input
        // can name itself as the workload.
        const projectFile = (key) => {
          if (typeof spec[key] !== 'string' || !spec[key]) refuse(`spec refused: ${key} must name a project file`);
          let target; try { target = fenced(ctx.root, spec[key]); } catch { refuse(`spec refused: ${key} must name a project file`); }
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) refuse(`spec refused: ${key} is not a file in the project`);
          return target;
        };
        const binary = projectFile('binary'); projectFile('candidate_binary');
        // The binary's digest is checked before each repeat ('measuring binary digest changed'); the inputs here.
        for (const key of ['workload', 'config']) if (fileDigest(projectFile(key)) !== spec[`${key}_digest`]) refuse('measurement inputs changed');
        // An interpreted harness (a Python script, for example): the owner pins the interpreter by name or absolute path,
        // and the script is the pinned `binary`, the second word of the command.
        const interpreted = spec.interpreter !== undefined;
        if (interpreted && (typeof spec.interpreter !== 'string' || !spec.interpreter || spec.interpreter.includes('\0')
          || command.command[0] !== spec.interpreter || command.command.length < 2)) refuse('spec refused: command must start with the interpreter, then the binary');
        const at = interpreted ? 1 : 0;
        // A pin on an unrelated file must never accredit another program's numbers.
        const executable = path.resolve(command.cwd, command.command[at]);
        if (!fs.existsSync(executable) || fs.realpathSync(executable) !== fs.realpathSync(binary)) refuse(`spec refused: command word ${at + 1} must be the binary`);
        command.command[at] = binary;
        // A self- spec that passed every check is frozen now, before its first run.
        pinned.freeze?.();
        const resultFile = fileParser ? fenced(ctx.root, parser.file) : null;
        for (let repeat = 1; repeat <= spec.repeats; repeat++) {
          const currentBinary = fenced(ctx.root, spec.binary);
          if (fileDigest(currentBinary) !== spec.binary_digest) refuse('measuring binary digest changed');
          command.command[at] = currentBinary;
          if (pin(ctx,args.spec_id).digest !== pinned.digest) refuse('spec refused');
          if (fileDigest(fenced(ctx.root, spec.workload)) !== spec.workload_digest || fileDigest(fenced(ctx.root, spec.config)) !== spec.config_digest) refuse('measurement inputs changed');
          const candidateDigest = fileDigest(fenced(ctx.root,spec.candidate_binary));
          const previous = resultFile && fs.existsSync(resultFile) ? fs.statSync(resultFile).mtimeMs : null;
          const result = await execute(command.command, command.cwd, { deadlineMs: Math.floor(settings(ctx.home).runSeconds * 1000 / spec.repeats) });
          if (result.exit_code !== 0 || result.timed_out || (!fileParser && result.stdout.bytes > 1024) || fileDigest(fenced(ctx.root,spec.binary)) !== spec.binary_digest || fileDigest(fenced(ctx.root,spec.candidate_binary)) !== candidateDigest || fileDigest(fenced(ctx.root, spec.workload)) !== spec.workload_digest || fileDigest(fenced(ctx.root, spec.config)) !== spec.config_digest) refuse('measurement failed');
          let value;
          if (fileParser) {
            if (!fs.existsSync(resultFile) || fs.statSync(resultFile).size > 1024 * 1024 || fs.statSync(resultFile).mtimeMs === previous) refuse('measurement failed');
            let node; try { node = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { refuse('measurement failed'); }
            for (const key of parser.path) {
              if (node === null || typeof node !== 'object') refuse('measurement failed');
              node = typeof key === 'number' ? (Array.isArray(node) ? node[key < 0 ? node.length + key : key] : undefined) : node[key];
            }
            if (typeof node !== 'number' || !Number.isFinite(node) || node < 0) refuse('measurement failed');
            value = Math.round(node * 1000);
          } else {
            let parsed; try { parsed = JSON.parse(result.stdout.head); } catch { refuse('measurement failed'); }
            value = parsed[parser.field];
          }
          if (!Number.isSafeInteger(value) || value < 0) refuse('measurement failed');
          rows.push({ spec_id: args.spec_id, repeat, value_milli: value, unit: spec.unit, spec_digest: pinned.digest, binary_digest: spec.binary_digest, candidate_digest: candidateDigest, workload_digest: spec.workload_digest, config_digest: spec.config_digest });
        } break;
      }
      default: refuse('tool refused');
    }
    // A read changes nothing, so the tree after it is the tree before it; a change made meanwhile by someone else is
    // seen by the next call's walk. (One walk of a large tree takes seconds.) A read's rows carry no generation step:
    // only the tools that can change the tree report eng.tree_step.
    const read = READ_TOOLS.includes(tool);
    if (observing) {
      const out = fitRows(tool, rows, 1);
      return { rows: out.rows, ...text, ...(more || out.cut ? { truncated: true } : {}) };
    }
    const after = read ? before : tree(ctx);
    if (tool === 'run') { rows[0].tree_after = after.digest; rows[0].changed_files = JSON.stringify(changed(before, after)); }
    // Every change is a step, a check's own run included: the owner's treeExclude is the only exclusion.
    // eng.test@2 也比较运行前后：一次运行把外部改动（d0 → d1，无回执）又改回 d0 时，结束的树等于记录的树，
    // 但它测的是 d1，所以仍然是一步，结果不能算当前通过。
    // eng.test@2 also compares before with after: a run that reverts an unrecorded change (d0 -> d1, then the run
    // writes d0 back) ends on the recorded tree but tested d1, so it is still a step and never current.
    const ranOver = tool === 'test_v2' && before.digest !== after.digest;
    // 写工具与 apply_patch 写到主人排除的路径下也是一步：排除不是放被测代码的地方（树摘要看不见那里的改动）。
    // A write tool or apply_patch touching a path under an exclusion is a step too: exclusions are not a place for
    // tested code (the tree digest cannot see a change there).
    const written = ['write_file', 'patch_file'].includes(tool) ? [file()] : tool === 'apply_patch' ? rows.map(row => path.resolve(ctx.root, row.path)) : [];
    const mutated = state.digest !== after.digest || ranOver || underExclusion(ctx, written);
    const gen = state.gen + (mutated ? 1 : 0);
    if (!Number.isSafeInteger(gen)) refuse('generation exhausted');
    const step = mutated ? { from_gen: state.gen, to_gen: gen } : { from_gen: -1, to_gen: -1 };
    if (tool === 'tree_state') rows[0] = { gen, tree_digest: after.digest };
    // 检查自己改了代码树（主人 treeExclude 之外的任何东西）：它测的是运行前的树，不是它造出来的树。结果记在运行前的
    // 代数上，同一回执里的这一步（运行前 → 运行后）让它立刻失效，所以这样的检查永远不能算“当前通过”。
    // A check whose own run changed the tree tested the tree before, not the one it made: its result is stamped at the
    // pre-run generation, and the step pre → post in the same receipt leaves it, so it can never be current.
    // (eng.test@1 keeps its original behaviour: the final generation.)
    // Such a row pairs the pre-run generation with the pre-run digest; the step in the same receipt carries pre -> post.
    if (tool === 'test' || tool === 'test_v2') {
      rows[0].tree_digest = ranOver ? before.digest : after.digest;
      rows[0].gen = ranOver ? state.gen : gen;
    }
    const testGen = (tool === 'test' || tool === 'test_v2') && rows[0].exit_code === 0 ? rows[0].gen : state.test_gen;
    // Replay the genuine first edge after the latest passing test. If an adapter finished but its Worker receipt was
    // lost, or a read saw the change first, the next receipt of a tool that can change the tree still invalidates it.
    let invalidation = state.invalidation;
    if (mutated && (state.test_gen === state.gen || testGen === state.gen)) invalidation = step;
    const edges = invalidation && invalidation.from_gen !== step.from_gen ? [invalidation,step] : [step];
    // The identity stays with the counter whichever version saves it (a read on a project root keeps it).
    const saved = { gen, digest: after.digest, ...(testGen === undefined ? {} : { test_gen: testGen }), ...(invalidation ? { invalidation } : {}),
      ...(project ?? kept ? { project: project ?? kept } : {}) };
    save(ctx.stateFile, saved);
    keepRoot(ctx, saved);
    const reportEdges = edges;
    const projected = project === undefined ? {} : { project };
    const out = read ? fitRows(tool, rows, 1) : fitRows(tool, rows.flatMap(row => reportEdges.map(edge => ({ ...projected, ...row, ...edge }))), reportEdges.length);
    return { rows: out.rows, ...text, ...(more || out.cut ? { truncated: true } : {}) };
  });
}
// The 1-based line on which byte `offset` lies, counted by streaming the file; null past 16 MiB.
function lineAt(file, offset) {
  if (offset > 16 * 1024 * 1024) return null;
  const fd = fs.openSync(file, 'r'); const chunk = Buffer.alloc(65536); let line = 1, at = 0;
  try {
    while (at < offset) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, offset - at), at);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) if (chunk[i] === 10) line++;
      at += n;
    }
  } finally { fs.closeSync(fd); }
  return line;
}
// The measurement specs the owner pinned (their spec_id values); test.json is the pinned test, not a measurement.
// The measurement spec ids: the owner's and frozen self- specs in the kit home, and self- specs the agent wrote in
// the project and has not run yet (<project>/.deep-rulith/measure/<name>.json is spec_id self-<name>).
function measureSpecs(ctx) {
  const names = (dir) => { try { return fs.readdirSync(dir).filter((n) => /^[a-zA-Z0-9_-]{1,64}[.]json$/.test(n)).map((n) => n.slice(0, -5)); } catch { return []; } };
  // Only canonical lower-case self- ids can run (pin refuses every other case), so only they are listed.
  const canonical = (n) => !/^self-/i.test(n) || /^self-[a-z0-9_-]+$/.test(n);
  const proposed = names(path.join(ctx.root, '.deep-rulith', 'measure')).map((n) => `self-${n}`).filter((n) => n.length <= 64 && canonical(n));
  return [...new Set([...names(path.join(ctx.home, 'specs')).filter((n) => n !== 'test' && canonical(n)), ...proposed])].sort();
}
// A project spec is written by the model, so its command passes the same classifier as eng.run (no push, publish,
// privilege, process control, global installs or inline interpreter code; the owner's allow and allowedPaths).
// Its own shell flag cannot widen the owner's settings: shell runs only where the owner enabled it.
// With shell the spec's command is one string: the shell receives exactly the line eng.check_spec shows.
function acceptanceCommand(ctx, spec) {
  if (spec.shell && !settings(ctx.home).shell) refuse('acceptance shell refused');
  const command = classify(ctx, spec.command, spec.cwd);
  // 规格冻结的是命令字：命令字找到的程序若在项目里，它的字节必须在 files 里（进摘要），否则改了它检查照样"通过"。
  // 找法与运行时相同、但不看当前目录（运行时也不看，见 lib.mjs execute）；PATH 指进项目的也算。
  // A spec freezes command words: a program they find inside the project must be listed in files (its bytes in the
  // digest), or rewriting it would leave the check passing. It is found as the run finds it, without the current
  // directory (which the run does not search either; see lib.mjs execute); a PATH entry into the project counts too.
  const program = resolveProgram(command.command[0], command.cwd);
  if (program !== undefined && inside(ctx.root, program)) {
    const name = path.relative(ctx.root, program).split(path.sep).join('/');
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!Object.keys(spec.files).some(file => same(file, name))) refuse('acceptance spec invalid: command program must be listed in files');
  }
  return spec.shell ? { command: command.command, cwd: command.cwd, shell: true, line: spec.command }
    : { command: command.command, cwd: command.cwd, shell: false };
}
function pinnedCommand(ctx, spec, self = false) {
  // Owner-pinned executable may be an absolute toolchain path outside the Source.
  if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some(x => typeof x !== 'string' || !x || x.includes('\0'))) refuse('spec refused: command must be a list of non-empty strings');
  // 模型自己写的 self- 规格：命令和 eng.run 一样过分类器（不许推送、发布、提权、内联代码……，主人的 allow 与
  // allowedPaths 适用），从不经过 shell；它没有输出目录（排除只由主人定）；解释器只能是常见解释器的名字或主人
  // allowedPaths 下的绝对路径。主人在 kit home 写的规格不变。
  // A self- spec is model-written: its command passes eng.run's classifier and never meets a shell; it has no
  // output_dirs (exclusions are the owner's); its interpreter is a bare common interpreter name or an absolute path
  // under the owner's allowedPaths. The owner's own specs in the kit home are unchanged.
  if (self) {
    if (spec.output_dirs !== undefined) refuse('spec refused: a self- spec has no output_dirs');
    if (spec.interpreter !== undefined && !(['node', 'python', 'python3', 'ruby', 'perl'].includes(spec.interpreter)
      || (typeof spec.interpreter === 'string' && path.isAbsolute(spec.interpreter) && underAllowedPath(ctx, spec.interpreter))))
      refuse('spec refused: interpreter must be node, python, python3, ruby, perl or an absolute path under allowedPaths');
    const command = classify(ctx, [...spec.command], spec.cwd ?? '.');
    return { command: command.command, cwd: command.cwd, shell: false };
  }
  // A pinned spec may ask for the system shell (for example `npm test` on Windows, which is a .cmd script).
  return { command: spec.command, cwd: fenced(ctx.root, spec.cwd ?? '.'), shell: spec.shell === true, line: spec.command.join(' ') };
}
function underAllowedPath(ctx, file) {
  let real = path.resolve(file); try { real = fs.realpathSync(file); } catch {}
  return settings(ctx.home).allowedPaths.some(dir => inside(dir, real) && inside(dir, path.resolve(file)));
}
function commandRow(r, command, before) {
  return { run_id: randomUUID(), command_digest: sha(JSON.stringify(command)), exit_code: r.exit_code, timed_out: r.timed_out, duration_ms: r.duration_ms, stdout_digest: r.stdout.digest, stderr_digest: r.stderr.digest, stdout_bytes: r.stdout.bytes, stderr_bytes: r.stderr.bytes, tree_before: before, tree_after: '', changed_files: '' };
}
function jobRow(j) { return { job_id: j.id, status: j.status, exit_code: j.exit_code, command_digest: sha(JSON.stringify(j.command)), tree_before: j.before }; }
export async function main(name) {
  // A project tool refuses exactly as the tool it extends: the verdict vocabulary is the base tool's.
  const tool = baseTool(name);
  try {
    const args = JSON.parse(process.argv[2] ?? '{}');
    if (!args || Array.isArray(args) || typeof args !== 'object') refuse('arguments refused');
    process.stdout.write(JSON.stringify(await perform(name, args)));
  } catch (error) {
    // Never echo paths, arbitrary exception messages, commands, or spec contents.
    const messages = [...(['glob','apply_patch','read_image','read_v2','web_fetch','web_search'].includes(tool) ? ['settings refused','glob refused','glob limit refused','glob walk limit exceeded','glob complexity refused','patch format refused','patch hunk refused','patch path repeated','delete refused','patch file refused','patch file count refused','image refused','image size exceeded','web URL refused','web address refused','web size exceeded','web redirects exceeded','web timeout','web encoding refused','web media type refused','web metadata too large','web request failed','web search key unavailable','web search failed'] : []),'path refused','file Source required','pin directory required','pin directory refused','spec refused','query refused','offset refused','command refused','adapter busy','job live: only poll, stop and reads accepted','text exceeds 16 KiB','file digest changed','patch must match once','read-back failed','job unavailable','job refused','wait refused','job stop unconfirmed','test takes no arguments','measuring binary digest changed','measurement inputs changed','measurement failed','tool refused','arguments refused','generation exhausted','parent directory missing','project root overlaps another project','project tools required'];
    // A spec refusal names its field in fixed words (no path, no value); a file-system error says only what kind it was.
    const fileErrors = { ENOENT: 'path not found', EISDIR: 'path is a directory', ENOTDIR: 'path not found', EACCES: 'path not readable', EPERM: 'path not readable', EBUSY: 'path not readable' };
    const acceptanceError = ['test_v2', 'acceptance'].includes(tool) &&
      (['acceptance spec invalid', ...FIELD_ERRORS, 'acceptance spec changed', 'acceptance spec too large', 'acceptance shell refused', 'acceptance check invalid', 'acceptance takes no arguments'].includes(error.message)
        || isFieldError(error.message) || /^acceptance file changed: [^\x00-\x1f\x7f]+$/.test(error.message));
    const verdict = acceptanceError || messages.includes(error.message) || /^spec refused: [A-Za-z0-9_ ,()-]+$/.test(error.message) ? error.message
      : fileErrors[error.code] ?? 'adapter failed';
    process.stdout.write(JSON.stringify({ rows: [], verdict }));
    // The Worker reports a failed run with what the command wrote to stderr: the verdict goes there too.
    process.stderr.write(verdict);
    process.exitCode = 2;
  }
}
