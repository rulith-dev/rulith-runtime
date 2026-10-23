// Builds the research-ledger Capability: a general vocabulary for keeping an investigation on the Board (what is
// being tested, the data it rests on, which questions are still open) and three domain rules that decide openness.
// Conclusions (supported / refuted) are the Agent's own rules over recorded receipts and data, so its reasoning is on
// the Board; what counts as "open" belongs to this package and cannot be redefined by the Agent.
//
//   node research-ledger/build.mjs            writes program.json and draft.json (program + examples + citations)
//   java -jar local-authoring.jar --check research-ledger/draft.json research-ledger/method.txt report.json
import fs from 'node:fs';

const at = (name) => new URL(`./${name}`, import.meta.url);
const method = fs.readFileSync(at('method.txt'), 'utf8');
const cite = (ruleId, quote) => {
  const start = method.indexOf(quote);
  if (start < 0) throw new Error(`quote not in method.txt: ${quote}`);
  return { ruleId, quote, locator: { kind: 'character-range', start, end: start + quote.length } };
};

// 0.4.0（rulith/v4，A 包 A-23）：账本以目标为键，不再以 case_id 为键。顶层目标就是 Case 的根，模型看到的目标 ID 正是
// root 的 node，所以键换成目标本身（模型的词汇里不再有 Case 身份；case_open、case_datum 也随之改名 goal_open、goal_datum）。
// root 与 case_context 仍留在规则体里，只作根的脚手架：每一行都从这个目标的 root 与 context 推出，所以按这个目标读板时
// 包含它（按目标读会沿根的证据向前走，不在这条路上的事实不进这一页）。0.3.0 以 case_id 写下的旧行在 0.4.0 下不再显示：
// 切换前收尾旧的探索 Case（A-25）。
const goalOf = [
  { predicate: 'root', args: { node: '?g' } },
  { predicate: 'case_context', args: { root: '?g', case_type: '?t', case_id: '?k' } },
];
const program = {
  // Published as research_ledger_2 (a Board that once had research_ledger 0.1.0 refused any other content under that
  // name while Rulith emitted every Release as Kernel version 1). Since the 2026-10-07 Gateway the version follows the
  // content, so new versions of research_ledger_2 upgrade in place.
  id: 'research_ledger_2',
  title: 'Research ledger',
  summary: 'Keeps an investigation on the Board: hypotheses with their goal, the data they rest on, dropped directions, and which hypotheses are still open. Each top-level goal shows its ledger as research.ledger.item and research.ledger.goal_datum rows.',
  vocabulary: {
    defines: [
      { id: 'research.ledger.hypothesis', as: 'hypothesis', args: ['id', 'claim', 'goal'] },
      { id: 'research.ledger.datum', as: 'datum', args: ['name', 'value', 'unit', 'source', 'goal'] },
      { id: 'research.ledger.supported', as: 'supported', args: ['hypothesis'] },
      { id: 'research.ledger.refuted', as: 'refuted', args: ['hypothesis'] },
      { id: 'research.ledger.dropped', as: 'dropped', args: ['hypothesis', 'reason'] },
      { id: 'research.ledger.is_dropped', as: 'is_dropped', args: ['hypothesis'] },
      { id: 'research.ledger.item', as: 'item', args: ['goal', 'hypothesis', 'claim', 'state'] },
      { id: 'research.ledger.goal_datum', as: 'goal_datum', args: ['goal', 'name', 'value', 'unit', 'source'] },
      { id: 'research.ledger.goal_open', as: 'goal_open', args: ['goal'] },
      { id: 'research.ledger.cites', as: 'cites', args: ['goal', 'from_goal'] },
    ],
    imports: [{ id: 'root', as: 'root' }, { id: 'case_context', as: 'case_context' }],
  },
  // Owned by this package: the Agent cannot assert or redefine them.
  pins: ['is_dropped', 'item', 'goal_datum', 'goal_open'],
  rules: [
    { id: 'ledger_dropped_with_reason', label: 'A hypothesis dropped with a reason is dropped.',
      when: [{ predicate: 'dropped', args: { hypothesis: '?h', reason: '?x' } }],
      then: [{ predicate: 'is_dropped', args: { hypothesis: '?h' } }] },
    { id: 'ledger_item_open', label: 'A hypothesis stays open until it is supported, refuted or dropped.',
      when: [...goalOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', goal: '?g' } },
        { predicate: 'supported', args: { hypothesis: '?h' }, naf: true },
        { predicate: 'refuted', args: { hypothesis: '?h' }, naf: true },
        { predicate: 'is_dropped', args: { hypothesis: '?h' }, naf: true }],
      then: [{ predicate: 'item', args: { goal: '?g', hypothesis: '?h', claim: '?c', state: 'open' } }] },
    { id: 'ledger_item_supported', label: 'A hypothesis a rule derives as supported is shown as supported.',
      when: [...goalOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', goal: '?g' } },
        { predicate: 'supported', args: { hypothesis: '?h' } }],
      then: [{ predicate: 'item', args: { goal: '?g', hypothesis: '?h', claim: '?c', state: 'supported' } }] },
    { id: 'ledger_item_refuted', label: 'A hypothesis a rule derives as refuted is shown as refuted.',
      when: [...goalOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', goal: '?g' } },
        { predicate: 'refuted', args: { hypothesis: '?h' } }],
      then: [{ predicate: 'item', args: { goal: '?g', hypothesis: '?h', claim: '?c', state: 'refuted' } }] },
    { id: 'ledger_item_dropped', label: 'A dropped hypothesis is shown as dropped.',
      when: [...goalOf, { predicate: 'hypothesis', args: { id: '?h', claim: '?c', goal: '?g' } },
        { predicate: 'is_dropped', args: { hypothesis: '?h' } }],
      then: [{ predicate: 'item', args: { goal: '?g', hypothesis: '?h', claim: '?c', state: 'dropped' } }] },
    { id: 'ledger_goal_with_open_hypothesis', label: 'A goal with an open hypothesis still has an open question.',
      when: [{ predicate: 'item', args: { goal: '?g', hypothesis: '?h', claim: '?c', state: 'open' } }],
      then: [{ predicate: 'goal_open', args: { goal: '?g' } }] },
    { id: 'ledger_goal_data', label: 'Each datum recorded for a goal is shown with that goal.',
      when: [...goalOf, { predicate: 'datum', args: { name: '?n', value: '?v', unit: '?u', source: '?s', goal: '?g' } }],
      then: [{ predicate: 'goal_datum', args: { goal: '?g', name: '?n', value: '?v', unit: '?u', source: '?s' } }] },
    // D-1008c (O5c): a later goal uses an earlier goal's data by citing it, instead of recording the numbers again.
    // The datum facts stay on the Board after the earlier goal ends; the citing goal shows them as its own rows, and
    // each such row's evidence names the cites fact, so the dependency stays on the Board.
    { id: 'ledger_cited_goal_data', label: 'Data of a cited goal is shown with the citing goal.',
      when: [...goalOf, { predicate: 'cites', args: { goal: '?g', from_goal: '?f' } },
        { predicate: 'datum', args: { name: '?n', value: '?v', unit: '?u', source: '?s', goal: '?f' } }],
      then: [{ predicate: 'goal_datum', args: { goal: '?g', name: '?n', value: '?v', unit: '?u', source: '?s' } }] },
  ],
  acceptance: [],
  actions: [],
};

// A top-level goal as the Board records it: the goal is the root, with the platform's context beside it.
const CTX = (g = 'goal-1', k = 'case-1') => [{ predicate: 'root', args: { node: g } },
  { predicate: 'case_context', args: { root: g, case_type: 'exploration', case_id: k } }];
const H = (id, g = 'goal-1') => ({ predicate: 'research.ledger.hypothesis', args: { id, claim: `claim ${id}`, goal: g } });
const ITEM = (h, state, g = 'goal-1') => ({ predicate: 'research.ledger.item', args: { goal: g, hypothesis: h, claim: `claim ${h}`, state } });
const OPEN = (g = 'goal-1') => ({ predicate: 'research.ledger.goal_open', args: { goal: g } });
// The mechanical checker needs a Case contract with an acceptance bridge to its root (it refuses a certified /1
// contract without one). Both exist only in the draft; the published program.json keeps acceptance empty.
const checkProgram = { ...program,
  vocabulary: { ...program.vocabulary, imports: [...program.vocabulary.imports, { id: 'acceptance', as: 'acceptance' }, { id: 'acceptance_met', as: 'acceptance_met' }] },
  acceptance: [{ id: 'check_only_bridge', label: 'Check-only bridge from the checker contract to its root.',
  when: [{ predicate: 'acceptance', args: { node: '?node', test: '?g' } }, { predicate: 'goal_open', args: { goal: '?g' } }],
  then: [{ predicate: 'acceptance_met', args: { node: '?node' } }] }] };
const draft = {
  program: checkProgram,
  // The checker needs one Case contract; this one exists only so the rules and examples can be checked. The
  // published package is program.json alone: the ledger is used inside other goals (for example exploration).
  caseContracts: [{ format: 'rulith-case-contract/1', caseType: 'research_ledger_check', title: 'Research ledger mechanical check',
    businessKey: { predicate: 'research.ledger.hypothesis', arguments: ['goal'] },
    opening: { predicate: 'research.ledger.hypothesis', keyArguments: ['goal'] },
    acceptance: { predicate: 'research.ledger.goal_open', keyArguments: ['goal'], minimumGroundingFloor: 'attested' },
    terminal: { cardinality: 'once_per_case', disposition: 'completed', requiresCertified: true } }],
  citations: [
    cite('ledger_dropped_with_reason', 'A hypothesis dropped with a reason is dropped.'),
    cite('ledger_item_open', 'A hypothesis stays open until it is supported, refuted or dropped.'),
    cite('ledger_item_supported', 'A hypothesis a rule derives as supported is shown as supported.'),
    cite('ledger_item_refuted', 'A hypothesis a rule derives as refuted is shown as refuted.'),
    cite('ledger_item_dropped', 'A dropped hypothesis is shown as dropped.'),
    cite('ledger_goal_with_open_hypothesis', 'A goal with an open hypothesis still has an open question.'),
    cite('ledger_goal_data', 'Each datum recorded for a goal is shown with that goal.'),
    cite('ledger_cited_goal_data', 'Data of a cited goal is shown with the citing goal.'),
  ],
  examples: [
    { label: 'an undecided hypothesis is open and keeps its goal open', facts: [...CTX(), H('h1')],
      expect: [ITEM('h1', 'open'), OPEN()], forbid: [] },
    { label: 'a supported hypothesis is shown as supported and closes its question', facts: [...CTX(), H('h1'), { predicate: 'research.ledger.supported', args: { hypothesis: 'h1' } }],
      expect: [ITEM('h1', 'supported')], forbid: [ITEM('h1', 'open'), OPEN()] },
    { label: 'a refuted hypothesis is shown as refuted', facts: [...CTX(), H('h1'), { predicate: 'research.ledger.refuted', args: { hypothesis: 'h1' } }],
      expect: [ITEM('h1', 'refuted')], forbid: [ITEM('h1', 'open')] },
    { label: 'a dropped hypothesis is shown as dropped', facts: [...CTX(), H('h1'), { predicate: 'research.ledger.dropped', args: { hypothesis: 'h1', reason: 'superseded' } }],
      expect: [ITEM('h1', 'dropped'), { predicate: 'research.ledger.is_dropped', args: { hypothesis: 'h1' } }], forbid: [ITEM('h1', 'open')] },
    { label: 'one open hypothesis keeps only its own goal open',
      facts: [...CTX('goal-1', 'case-1'), ...CTX('goal-2', 'case-2'), H('h1', 'goal-1'), H('h2', 'goal-2'), { predicate: 'research.ledger.refuted', args: { hypothesis: 'h2' } }],
      expect: [OPEN('goal-1')], forbid: [OPEN('goal-2')] },
    { label: 'a datum is shown with its goal', facts: [...CTX(), { predicate: 'research.ledger.datum', args: { name: 'gate_up_ms', value: '41.2', unit: 'ms', source: 'tmp/qk/base.json', goal: 'goal-1' } }],
      expect: [{ predicate: 'research.ledger.goal_datum', args: { goal: 'goal-1', name: 'gate_up_ms', value: '41.2', unit: 'ms', source: 'tmp/qk/base.json' } }], forbid: [] },
    { label: 'data of a cited goal is shown with the citing goal',
      facts: [...CTX('goal-2', 'case-2'), { predicate: 'research.ledger.cites', args: { goal: 'goal-2', from_goal: 'goal-1' } },
        { predicate: 'research.ledger.datum', args: { name: 'prefill_tok_s', value: '812', unit: 'tok/s', source: 'logs/pinned-prefill.json', goal: 'goal-1' } }],
      expect: [{ predicate: 'research.ledger.goal_datum', args: { goal: 'goal-2', name: 'prefill_tok_s', value: '812', unit: 'tok/s', source: 'logs/pinned-prefill.json' } }], forbid: [] },
    { label: 'nothing is shown for a goal that is not a root', facts: [H('h1', 'goal-9')],
      expect: [], forbid: [ITEM('h1', 'open', 'goal-9')] },
  ],
  questions: [],
  notes: 'supported and refuted are not owned by this package on purpose: an Agent decides a hypothesis with its own rule over the receipts and data that settle it, so its reasoning is recorded on the Board. item, goal_datum, goal_open and is_dropped are owned here, so an Agent cannot redefine when a question is open. Every shown row is derived from the goal root and its context so that a read of that goal includes it.',
};

fs.writeFileSync(at('program.json'), JSON.stringify(program, null, 2) + '\n');
fs.writeFileSync(at('draft.json'), JSON.stringify(draft, null, 2) + '\n');
console.log('wrote research-ledger/program.json and draft.json');
