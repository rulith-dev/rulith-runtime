// Emit the packages in the Gateway's authoring format (AuthorPackage.parse -> DomainAuthoringCompiler; the
// Kernel's native rulith-domain-program is what the Gateway compiles from it, never an install input).
// The original program.json and sources.json stay frozen; program-v2.json and sources-v3.json stay byte-identical for
// the Agents that installed them. program-v3.json, sources-v4.json and official-recipe.json are the official
// engineering capability (PSC 0.2.24, D-1018c): its program, its `project` Source template with the tool adoption
// contract, and the two together in the recipe the Gateway freezes into its first-party Release.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toolDigest } from '../../../worker/rulith-worker.mjs';

// One authoring program defines predicates of one namespace only. The web.* receipt words of web.fetch@1 and
// web.search@1 are accredited by Source `lab` without a definition here.
const NAMESPACE = 'eng';
const PINS = ['eng.check_passed', 'eng.check_result', 'eng.check_spec', 'eng.tree_step'];
const local = id => id.replaceAll('.', '_');
const KIT_PREFIX = 'adapters/engineering-work/';

// 项目版工具（eng.tree_step 带 project，检查结果与规格带验收键）：只属于第三版程序，第二版不认它们的回执。
// The project tool versions (eng.tree_step with project, check results and specs with the check key) belong to
// program v3 only; program v2 never reads their receipts.
export const PROJECT_TOOLS = ['eng.acceptance@2', 'eng.apply_patch@2', 'eng.job_poll@2', 'eng.job_start@2', 'eng.job_stop@2',
  'eng.patch_file@2', 'eng.run@2', 'eng.test@3', 'eng.write_file@2'];
// 官方编程能力采用的工具（打开项目时钉住并锁定，全部直接使用）：每个工具的当前版本。不收旧的 eng.read@1、eng.test@1、
// eng.test@2 与无项目的写、运行工具，不收 eng.measure_pinned@1 与目录之外的 web 工具。
// The tools the official capability adopts (pinned and locked when a project is opened, all for direct use): the
// current version of each. Not the older eng.read@1, eng.test@1, eng.test@2 or the write and run tools without a
// project, nor eng.measure_pinned@1 or the web tools, which reach outside the directory.
export const ADOPTED = [...PROJECT_TOOLS, 'eng.glob@1', 'eng.list@1', 'eng.read@2', 'eng.read_image@1', 'eng.search@1',
  'eng.tree_state@1'].sort();
export const CAPABILITY = { id: 'engineering_work', version: '1.0.0', title: 'General Worker tools',
  // Program v2's summary without "measurements": eng.measure_pinned@1 is not adopted.
  summary: 'Result vocabulary of the general Worker tools (files, commands, tests, acceptance checks) and the criterion eng.check_passed for signed acceptance leaves.' };
const TERRITORY = 'The local engineering workspace a person bound for this Agent';

// Every receipt word of these tools with its one argument list.
function receiptWords(tools) {
  const words = new Map();
  for (const tool of tools) {
    for (const row of tool.returns) {
      const args = Object.keys(row.args);
      const seen = words.get(row.predicate);
      if (seen && seen.join(',') !== args.join(',')) throw new Error(`${row.predicate} has two argument lists`);
      words.set(row.predicate, args);
    }
  }
  for (const id of words.keys()) if (!/^(eng|web)\.[a-z][a-z0-9_]*$/.test(id)) throw new Error(`${id} is outside eng and web`);
  return words;
}
const definitions = (words, criterion) => [...words, criterion].filter(([id]) => id.startsWith(`${NAMESPACE}.`))
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([id, args]) => ({ id, as: local(id), args }));
const atom = (id, args, extra = {}) => ({ predicate: local(id), args, ...extra });

// Program v2 and Sources v3: the tools as they were before the project versions, bytes frozen.
export function buildPackages(manifest) {
  const words = receiptWords(Object.entries(manifest.tools).filter(([id]) => !PROJECT_TOOLS.includes(id)).map(([, tool]) => tool));
  // The criterion: the first declared argument (`check`) is the test name the Kernel plants on a signed leaf.
  const criterion = ['eng.check_passed', ['check', 'spec_digest']];
  const program = {
    id: 'engineering_work',
    title: 'General Worker tools',
    summary: 'Result vocabulary of the general Worker tools (files, commands, tests, acceptance checks, measurements) and the criterion eng.check_passed for signed acceptance leaves.',
    vocabulary: { defines: definitions(words, criterion), imports: [{ id: 'acceptance' }, { id: 'acceptance_met' }] },
    rules: [{
      id: 'ENG_CHECK_PASSED',
      label: 'A passing named check remains current until a tree step leaves its generation.',
      when: [atom('eng.check_result', { check: '?c', spec_digest: '?d', gen: '?g', exit_code: 0 }),
        atom('eng.tree_step', { from_gen: '?g', to_gen: '?n' }, { naf: true })],
      then: [atom('eng.check_passed', { check: '?c', spec_digest: '?d' })],
    }],
    acceptance: [{
      id: 'ENG_CHECK_ACCEPTANCE',
      label: 'The signed leaf names the check; its desired atom fixes the spec digest.',
      when: [{ predicate: 'acceptance', args: { node: '?n', test: '?c' } },
        atom('eng.check_passed', { check: '?c', spec_digest: '?d' })],
      then: [{ predicate: 'acceptance_met', args: { node: '?n' } }],
    }],
    pins: PINS.map(local),
    actions: [],
  };
  const sources = {
    format: 'rulith-sources/1',
    // Version 2 of this name already exists with other bytes.
    meta: { name: 'engineering_work_sources', version: 3 },
    // The criterion is not a receipt word: only the package rule derives it (it is pinned).
    sources: [{ name: 'lab', type: 'file', words: [...words.keys()].sort(), tier: 'attested', territoryHint: TERRITORY }],
  };
  return { program, sources };
}

/**
 * The digest the Worker advertises for a kit tool installed under adapters/engineering-work/: toolDigest of its
 * definition and the sha256 of every entry and implementation file, as runImplementation computes it at Worker start.
 * `kitDir` holds the kit files (the installer copies them there unchanged).
 */
export function implementationDigest(definition, kitDir) {
  const files = {};
  for (const name of [definition.entry, ...(definition.implementation ?? [])]) {
    if (typeof name !== 'string' || !name.startsWith(KIT_PREFIX) || name.slice(KIT_PREFIX.length).includes('/'))
      throw new Error(`${name} is not a kit file`);
    files[name] = createHash('sha256').update(fs.readFileSync(path.join(kitDir, name.slice(KIT_PREFIX.length)))).digest('hex');
  }
  return toolDigest(definition, files);
}

// 第三版程序：标准原子 eng.check_passed(key) 只带验收键，键同时绑定项目、检查名与规格摘要（D-1018c 补充）。
// 通过规则与验收桥都按键连接，撤回只看同一项目的树步：签字后换一份更松的规格（摘要变了，键就变了）兑现不了已签的叶，
// 另一个项目的写入也撤回不了这个项目的检查。
// Program v3: the criterion eng.check_passed(key) carries only the check key, which binds project, check name and spec
// digest together (D-1018c supplement). The pass rule and the bridge join on the key; only a tree step of the same
// project withdraws a pass. A looser spec written after signing has another digest, hence another key, and cannot
// fulfil the signed leaf; a write in another project withdraws nothing here.
export function buildOfficial(manifest, kitDir) {
  for (const id of ADOPTED) if (!manifest.tools[id]) throw new Error(`${id} is not a kit tool`);
  const words = receiptWords(ADOPTED.map(id => manifest.tools[id]));
  for (const id of words.keys()) if (!id.startsWith(`${NAMESPACE}.`)) throw new Error(`${id} is outside the program namespace`);
  const criterion = ['eng.check_passed', ['key']];
  const program = {
    id: CAPABILITY.id,
    title: CAPABILITY.title,
    summary: CAPABILITY.summary,
    vocabulary: { defines: definitions(words, criterion), imports: [{ id: 'acceptance' }, { id: 'acceptance_met' }] },
    rules: [{
      id: 'ENG_CHECK_PASSED',
      label: 'A passing check remains current until a tree step of its project leaves its generation.',
      when: [atom('eng.check_result', { key: '?k', project: '?p', gen: '?g', exit_code: 0 }),
        atom('eng.tree_step', { project: '?p', from_gen: '?g', to_gen: '?n' }, { naf: true })],
      then: [atom('eng.check_passed', { key: '?k' })],
    }],
    acceptance: [{
      id: 'ENG_CHECK_ACCEPTANCE',
      label: 'The signed leaf names the check key: its project, check and spec digest.',
      when: [{ predicate: 'acceptance', args: { node: '?n', test: '?k' } },
        atom('eng.check_passed', { key: '?k' })],
      then: [{ predicate: 'acceptance_met', args: { node: '?n' } }],
    }],
    pins: PINS.map(local),
    actions: [],
  };
  const sources = {
    format: 'rulith-sources/1',
    meta: { name: 'engineering_work_sources', version: 4 },
    // Reads, writes and runs go through the adopted direct tools only: explicit empty access modes.
    sources: [{ name: 'project', type: 'file', words: [...words.keys()].sort(), tier: 'attested', territoryHint: TERRITORY,
      accessModes: [], toolAdoption: ADOPTED.map(id => ({ id, digest: implementationDigest(manifest.tools[id], kitDir), directUse: true })) }],
  };
  const recipe = {
    provenance: {
      builtBy: 'rulith-runtime kits/general/pack/build-pack.mjs',
      inputs: [
        'kits/general/worker-tools.json (the adopted tool definitions; the project Source words are their returns)',
        'kits/general/*.mjs (each adopted tool pins the bytes of its entry and implementation files)',
      ],
      digest: 'toolAdoption[].digest = the Worker pin of the kit installed under adapters/engineering-work/: toolDigest(definition, {file: sha256 of its bytes}) as runImplementation computes it at Worker start',
      refresh: 'Any change to a kit file or adopted definition changes the digests: run build-pack.mjs, copy this file to rulith-java gateway/src/main/resources/official/engineering/recipe.json and raise capability.version',
    },
    capability: CAPABILITY,
    program,
    sources,
  };
  return { program, sources, recipe };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kitDir = fileURLToPath(new URL('..', import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(path.join(kitDir, 'worker-tools.json'), 'utf8'));
  const v2 = buildPackages(manifest);
  const official = buildOfficial(manifest, kitDir);
  for (const [name, value] of [['program-v2.json', v2.program], ['sources-v3.json', v2.sources], ['program-v3.json', official.program],
    ['sources-v4.json', official.sources], ['official-recipe.json', official.recipe]])
    fs.writeFileSync(new URL(name, import.meta.url), JSON.stringify(value, null, 2) + '\n');
  console.log(`v3: ${official.program.vocabulary.defines.length} definitions:`, official.program.vocabulary.defines.map(d => d.id).join(' '));
}
