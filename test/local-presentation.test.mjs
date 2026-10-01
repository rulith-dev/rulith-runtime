import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../local/markdown.mjs'
import { renderToolCall, localPage } from '../local/local-ui.mjs'
import { localToolSnapshot } from '../agent/local-trace.mjs'

test('conversation Markdown preserves headings, emphasis, lists, tables and literal code',()=>{
  const html=renderMarkdown('## 处理过程\n\n**核对依据**\n\n| 步骤 | 结果 |\n| --- | --- |\n| 读取 | `a\\|b` |\n\n1. 首项\n2. 次项\n\n```json\n{"value":"<raw>"}\n```');
  assert.match(html,/<h2>处理过程<\/h2>/);assert.match(html,/<strong>核对依据<\/strong>/);
  assert.match(html,/<table>/);assert.match(html,/<th>结果<\/th>/);assert.match(html,/<code>a\|b<\/code>/);
  assert.match(html,/<ol><li>首项<\/li><li>次项<\/li><\/ol>/);assert.match(html,/&lt;raw&gt;/);
});
test('untrusted Markdown cannot execute HTML or load remote images',()=>{
  const html=renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert) ![photo](https://external.example/image) [safe](https://example.com/?a="evil")');
  assert.doesNotMatch(html,/<script|<img|href="javascript:|\sonerror=/);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/&quot;/);
});
test('tool cards show actual arguments and results without inventing Board certification',()=>{
  const input=localToolSnapshot({operations:[{op:'assert_fact',predicate:'order.count',value:3}]});
  const output=localToolSnapshot({accepted:true,result:{nodeIds:['n1']}});
  const html=renderToolCall({callId:'call-1',cmd:'ApplyBatch',input},{authoritative:true,accepted:true,output});
  assert.match(html,/<details/);assert.match(html,/Arguments/);assert.match(html,/order.count/);assert.match(html,/nodeIds/);
  assert.doesNotMatch(html,/certified|completed/i);
  assert.match(renderToolCall({cmd:'ApplyAction'},undefined),/Waiting for result/);
  assert.match(renderToolCall({cmd:'ApplyAction'},{authoritative:false,transportFailed:true}),/No answer \(connection failed\)/);
  assert.match(renderToolCall({cmd:'ApplyAction'},{authoritative:true,accepted:false,notExecuted:true}),/Not executed/);
  assert.match(renderToolCall({cmd:'ApplyAction'},{authoritative:true,held:'running'}),/Still running/);
  assert.match(renderToolCall({cmd:'ApplyAction'},{authoritative:true,held:'waiting_for_decision'}),/Waiting for a decision/);
  assert.doesNotMatch(renderToolCall({cmd:'ApplyAction'},{authoritative:true,held:'needs_person'}),/act-state bad/,
    'an operation that waits for a person is not a refusal');
  assert.match(renderToolCall({cmd:'<script>'},{authoritative:true,output:localToolSnapshot('<script>')}),/&lt;script&gt;/);
});
test('a settled outcome whose content is withheld shows its outcome class, never "Held"',()=>{
  // Nothing is in progress: the call settled, and only its content may not be shown.
  const done=renderToolCall({cmd:'ApplyAction'},{authoritative:true,held:'done',contentWithheld:true});
  assert.match(done,/<span class="act-state">Done · content withheld<\/span>/);assert.doesNotMatch(done,/Held/);
  assert.match(renderToolCall({cmd:'ApplyAction'},{authoritative:true,held:'failed',contentWithheld:true}),/act-state bad">Failed · content withheld/);
  assert.match(renderToolCall({cmd:'ApplyAction'},{authoritative:true,held:'refused',contentWithheld:true}),/act-state bad">Refused · content withheld/);
  assert.match(renderToolCall({cmd:'ApplyAction'},{authoritative:true,held:'unknown',contentWithheld:true}),
    /<span class="act-state">Reconciled, external effect unknown · content withheld<\/span>/);
});
test('large results are explicitly truncated and never split a UTF-8 character',()=>{
  const snapshot=localToolSnapshot({text:'中文'.repeat(100)},53);
  assert.equal(snapshot.truncated,true);assert.ok(snapshot.totalBytes>53);assert.doesNotMatch(snapshot.text,/�/);
  assert.match(renderToolCall({cmd:'QueryBoard'},{authoritative:true,output:snapshot}),/preview is incomplete/);
  const script=/<script[^>]*>([\s\S]*?)<\/script>/.exec(localPage)[1];assert.doesNotThrow(()=>new Function(script));
});
