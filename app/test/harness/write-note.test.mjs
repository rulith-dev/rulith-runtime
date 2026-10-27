import test from 'node:test';
import assert from 'node:assert/strict';
import { boardTail, classify, plan, FULL_HEAD, DELTA_HEAD, WRITE_NOTE_AFTER, writeNote } from '../../harness/web/board-transcript.mjs';
import { RELIEF_MARK } from '../../harness/web/context-relief.mjs';

const raw = (answer) => JSON.stringify({ isError: false, content: [{ type: 'text', text: JSON.stringify(answer) }] });
const board = (accepted = true) => ({ accepted, view: { position: { writes: 'open' } }, operations: [] });
const item = (tool, accepted = true) => Object.assign(classify(raw(board(accepted))), { tool });

// D-1026b：提醒接在当前整视图之后（只在发出的副本里），不写进任何一份结果，所以历史只追加、提醒也不堆积。
test('after enough calls without an accepted Set, only the current Board carries the reminder', () => {
  const items = [item('Set'), ...Array.from({ length: WRITE_NOTE_AFTER }, () => item('Execute'))];
  assert.ok(boardTail(items).endsWith(`\n${writeNote(WRITE_NOTE_AFTER)}`));
  assert.ok(plan(items).every((text) => !text.includes('Note:')));
  assert.ok(!boardTail(items.slice(0, -1)).includes('Note:'), 'one call fewer: no reminder yet');
});

test('an accepted Set resets the count; a refused one does not', () => {
  const quiet = [...Array.from({ length: WRITE_NOTE_AFTER - 1 }, () => item('Get')), item('Set')];
  assert.ok(!boardTail(quiet).includes('Note:'));
  const refused = [...Array.from({ length: WRITE_NOTE_AFTER - 1 }, () => item('Get')), item('Set', false)];
  assert.ok(boardTail(refused).endsWith(writeNote(WRITE_NOTE_AFTER)));
});

test('a whole view laid out before 10-26 with the reminder is demoted once, without it', () => {
  const oldFull = Object.assign(classify(['{"accepted":true}', FULL_HEAD, '+ position.writes: "open"', '+ operations: []', writeNote(WRITE_NOTE_AFTER)].join('\n')), { tool: 'Execute' });
  assert.equal(oldFull.kind, 'full');
  const items = [oldFull, item('Set')];
  const texts = plan(items);
  assert.deepEqual(texts[0].split('\n'), ['{"accepted":true}', DELTA_HEAD, '+ position.writes: "open"', '+ operations: []']);
  assert.ok(!texts[1].includes('Note:'));
  // In a relief batch it is relieved like any other result.
  const relieved = plan(items, { boundary: 0 })[0].split('\n');
  assert.deepEqual(relieved, ['{"accepted":true}', DELTA_HEAD, '+ position.writes: "open"', '+ operations: []', RELIEF_MARK]);
});
