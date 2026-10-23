// Generate the Worker Actions inventory from the shipped kit, without loading adapters.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generalKit } from './runtime-kit.mjs';

const words = source => [...source.matchAll(/'([^']+)'/g)].map(m => m[1]);
export function workerInventory(kit = generalKit()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(kit, 'worker-tools.json'), 'utf8'));
  const source = fs.readFileSync(path.join(kit, 'adapter.mjs'), 'utf8');
  const messages = source.match(/const messages = \[\.\.\.\(\[(.*?)\]\.includes\(tool\) \? \[(.*?)\] : \[\]\),(.*?)\];/);
  if (!messages) throw new Error('General kit refusal format changed; review the inventory generator.');
  const common = [...words(messages[3]), 'adapter failed', 'path not found', 'path is a directory', 'path not readable'];
  // Acceptance verdicts can name the spec field at fault: FIELD_ERRORS is expanded from its definition.
  const specSource = fs.readFileSync(path.join(kit, 'acceptance-specs.mjs'), 'utf8');
  const fields = specSource.match(/FIELD_ERRORS = \[(.*?)\]\.map\(field => `acceptance spec invalid: \$\{field\}`\)/);
  const listed = source.match(/\(\[(.*?)\]\.includes\(error.message\)/);
  const caught = specSource.match(/catch \(error\) \{ return \{ check, error: \[(.*?)\]/);
  const unreadable = specSource.match(/errors: \[\{ error: ('[^']+') \}\]/);
  if (!fields || !listed?.[1].includes('...FIELD_ERRORS') || !caught || !unreadable) throw new Error('General kit acceptance refusals changed; review the inventory generator.');
  const fieldErrors = words(fields[1]).map(field => `acceptance spec invalid: ${field}`);
  const acceptance = listed[1].split(',').flatMap(item => item.trim() === '...FIELD_ERRORS' ? fieldErrors : words(item));
  // Discovery reports invalid specs and an unreadable directory as text errors, never as a verdict.
  const discoveryErrors = [...new Set(['acceptance spec invalid', ...fieldErrors, ...words(caught[1]), ...words(unreadable[1])])];
  const signature = (id, predicate) => {
    const mapping = manifest.tools[id]?.returns.find(r => r.predicate === predicate);
    if (!mapping) throw new Error(`${id} no longer returns ${predicate}; review the inventory generator.`);
    return `\`${predicate}(${Object.keys(mapping.args).join(',')})\``;
  };
  const rows = Object.entries(manifest.tools).map(([id, tool]) => {
    const entry = fs.readFileSync(path.join(kit, path.basename(tool.entry)), 'utf8');
    const action = entry.match(/main\('([^']+)'\)/)?.[1];
    if (!action) throw new Error(`Unknown adapter entry for ${id}`);
    const predicates = tool.returns.map(r => `\`${r.predicate}(${Object.keys(r.args).join(',')})\``).join(', ') || 'no Board facts';
    return `- \`${id}\` (${tool.kind}): ${predicates}.`;
  });
  const refusals = [...new Set([...common, ...words(messages[2]), ...acceptance, 'acceptance file changed: <project-relative path>'])];
  return `## Worker Actions\n\nGenerated from Runtime \`kits/general/worker-tools.json\` and its adapters by \`node harness/worker-inventory.mjs\`. The Runtime installer replaces the legacy adapters at \`adapters/engineering-work/\`; the original twelve \`eng.*@1\` contracts remain compatible.\n\nReceipt rows map to the predicates below. Mutating tools also report \`eng.tree_step(from_gen,to_gen)\`; a no-change row uses \`(-1,-1)\`. Reads work during a job without recording a generation step. Acceptance discovery and web calls skip the Source lock and tree walk. Refusals return \`rows:[]\`, \`verdict\`, exit 2 and the verdict on stderr. A spec refusal can also say \`spec refused: <reason>\` in fixed words.\n\n${rows.join('\n')}\n\nFixed adapter refusal vocabulary (each applies only to the relevant operation): ${refusals.map(s => `\`${s}\``).join(', ')}.\n\n\`eng.read\` pages text with \`offset,next_offset,complete,start_line\`; v2 additionally records the full file digest. \`eng.list\` reports \`entries\`; list/search/glob may say \`truncated\`; search reports \`unreadable_files\`. \`eng.tree_state.measure_specs\` includes owner-pinned and self-pinned measurements. \`eng.read_image\` returns a \`rulith.artifacts\` envelope (no inline bytes or facts). Web receipts digest the complete fetched bytes or scrubbed search text.\n\n\`eng.acceptance\` discovers \`.rulith/acceptance/<check>.json\` and records ${signature('eng.acceptance@2', 'eng.check_spec')} (\`eng.acceptance@1\`: ${signature('eng.acceptance@1', 'eng.check_spec')}); \`files\` is JSON text: an array of \`{path,sha256}\` objects. A spec has exactly \`command\`, \`cwd\`, \`files\` and optional \`shell\`, and no output directories; with \`shell: true\` the command is one line for the system shell, which \`eng.test@3\` and \`eng.test@2\` refuse unless the owner enabled \`shell\`. Command words (or the shell line), \`cwd\` and \`files\` paths must be printable ASCII without a leading or trailing space; paths use \`/\`, contain no \`:\` and never name the root \`.git\`. Invalid specs and an unreadable directory appear only in text \`errors\`: ${discoveryErrors.map(s => `\`${s}\``).join(', ')}. \`eng.test@3\` takes one \`check\`, verifies its pinned dependencies before and after running, and records ${signature('eng.test@3', 'eng.check_result')} (\`eng.test@2\`: ${signature('eng.test@2', 'eng.check_result')}). A check whose own run changes the tree (outside the owner's \`treeExclude\`) is stamped at the generation before the run, and the same receipt records the step past it, so it never passes on the tree it created. The check key is \`<project>:<check>:<spec_digest>\`. The official v3 program derives \`eng.check_passed(key)\` only for a passing check on its project's current tree, so a looser spec or another project's pass never meets a signed leaf; the legacy v2 package derives \`eng.check_passed(check,spec_digest)\`. The model proposes these atoms as child goals; the person signs them in Console, freezing the leaves. The Board certifies the root when all signed criteria hold. The model never writes the root outcome rule. A root without a signed contract or user acceptance waits with \`awaiting:"acceptance"\`. Legacy \`eng.test@1\` still uses \`<kit home>/specs/test.json\`.\n\n\`eng.list.kind\`: \`directory\`, \`link\`, \`file\`. Job \`status\`: \`starting\`, \`running\`, \`stopping\`, \`done\`, \`stopped\`, \`failed\`. Measurement \`unit\`: \`ms\`, \`us\`, \`tokens_per_second\`, \`bytes_per_second\`; \`value_milli\` is an integer. No success prose or benchmark numbers are added.\n\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = new URL('./model-visible.md', import.meta.url);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/## Worker Actions\r?\n[^]*?(?=## Bridge failures)/, workerInventory()));
}
