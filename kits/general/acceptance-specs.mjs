import fs from 'node:fs';
import { sha, plainFenced, fileDigest, refuse } from './lib.mjs';

// A check name starts with a letter: the Kernel would read an all-digit name as a number, and the
// signed leaf's first argument must stay text.
export const CHECK = /^[a-z][a-z0-9_-]{0,39}$/;
export const MAX_FILES = 32;
// The Worker's inline receipt budget is 8 KiB on rulith.ai; a check_spec receipt keeps 1 KiB of headroom
// for the envelope. Measured as the Worker measures it: the adapter output as text, plus its facts.
export const RECEIPT_BYTES = 7168;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const projectPath = value => typeof value === 'string' && value.length <= 512
  && !/[\\:\x00-\x1f\x7f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
// 显示安全：命令字（或 shell 命令行）、cwd 与 files 路径原样显示在 Board 上，由人签字。只接受可打印 ASCII
// （0x20–0x7E），且首尾不是空格；其余一律拒绝，错误说出字段名。看不见、看起来像别的字（同形字、盲文空白 U+2800、
// 组合删除线 U+0336……）的字符无法逐类列全，所以 v1 不列类别，只收 ASCII：非 ASCII 的项目路径不能做验收检查。
// Display safety: command words (or the shell line), cwd and files paths are shown on the Board for a person to sign.
// Only printable ASCII (0x20-0x7E) without a leading or trailing space is accepted; anything else is refused, naming
// the field. Invisible and look-alike characters (homoglyphs, U+2800, U+0336, ...) cannot be listed by category with
// confidence, so v1 accepts ASCII only: a project path outside ASCII cannot be an acceptance check.
const displayable = value => typeof value !== 'string' || /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value);
// 规格错误的完整词表在这一处：模型照着错误改规格，所以每条都说出哪里错了，但只用固定词。`<name>` 是唯一的变量，
// 只回显安全的字段名或键名（字母、数字和 _ . / -，至多 64 个）；其他名字退回不带说明的 `acceptance spec invalid`。
// The complete spec error vocabulary lives here: the model repairs a spec from its error, so each names what is wrong
// in fixed words. `<name>` is the only variable and echoes a safe field or key name only (letters, digits, _ . / -,
// at most 64); any other name falls back to the bare `acceptance spec invalid`.
export const FIELD_ERRORS = ['command', 'cwd', 'files', 'not JSON', 'duplicate key <name>', 'unknown field <name>', 'command must be an array of words (or one string with shell:true)', 'files must map each path to its sha256'].map(field => `acceptance spec invalid: ${field}`);
const SAFE_NAME = /^[A-Za-z0-9_./-]{1,64}$/;
// True for a spec error this module raises: a fixed entry, or a `<name>` entry with a safe name.
export const isFieldError = message => typeof message === 'string' && FIELD_ERRORS.some(entry => entry === message
  || entry.endsWith(' <name>') && message.startsWith(entry.slice(0, -6)) && SAFE_NAME.test(message.slice(entry.length - 6)));
const invalidField = (field, name) => name === undefined ? refuse(`acceptance spec invalid: ${field}`)
  : SAFE_NAME.test(name) ? refuse(`acceptance spec invalid: ${field} ${name}`) : invalid();
const COMMAND_SHAPE = 'command must be an array of words (or one string with shell:true)';
const FILES_SHAPE = 'files must map each path to its sha256';
// 项目根的 .git 被树摘要排除，运行时也拒绝在其中运行或依赖其中的文件；解析时就按字段拒绝，任何大小写或
// Windows 会去掉的尾随点和空格都算。
// The root .git is excluded from the tree digest and refused at run time; a spec naming it is refused when parsed,
// by field, in any case and with the trailing dots or spaces Windows drops.
const rootGit = value => value.split('/')[0].toLowerCase().replace(/[. ]+$/, '') === '.git';
const invalid = () => refuse('acceptance spec invalid');

// JSON.parse accepts a repeated key and keeps the last value; a reader of the file may see the first.
// One meaning only: any object with a repeated key (compared after unescaping) is refused. Returns the first
// repeated key, or undefined.
export function duplicateKeys(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      let next = end + 1;
      while (/\s/.test(text[next] ?? '')) next++;
      const keys = stack.at(-1);
      if (text[next] === ':' && keys) {
        const key = JSON.parse(text.slice(i, end + 1));
        if (keys.has(key)) return key;
        keys.add(key);
      }
      i = end;
    }
  }
  return undefined;
}

// The digest covers the spec {command, cwd, files, shell} with its default written out (`shell: false`), so it is
// a function of the eng.check_spec fact alone. Keys are sorted recursively (UTF-16 code unit order), arrays keep
// their order, JSON.stringify encodes keys and values, no whitespace; SHA-256 of the UTF-8 bytes, no BOM or newline.
export function canonicalSpec(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSpec).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalSpec(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
// `files` is written either as {path: sha256} or, mirroring the eng.check_spec fact, as [{path, sha256}, ...]; both
// spellings become one object with sorted keys before anything else reads it, so they have one digest.
// 两种写法在校验和摘要之前合成同一个按键排序的对象：摘要只取决于内容，不取决于写法。重复路径一律拒绝。
function filesMap(files) {
  let entries;
  if (object(files)) entries = Object.entries(files);
  else if (Array.isArray(files) && files.every(item => object(item) && Object.keys(item).length === 2
    && Object.hasOwn(item, 'path') && Object.hasOwn(item, 'sha256') && typeof item.path === 'string'))
    entries = files.map(item => [item.path, item.sha256]);
  else invalidField(FILES_SHAPE);
  if (new Set(entries.map(([name]) => name)).size !== entries.length) invalidField(FILES_SHAPE);
  if (entries.length > MAX_FILES) invalid();
  if (entries.some(([, digest]) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) invalidField(FILES_SHAPE);
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export const normalizedSpec = spec => ({ command: spec.command, cwd: spec.cwd, files: spec.files, shell: spec.shell === true });

export function acceptanceSpec(ctx, check) {
  if (typeof check !== 'string' || !CHECK.test(check)) refuse('acceptance check invalid');
  try {
    const target = plainFenced(ctx.root, `.rulith/acceptance/${check}.json`);
    if (!fs.statSync(target).isFile() || fs.statSync(target).size > 16384) invalid();
    let text, spec;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(target));
      spec = JSON.parse(text);
    } catch { invalidField('not JSON'); }
    const repeated = duplicateKeys(text);
    if (repeated !== undefined) invalidField('duplicate key', repeated);
    // 没有 output_dirs：主人的 treeExclude 是唯一的排除；检查运行改动的任何东西都和其他工具一样算一步。
    // 模型写的排除会让别的检查在它们从未测过的新代码上继续“通过”。
    // No output_dirs: the owner's treeExclude is the only exclusion, and any change a check run makes is a tree
    // step like any other tool's (a model-written exclusion kept other checks passing on code they never tested).
    if (!object(spec)) invalid();
    const unknown = Object.keys(spec).find(k => !['command', 'cwd', 'files', 'shell'].includes(k));
    if (unknown !== undefined) invalidField('unknown field', unknown);
    if (spec.shell !== undefined && typeof spec.shell !== 'boolean') invalid();
    // With shell the spec gives one command line, run and shown exactly as written; without it, an argv array
    // that never meets a shell.
    const words = spec.shell === true ? [spec.command] : spec.command;
    if (!Array.isArray(words) || !words.length || words.some(s => typeof s !== 'string' || !s || s.includes('\0'))) invalidField(COMMAND_SHAPE);
    if (!words.every(displayable)) invalidField('command');
    if (!displayable(spec.cwd)) invalidField('cwd');
    if (spec.cwd !== '.' && !projectPath(spec.cwd)) invalidField('cwd');
    if (rootGit(spec.cwd)) invalidField('cwd');
    const files = filesMap(spec.files);
    if (!Object.keys(files).every(displayable)) invalidField('files');
    if (!Object.keys(files).every(projectPath) || Object.keys(files).some(rootGit)) invalidField('files');
    const normal = normalizedSpec({ ...spec, files });
    return { spec: normal, digest: sha(canonicalSpec(normal)) };
  } catch (error) { if (isFieldError(error.message)) throw error; invalid(); }
}

// The command as one readable line. A shell command line (a string) is shown exactly as the shell receives it.
// An argv array: a word without whitespace, quotes or control characters stands as written; any other word is a
// JSON string. Reversible: a token that starts with `"` is JSON, every other token is literal.
export const commandLine = command => typeof command === 'string' ? command
  : command.map(word => /^[^\s"\x00-\x1f\x7f]+$/.test(word) ? word : JSON.stringify(word)).join(' ');

// 验收键（编程包第三版，D-1018c 补充）：一个常量同时绑定项目、检查名与规格摘要，签字叶的标准原子只带它。
// 三段都不含冒号（项目与规格摘要是 64 位小写十六进制，检查名合 CHECK），所以按冒号拆开恰好三段，写法唯一；
// 含冒号也保证 Kernel 把它当文本，不当数字。
// The check key (engineering program v3, D-1018c supplement): one constant binding the project, the check name and
// the spec digest; a signed leaf's criterion atom carries only it. No part contains a colon (project and spec digest
// are 64 lowercase hex, the check name matches CHECK), so it splits into exactly three parts: one spelling per triple.
// The colon also keeps it text on the Board, never a number.
export const checkKey = (project, check, digest) => `${project}:${check}:${digest}`;

// The eng.check_spec row: everything the spec digest denotes, so the person who signs a leaf reads on the Board
// what the digest freezes. `files` is JSON text (facts hold scalars only). With a project (eng.acceptance@2) the row
// leads with the check key, and the receipt budget is measured with it.
export function checkSpecRow(check, { spec, digest }, project) {
  const row = { ...(project === undefined ? {} : { key: checkKey(project, check, digest) }), check, spec_digest: digest,
    command: commandLine(spec.command), cwd: spec.cwd, shell: spec.shell,
    files: JSON.stringify(Object.keys(spec.files).sort().map(name => ({ path: name, sha256: spec.files[name] }))) };
  if (receiptBytes({ rows: [row] }) > RECEIPT_BYTES) refuse('acceptance spec too large');
  return row;
}
const receiptBytes = out => Buffer.byteLength(JSON.stringify({ result: JSON.stringify(out), reason: '',
  facts: out.rows.map(args => ({ predicate: 'eng.check_spec', args })) }));

// Enumerates this directory only. No dependency files, project tree, state, or Source lock are touched.
// A directory that cannot be listed (a file, a link, unreadable) is reported, never thrown: only this tool reads it.
export function acceptanceEntries(ctx, project) {
  let names;
  try {
    names = fs.readdirSync(plainFenced(ctx.root, '.rulith/acceptance'));
  } catch (error) {
    return error.code === 'ENOENT' ? [] : null;
  }
  return names.filter(name => name.endsWith('.json')).sort().map(name => {
    const check = name.slice(0, -5);
    try { return { check, row: checkSpecRow(check, acceptanceSpec(ctx, check), project) }; }
    catch (error) { return { check, error: ['acceptance spec too large'].includes(error.message) || isFieldError(error.message) ? error.message : 'acceptance spec invalid' }; }
  });
}

export function acceptanceRows(ctx, args, project) {
  if (Object.keys(args).length) refuse('acceptance takes no arguments');
  const entries = acceptanceEntries(ctx, project);
  if (entries === null) return { rows: [], errors: [{ error: 'acceptance directory unreadable' }] };
  const rows = [], errors = [];
  let truncated = false;
  for (const entry of entries) {
    // Untrusted invalid filenames never become unbounded receipt text.
    const row = entry.error ? { error: entry.error, ...(CHECK.test(entry.check) ? { check: entry.check } : {}) } : entry.row;
    // Worker return mappings apply to every `rows` item. Diagnostics belong to text-only rows,
    // otherwise one invalid spec would reject the entire receipt as missing scalar columns.
    const next = entry.error ? { rows, errors: [...errors, row] } : { rows: [...rows, row], errors };
    if (receiptBytes({ ...next, truncated: true }) > RECEIPT_BYTES) { truncated = true; break; }
    (entry.error ? errors : rows).push(row);
  }
  return { rows, ...(errors.length ? { errors } : {}), ...(truncated ? { truncated: true } : {}) };
}

export function verifyAcceptanceFiles(ctx, spec) {
  for (const name of Object.keys(spec.files).sort()) {
    try {
      const target = plainFenced(ctx.root, name);
      if (!fs.statSync(target).isFile() || fileDigest(target) !== spec.files[name]) throw new Error();
    } catch { refuse(`acceptance file changed: ${name}`); }
  }
}
