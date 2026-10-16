// Emit the v2 packages in the Gateway's authoring format (AuthorPackage.parse -> DomainAuthoringCompiler; the
// Kernel's native rulith-domain-program is what the Gateway compiles from it, never an install input).
// The original program.json and sources.json stay frozen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One authoring program defines predicates of one namespace only. The web.* receipt words of web.fetch@1 and
// web.search@1 are accredited by Source `lab` without a definition here.
const NAMESPACE = 'eng';
const PINS = ['eng.check_passed', 'eng.check_result', 'eng.check_spec', 'eng.tree_step'];
const local = id => id.replaceAll('.', '_');

export function buildPackages(manifest) {
  const words = new Map();
  for (const tool of Object.values(manifest.tools)) {
    for (const row of tool.returns) {
      const args = Object.keys(row.args);
      const seen = words.get(row.predicate);
      if (seen && seen.join(',') !== args.join(',')) throw new Error(`${row.predicate} has two argument lists`);
      words.set(row.predicate, args);
    }
  }
  for (const id of words.keys()) if (!/^(eng|web)\.[a-z][a-z0-9_]*$/.test(id)) throw new Error(`${id} is outside eng and web`);
  // The criterion: the first declared argument (`check`) is the test name the Kernel plants on a signed leaf.
  const criterion = ['eng.check_passed', ['check', 'spec_digest']];
  const defines = [...words, criterion].filter(([id]) => id.startsWith(`${NAMESPACE}.`))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, args]) => ({ id, as: local(id), args }));
  const atom = (id, args, extra = {}) => ({ predicate: local(id), args, ...extra });
  const program = {
    id: 'engineering_work',
    title: 'General Worker tools',
    summary: 'Result vocabulary of the general Worker tools (files, commands, tests, acceptance checks, measurements) and the criterion eng.check_passed for signed acceptance leaves.',
    vocabulary: { defines, imports: [{ id: 'acceptance' }, { id: 'acceptance_met' }] },
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
    sources: [{ name: 'lab', type: 'file', words: [...words.keys()].sort(), tier: 'attested',
      territoryHint: 'The local engineering workspace a person bound for this Agent' }],
  };
  return { program, sources };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(fs.readFileSync(new URL('../worker-tools.json', import.meta.url), 'utf8'));
  const { program, sources } = buildPackages(manifest);
  for (const [name, value] of [['program-v2.json', program], ['sources-v3.json', sources]])
    fs.writeFileSync(new URL(name, import.meta.url), JSON.stringify(value, null, 2) + '\n');
  console.log(`${program.vocabulary.defines.length} definitions:`, program.vocabulary.defines.map(d => d.id).join(' '));
}
