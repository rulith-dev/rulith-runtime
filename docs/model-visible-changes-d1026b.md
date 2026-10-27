# Model-visible changes of D-1026b, "append-only between reliefs" (2026-10-26)

中文摘要：D-1026b（负责人 2026-10-26 批准）让发给模型的对话在两次减负之间只在末尾追加，好让本机模型服务的提示缓存
命中。模型看得到的文字因此改了三处、搬了两处：变化的两种表头末尾那句从“最新一份结果给出整个视图”改为“整个当前视图在
对话末尾”（第 1、2 节）；新增当前整视图的表头一行（第 3 节）；整视图原有的两种表头与写板提醒原文不变，只是从最新一份
结果里搬到对话末尾的当前整视图里（第 4、5 节）；以前各轮的思考不再在人发来新消息时去掉，只随一批减负去掉，当前这一轮的
思考总是发回（第 6 节，不是文字，是模型看到的内容）。审查之后又补了四处位置与内容上的变化，文字都不变（第 7～10 节）：
一批减负现在也可以落在最新一份带板结果上；以前的版本留下的整视图在升级后的第一次请求之前降为变化；末尾是 dsh 的系统／
开发者更新时，当前整视图接在它之前那条人的消息或工具结果上；Anthropic 协议的路线上，当前整视图是工具结果之后单独的一块。
每处的原文与新文逐字列在下面，等负责人逐字批准；`app/harness/model-visible.md` 是模型可见文字的总清单，已按新做法改写。

Authority: owner decision D-1026b (approved 2026-10-26): each Rulith result is rendered once, as its changes, and not
rewritten afterwards except by a relief batch; the complete current Board is attached only in the outgoing copy, at the end
of the last message, under a clear header; thinking blocks are removed only before the relief boundary. Model-visible text
is kept unchanged wherever possible; this document lists every string added or changed, verbatim, for word-by-word approval.
Sections 6 to 10 follow the independent review of the first commit (P1-2, P2-4, P2-5, P2-6, P2-1).

Nothing else the model sees changed: the three Rulith tools and their schemas, the result head (line 1 and its text
blocks), the line marks and the comparison rules (per section, `Not in this view (read with Get to see them): …`), the
relief line and the relief and compaction thresholds, the shortened-argument text, the web tools' text, the reviewer's
prompt and the persona. Results laid out before this change keep their text (read back as they are and never rewritten,
except by a relief batch), with one exception: a whole view that was the latest result is demoted once (section 8).

## 1. Header of a result's changes

- Location: `app/harness/web/board-transcript.mjs` `DELTA_HEAD`; the line after the result head of every laid-out Rulith
  result with a Board, now the latest one too (until now the latest result showed the whole view instead).
- Why: the last clause pointed the model at the latest result for the whole view; the whole view is now at the end of the
  conversation (section 3), so the clause says where it is.
- Old (still read back, as `SCOPED_DELTA_HEAD`, in results laid out from 2026-10-14 to 2026-10-26):

```text
Board view changes at this step (+ new, - gone; unchanged lines left out; parts a view does not include keep their last state; the latest result shows the whole view):
```

- New:

```text
Board view changes at this step (+ new, - gone; unchanged lines left out; parts a view does not include keep their last state; the whole current view is at the end of the conversation):
```

The first result of a conversation has no view before it, so under this header every line is `+` (until now the first
result, while it was the latest, was shown under `Board view now (…; your first view in this conversation, so every line
is +):`).

## 2. Header of a result that changed nothing

- Location: `app/harness/web/board-transcript.mjs` `DELTA_NONE`; the same place as section 1.
- Why: as section 1.
- Old (still read back, as `SCOPED_DELTA_NONE`):

```text
Board view changes at this step: none (parts a view does not include keep their last state; the latest result shows the whole view).
```

- New:

```text
Board view changes at this step: none (parts a view does not include keep their last state; the whole current view is at the end of the conversation).
```

## 3. New: the current Board's header line

- Location: `app/harness/web/board-transcript.mjs` `TAIL_HEAD`. It is the first line of the current Board, which
  `app/harness/web/outgoing-trim.mjs` adds only to the copy of the agent's own requests (never to dsh's compaction summary
  request; never stored in the session or shown in the transcript), as one more text block at the end of the last
  person's message or tool result of the request (of any tool; section 9): a blank line (`TAIL_SEPARATOR`, two line
  breaks), then this line. Not added when the conversation has no Rulith result with a Board (or dsh has compacted the
  newest one away). On Anthropic-protocol routes it is its own block (section 10).
- Why: the current Board can follow any message, for example a web page fetched after the latest Rulith call; the line
  says what it is, where it comes from, and that it is not part of the message it follows.
- Old: (none; the whole view was the latest Rulith result's own text)
- New:

```text
Current Board as of your latest Rulith result that returned a view (added by the app at the end of the conversation; not part of the message above):
```

Below it, unchanged, the whole view as the latest result showed it until now: one of the two header lines of section 4,
the `Not in this view (read with Get to see them): …` line when it applies, one line per item marked `+`, `-` or `=`
against the views before it, and the write reminder of section 5 when it applies.

## 4. Moved, wording unchanged: the whole view's header lines

- Location: `app/harness/web/board-transcript.mjs` `FULL_HEAD`, `FULL_FIRST`. Until now the line after the result head of
  the latest Rulith result; now the second line of the current Board (section 3).
- Why: D-1026b keeps the whole view out of the conversation's history; reusing the approved lines keeps the wording.
- Old and new (unchanged):

```text
Board view now (the whole view Rulith returned; + new, - gone, = unchanged; parts a view does not include keep their last state):
Board view now (the whole view Rulith returned; your first view in this conversation, so every line is +):
```

## 5. Moved, wording unchanged: the write reminder

- Location: `app/harness/web/board-transcript.mjs` `writeNote`. Until now the line after the latest result's Board rows,
  removed when the result was demoted to its changes; now the last line of the current Board (section 3). The rule is
  unchanged: 6 or more Rulith calls with a Board since the last accepted Set.
- Why: a result is no longer rewritten after it is laid out, so a reminder written into it would stay in the history;
  in the current Board it appears once, as before.
- Old and new (unchanged):

```text
Note: <n> Rulith calls since your last accepted Set. Record what you have learned on the Board before relying on it.
```

## 6. Content, not wording: earlier reasoning is resent until a relief batch

- Location: `app/harness/web/outgoing-trim.mjs` rule 1.
- Old (2026-10-14 to 2026-10-26): reasoning blocks of model replies before the latest message from a person were not sent.
- New: reasoning blocks are not sent only for model replies that are both before the relief boundary (the newest Board
  result ending with the relief line `Context relieved up to here: …`, unchanged) and before the latest message that starts
  a turn (from a person, or a parent agent's message to a sub-agent). Every other reply is sent with its reasoning:
  always the current turn, and earlier turns after the boundary. What was observed: DeepSeek's guide says reasoning should
  be passed back when tools are used; from 2026-10-14 to 2026-10-26 production dropped every earlier turn's reasoning at
  each new message from a person on DeepSeek without errors, and before 2026-10-14 all earlier reasoning was resent (the
  earlier rule never took effect), also without errors. So the current turn's reasoning is always kept (the part that is
  strictly required), and earlier turns' reasoning is dropped only with a relief batch. When a relief boundary falls inside
  a turn, that turn's replies before it lose their reasoning when the next turn starts. The relief line's wording is
  unchanged; it does not mention reasoning.

## 7. Placement, wording unchanged: the newest Board result can be the relief boundary

- Location: `app/harness/web/board-transcript.mjs` `render` (relief batch).
- Old: a relief batch never touched the latest Rulith result, because it carried the whole view; when the batch's boundary
  would have been the latest Board result (6 other tool results after it), that result was neither relieved nor marked.
- New: the newest Board result is relieved like any other result in the batch and can be the boundary: its head becomes
  the compact relieved JSON (`"cleared": "<N> characters of this earlier result were cleared to save context; the Board
  holds the state"`, unchanged) and it ends with the relief line (unchanged). The current Board (section 3) is not relieved:
  its lines come from that result as it arrived.

## 8. Placement, wording unchanged: a whole view laid out before the upgrade is demoted once

- Location: `app/harness/web/board-transcript.mjs` `render`.
- Old: in a conversation from before the upgrade, the latest result was a whole view (`Board view now (…`, possibly with
  the write reminder after it); it was demoted to its changes when the next result arrived.
- New: at the first request after the upgrade it is demoted to its changes, under the header of section 1, without the
  write reminder; from then on it is kept. Changes laid out from 2026-10-14 to 2026-10-26 keep their old header.

## 9. Placement, wording unchanged: which message carries the current Board

- Location: `app/harness/web/outgoing-trim.mjs` rule 3.
- Old (first commit of D-1026b): the current Board was added only when the last message was a user-role message or a tool
  result.
- New: it goes on the last user-role message or tool result. A user-role message is usually the person's, but can be
  dsh's repeated-tool-call reminder or the project context line, whichever is last. When dsh's system or developer
  updates follow it, the current Board is added to the end of that message, before them. When that message is a tool
  result without text, dsh's adapter sends `(no output)` for it; the block then starts with `(no output)` followed by
  the blank line and the current Board, so the next request, which sends `(no output)` alone, still starts with the same
  text. A tool result whose text is empty no longer has `(no output)` replaced by the Board.

## 10. Placement, wording unchanged: Anthropic-protocol routes carry the current Board as its own block

- Location: `app/harness/web/outgoing-trim.mjs` `cacheBeforeBoard`, used by `app/harness/web/model-runtime.mjs` for
  routes that speak Anthropic Messages.
- Why: pi-ai puts the conversation's one cache breakpoint on the last block of the last user message, which would be the
  current Board; the conversation would never be read from cache.
- New: on those routes only, the current Board is sent as a separate text block right after the content it follows (after
  a person's text, or after the tool result it ended, in the same user message), without its leading blank line, and the
  cache breakpoint stays on the content before it. Only the exact text the app attached to this request is split off,
  never text that merely looks like it (a web page or a pasted message quoting the header line stays whole). When dsh
  turned a trailing system update into a user message after it, the current Board is split off the message before, and
  the breakpoint moves there. The text of the current Board is unchanged. Chat Completions routes (the local model,
  DeepSeek) are unchanged: the current Board stays at the end of that message's text.
