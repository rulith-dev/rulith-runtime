// Emit native v2 packages. The original program.json and sources.json stay frozen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildPackages(manifest) {
  const words = new Map();
  for (const [id, tool] of Object.entries(manifest.tools)) {
    // v1's receipt lacks check and cannot prove a v2 criterion. Its contract stays unchanged.
    if (id === 'eng.test@1') continue;
    for (const row of tool.returns) {
      const args = Object.keys(row.args);
      const seen = words.get(row.predicate);
      if (seen && seen.join(',') !== args.join(',')) throw new Error(`${row.predicate} has two argument lists`);
      words.set(row.predicate, args);
    }
  }
  words.set('eng.check_passed', ['check', 'spec_digest']);
  const vocab = [...words].sort(([a], [b]) => a.localeCompare(b))
    .map(([predicate, args]) => ({ predicate, args, ...(predicate === 'eng.check_passed'
      ? { description: 'The named acceptance check passed on the current tree.' } : {}) }));
  const atom = (predicate, args) => ({ predicate, args });
  const program = {
    format: 'rulith-domain-program',
    meta: { name: 'engineering_work', version: 2 },
    vocab,
    pins: ['eng.check_passed', 'eng.test_result', 'eng.tree_step', 'eng.check_spec'],
    axioms: [{
      id: 'ENG_CHECK_PASSED',
      description: 'A passing named check remains current until a tree step leaves its generation.',
      source: 'engineering_work', tier: 'verified',
      when: [atom('eng.test_result', { check: '?c', spec_digest: '?d', gen: '?g', exit_code: 0 }),
        { ...atom('eng.tree_step', { from_gen: '?g', to_gen: '?n' }), naf: true }],
      then: [atom('eng.check_passed', { check: '?c', spec_digest: '?d' })],
    }],
    acceptance: [{
      id: 'ENG_CHECK_ACCEPTANCE',
      description: 'The signed leaf names the check; its desired atom fixes the spec digest.',
      when: [atom('acceptance', { node: '?n', test: '?c' }),
        atom('eng.check_passed', { check: '?c', spec_digest: '?d' })],
      then: [atom('acceptance_met', { node: '?n' })],
    }],
    empirical: [], theorems: [], actions: [],
  };
  const sources = {
    format: 'rulith-sources/1',
    meta: { name: 'engineering_work_sources', version: 2 },
    sources: [{ name: 'lab', type: 'file', words: vocab.map(d => d.predicate), tier: 'attested',
      territoryHint: 'The local engineering workspace a person bound for this Agent' }],
  };
  return { program, sources };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(fs.readFileSync(new URL('../worker-tools.json', import.meta.url), 'utf8'));
  const { program, sources } = buildPackages(manifest);
  for (const [name, value] of [['program-v2.json', program], ['sources-v2.json', sources]])
    fs.writeFileSync(new URL(name, import.meta.url), JSON.stringify(value, null, 2) + '\n');
  console.log(`${program.vocab.length} words:`, program.vocab.map(d => d.predicate).join(' '));
}
