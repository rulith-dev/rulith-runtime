# Model-visible changes in batch 5 (2026-10-25)

中文摘要：批次 5（负责人 2026-10-25 "全部批准"）改了模型看得到的四处文字：人设加一句"跟随用户的语言回复"；附录里的验收定义一句改为
写明字段并给一个格式示例，并去掉"在 Console 签字"；同一句里如实说明 eng.write_file 不会创建缺的父目录、要先用 eng.run
建（第 4 节，工具包、版本号与摘要都不变）；项目上下文一行把 "Deep Rulith" 改为 "the Rulith app"。没有新增工具，也没有
别的新教学。每处的原文与新文逐字列在下面；`app/harness/model-visible.md` 是模型可见文字的总清单。

Authority: design `rulith/docs/reviews/rulith-app-design-2026-10-22.md` §1 (the UI and model replies use the user's
language), §3.2 row 模型回复语言, §5 f, §6 row "模型反复试错验收定义格式（未知字段、目录不存在）"; the owner's approval of
batch 5 on 2026-10-25, which includes model-visible text changes on condition that each is listed here verbatim.

Nothing else the model sees changed: the three Rulith tools and their schemas, the Board layout of results, the web
tools' text, the reviewer's prompt and the Runtime's own agent prompt (`agent/rulith-agent.mjs`) are as before. The
conversation's tool-call rows, the running status and the composer placeholders changed for the person only.

## 1. Persona: replies follow the user's language

- Location: `app/harness/runtime-persona.txt` (the app's persona; web and headless roles), first paragraph.
- Why: on 2026-10-19 two tasks in Chinese got one Chinese and one English reply; the tool results the model reads are
  English. Design §3.2 模型回复语言: "跟随用户的语言（人设一句话）".
- Old:

```text
You are a conversational assistant using Rulith for governed work. Answer greetings and general questions directly. Describe installed capabilities and business state from tool results.
```

- New (one sentence inserted after the second):

```text
You are a conversational assistant using Rulith for governed work. Answer greetings and general questions directly. Reply in the language the user writes in, even when tool results are in English. Describe installed capabilities and business state from tool results.
```

## 2. Addendum: the acceptance spec's exact fields with one example, and no "in Console" for signing

- Location: `app/harness/rulith-gate.mjs` `ADDENDUM` (shared by the web and headless roles; `web/rulith-web-gate.mjs`
  re-exports it). The approved tail's digest pinned in `app/test/harness/v4-surface.test.mjs` changes from
  `b6d5a863a4d99139e1140968ca38fbde72059d416a6802e7addc19d783c3116b` to the digest of the new tail (see that test).
- Why: on 2026-10-19 the model tried unknown fields in `.rulith/acceptance/<check>.json` several times (the kit refuses
  any field but `command`, `cwd`, `files` and `shell`); design §6 asks for a format example. Since batch 4 the person signs
  proposed criteria in the app's 任务 panel (Console still can), so "in Console" sent people away from the first path
  (design §1: the first path never enters Console); the sentence now says only that the criteria await their signature.
- Old:

```text
Early, propose the acceptance: for each criterion write a check spec .rulith/acceptance/<check>.json (command, cwd, files with their sha256) with the test files it runs, call eng.acceptance so the Board records each check with its key, and declare one child goal per check under your goal with desired eng.check_passed(key), copying key from that check's eng.check_spec receipt (where the receipt has no key, desired eng.check_passed(check, spec_digest)). Then tell the person once that the criteria await their signature in Console and keep working:
```

- New:

```text
Early, propose the acceptance: for each criterion write a check spec .rulith/acceptance/<check>.json with the test files it runs; a spec has exactly command, cwd, files (each test file's sha256) and optional shell, such as {"command":["node","test/check.mjs"],"cwd":".","files":{"test/check.mjs":"<its sha256>"}}; eng.write_file does not create missing parent folders, so create them first with eng.run. Call eng.acceptance so the Board records each check with its key, and declare one child goal per check under your goal with desired eng.check_passed(key), copying key from that check's eng.check_spec receipt (where the receipt has no key, desired eng.check_passed(check, spec_digest)). Then tell the person once that the criteria await their signature and keep working:
```

The example is itself a valid spec for the kit's `eng.acceptance@2` (it names the program file the command runs in
`files`). The clause about parent folders is section 4; the rest of the addendum is unchanged.

## 3. Project context line: the app's name

- Location: `app/harness/web/project-source.mjs` `projectLine` (the second of its two lines; the first is unchanged).
- Why: D-1019b names the app Rulith; a model repeating this line told the person to open the folder "in Deep Rulith".
- Old:

```text
This workspace (<directory>) is not an approved Rulith project; project file Actions cannot reach it until the owner opens it as a project in Deep Rulith (Agents with the official engineering capability) or adds it in Console (other Agents).
```

- New:

```text
This workspace (<directory>) is not an approved Rulith project; project file Actions cannot reach it until the owner opens it as a project in the Rulith app (Agents with the official engineering capability) or adds it in Console (other Agents).
```

## 4. Addendum: writing a file does not create missing parent folders

- Location: the same acceptance sentence of `app/harness/rulith-gate.mjs` `ADDENDUM` (shown whole in section 2), one clause
  after the spec example.
- Why: design §6 "模型反复试错验收定义格式（…目录不存在）". A first acceptance spec `.rulith/acceptance/<check>.json` in a
  fresh project fails with `parent directory missing`: no kit write tool creates a missing folder (by design, kept
  unchanged; the official capability stays 1.0.0 with its pins and digests). The design's wording "父目录会自动创建" is
  not what the kit does, so the clause states the actual behaviour and the way out instead (coordinator's decision
  2026-10-25: no kit change, no Release re-publish).
- Old: (no such clause; the example ended the spec sentence with ".")
- New (the clause, between the spec example and "Call eng.acceptance"):

```text
; eng.write_file does not create missing parent folders, so create them first with eng.run.
```

No example command is given: which command can make a folder depends on the Worker (see below).

Measured on Windows (2026-10-25) through the kit's `eng.run@2`: without the owner's `shell` setting, `mkdir .rulith`
runs only when an executable `mkdir` is on the Worker's PATH (Git for Windows' `usr\bin`, or any POSIX system); the
Windows system PATH with only `Git\cmd` has none, and `cmd /c mkdir` is refused as a shell line. With `shell: true`,
cmd's own `mkdir` works (without `-p`).

## PSC 0.2.29 本机客户端文字（逐字）

> 已被取代（D-1025b，2026-10-25）：本机应用改为英文优先，规范文字是 `docs/ui-texts-english.md` 列出的英文（PSC 0.2.32），
> 测试按 `app/test/harness/psc-0.2.32-text.mjs` 逐字核对；下面的中文只是浏览器语言为中文时显示的译文，已不再逐字固定
> （`psc-0.2.29-text.mjs` 已删除；`refusedPrefix`、`unavailablePrefix` 改为带 `{teaching}`、`{category}` 的整句）。
> 本节保留作批次 5 的历史记录。

以下是本机客户端（Rulith 应用）的中文文字，由 PSC 0.2.29（D-1025a）逐字固定；Console 保留它自己的英文文字（签字的
文字 A、档位的文字 9）。客户端代码 `app/harness/web/rulith-dsh-ui/lib/client.js` 里的 `SIGN`、`SIGN_REASONS`、
`TIER`、`MODE_WORDS`、`MODE_HINTS`、`WIDEN_TEXT`、`TIER_REFUSALS`、`REVIEW_REFUSALS` 与这里逐字相同，测试
（`app/test/harness/psc-0.2.29-text.mjs`）按这份表核对。没有对应中文句子的拒绝码，显示通用句子（"没有切换"
或"这次切换没有被接受"）后接服务的原文，从不隐去原因。

### 签字（文字 A 的本机中文本，"目标"一律作"任务"）

签字确认框的正文是 `body`；`refusedPrefix`、`unavailablePrefix` 后接下一表的原因与"。"。

| 用途 | 文字 |
| --- | --- |
| `title` | 待你签字的验收标准 |
| `button` | 签下这些标准 |
| `body` | 你要把这些标准签为这个任务的验收。它们由智能体提出；签下之后，智能体不能再结束或修改它们，只有在当前状态下每一条都成立，这个任务才算完成。这是你以自己账户做出的决定。 |
| `accept` | 签字 |
| `cancel` | 先不签 |
| `signed` | 已签字。 |
| `pending` | 签字结果还没有确认，稍后会自动刷新。 |
| `unreadable` | 暂时读不到待签字的标准 |
| `signing` | 正在签字… |
| `refusedPrefix` | 没有签下任何标准： |
| `unavailablePrefix` | 这些标准现在不能签： |
| `truncated` | 这个任务的标准太多，这里只列出一部分；请在 Console 里签字。 |
| `moreInConsole` | 还有等签字的任务没有列在这里：请在 Console 里查看。 |
| `replaced` | 签字后会被替换 |
| `notCriterion` | 不能作为验收标准 |
| `unknownReason` | 原因未知，请稍后再试 |
| `stale` | 上一次签字的结果还没有确认，那次签的是之前的标准。 |

### 签字被拒的原因（按 Kernel 的拒绝码）

| 用途 | 文字 |
| --- | --- |
| `unknown_goal` | 找不到这个任务 |
| `goal_ended` | 这个任务已经结束 |
| `goal_paused` | 这个任务已暂停 |
| `contract_fixed` | 这个任务的验收标准由能力规定，不用签字 |
| `leaf_not_proposed` | 这些标准已经变了，请看最新的再签 |
| `criterion_unsupported` | 其中有一条不能作为验收标准 |
| `goal_pending_obligations` | 这个任务还有没办完的事，稍后再签 |

### 档位：开关、菜单与三档各一句人话

| 用途 | 文字 |
| --- | --- |
| `label` | 档位： |
| `fresh` | 默认 |
| `unreadable` | 读不准 |
| `mixed` | （不一致） |
| `menu` | 这个会话的档位 · 收窄立即生效，放宽先确认 |
| `menuMixed` | 这个会话的档位不一致：显示的是其中最严的一档，再选一次即统一 |
| `menuFresh` | 这个会话还没有用过 Rulith：选一档就生效，默认取智能体的档位；放宽先确认 |
| `accepted` | 已受理，还没有生效 |
| `betweenCalls` | 已受理，还没有生效：会在这次调用结束后生效 |
| `later` | 已受理，还没有生效，稍后再看一次 |
| `notSwitched` | 没有切换 |
| `notAccepted` | 这次切换没有被接受 |

| 用途 | 文字 |
| --- | --- |
| `strict` | 严格 |
| `derived` | 推导 |
| `non_strict` | 宽松 |

| 用途 | 文字 |
| --- | --- |
| `strict（说明）` | 写入和运行要先有可信的依据 |
| `derived（说明）` | 能从记下的事实推出理由，就可以写入和运行 |
| `non_strict（说明）` | 模型给出的命令和参数直接执行；完成仍要你签字验收 |

### 放宽档位的确认（文字 9 的本机中文本）

| 用途 | 文字 |
| --- | --- |
| `non_strict.title` | 切换到宽松档？ |
| `non_strict.accept` | 切换到宽松 |
| `non_strict.cancel` | 先不切换 |
| `non_strict.body` | 这个环境的工具在写入和运行时，会接受模型给出的输入，即使这次会话的依据里没有可信的事实支持它们。这样的每一次调用都会在记录里注明：它的输入没有可信的依据。需要你决定的调用不会在你决定之前运行；写入仍只在你授权的位置之内；你没有锁定的工具仍然不能用。你随时可以切换回来。 |
| `derived.title` | 切换到推导档？ |
| `derived.accept` | 切换到推导 |
| `derived.cancel` | 先不切换 |
| `derived.body` | 只要模型能从它记在这次会话依据里的事实和规则，推出这次操作和它关键输入的理由，就可以在这个环境的工作区里写入和运行。那些事实不必是可信的证据。需要你决定的调用不会在你决定之前运行；写入仍只在本机的工作区之内。 |

### 切换被拒的原因：档位与审查两条路由共用

| 用途 | 文字 |
| --- | --- |
| `exploration_control_pending` | 这个会话的档位还在收窄，什么都没有改；稍后再试。 |
| `control_pending` | 上一次的设置还没有完成，什么都没有改；稍后再试。 |
| `agent_call_pending` | 智能体手上还有一次调用没有结束或待核对，结束后才能改；什么都没有改。 |
| `observation_in_progress` | 还有一次观察没有结果，有了结果再试；什么都没有改。 |
| `configuration_unconfirmed` | 智能体的设置正在生效，稍后再试；什么都没有改。 |
| `conversation_ended` | 这个会话已删除，不能再改。 |
| `board_unavailable` | 读不到这个会话的记录，什么都没有改；稍后再试。 |
| `request_conflict` | 这次请求和之前的一次冲突了，什么都没有改；请再选一次。 |
| `exploration_mode_unconfirmed` | 读不到这个会话现在的档位，什么都没有改；稍后再试。 |
| `conversations_unavailable` | 会话设置的结果没能确认，请再试一次。 |
| `device_revoked` | 这台电脑的登录已经失效，请在左下角重新登录。 |
| `device_unauthenticated` | 这台电脑的登录已经失效，请在左下角重新登录。 |
| `unauthenticated` | 这台电脑的登录已经失效，请在左下角重新登录。 |
| `not_authorized` | 这台电脑的登录没有被授权使用这个智能体。 |
| `agent_not_found` | 这个智能体现在不可用。 |
| `not_signed_in` | 这台电脑没有登录 Rulith：先在左下角登录。 |
| `manager_signing_out` | 这台电脑正在退出 Rulith 登录，现在不能改。 |
| `manager_closing` | 本机 Rulith 正在关闭，现在不能改。 |

### 只在档位切换上出现

| 用途 | 文字 |
| --- | --- |
| `review_required_by_derived_mode` | 先为这个会话打开事后审查，再切到推导档。 |
| `derived_mode_unavailable` | 推导档需要这个智能体有审查员，并允许模型写规则：先在 Console 里为它指定审查员。 |

### 只在审查开关上出现

| 用途 | 文字 |
| --- | --- |
| `derived_requires_review` | 先把这个会话切出推导档，再关闭事后审查。 |
