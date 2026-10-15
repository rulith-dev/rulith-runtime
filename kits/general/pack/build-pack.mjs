// Builds the general-kit Capability packages from worker-tools.json: a program that only defines the eng.* and web.* result
// vocabulary, and a Sources package that declares Source "lab" (files) accrediting those words at attested. A Worker
// receipt's facts are accepted only for predicates its Source accredits; an Agent-local Source cannot add words, so this
// small Capability is what lets the eng.* receipts land. It adds no rule, Action or Case Type.
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../worker-tools.json', import.meta.url), 'utf8'));
const words = new Map();
for (const tool of Object.values(manifest.tools))
  for (const row of tool.returns) {
    const args = Object.keys(row.args);
    const seen = words.get(row.predicate);
    if (seen && seen.join(',') !== args.join(',')) throw new Error(`${row.predicate} has two argument lists`);
    words.set(row.predicate, args);
  }
const defines = [...words].sort(([a], [b]) => a.localeCompare(b))
  .map(([id, args]) => ({ id, as: id.replace(/\./g, '_'), args }));
const program = {
  id: 'engineering_work',
  title: 'General Worker tools',
  summary: 'Result vocabulary of the general Worker tools: files, commands, tests, measurements and web receipts.',
  vocabulary: { defines, imports: [] },
  pins: [], rules: [], acceptance: [], actions: [],
};
const sources = {
  format: 'rulith-sources/1',
  meta: { name: 'engineering_work_sources', version: 1 },
  sources: [{ name: 'lab', type: 'file', words: defines.map((d) => d.id), tier: 'attested',
    territoryHint: 'The local engineering workspace a person bound for this Agent' }],
};
fs.writeFileSync(new URL('./program.json', import.meta.url), JSON.stringify(program, null, 2) + '\n');
fs.writeFileSync(new URL('./sources.json', import.meta.url), JSON.stringify(sources, null, 2) + '\n');
console.log(`${defines.length} words:`, defines.map((d) => d.id).join(' '));
