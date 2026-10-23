# Deep Rulith

Deep Rulith is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
and gives it [Rulith](https://rulith.ai) as its tools, beside dsh's read-only web search and fetch. It uses dsh's web UI and agent, with a
profile overlay that adds a Rulith account entry (bottom left) and keeps the Rulith Runtime's three
columns (sessions, conversation, and on the right this environment's execution: goals, operations,
frontier and the local Worker), replaces
every other local dsh tool with Rulith's three MCP tools (`rulith/v4`), and turns off dsh features that would act outside
Rulith or cut its results (subagents, goals, workflows, plan mode, result pruning). Long conversations
are condensed by dsh's automatic compaction; the summary is a recap, not evidence. Reading, editing,
building and testing happen only
through Rulith Actions executed by your own Rulith Worker, so every effect has a receipt on the
Agent's Board and a goal completes only when the Board certifies it from evidence.

The sidebar brand is a plain mark. New conversations start under an Agent and project. Plugins,
schedules, the dsh job roster, permission and Agent-preset toggles, cross-conversation references,
sub-agent delegation, changed-file cards and document previews are disabled. File and directory
`@` references remain available. Conversation rows offer only confirmed deletion; its internal
archive step runs after successful deletion. Historical child conversations remain readable, with
a read-only composer. The fixed Rulith Agent preset and Rulith execution authorization remain active.

It is also a worked example of a third-party agent harness using Rulith.

> Alpha. Not affiliated with DeepSeek. See [NOTICE](NOTICE).
>
> Since 2026-10-23 (D-1019c) the app lives in the Rulith Runtime repository under `app/` and uses that repository's own
> Runtime (`local/`, `worker/`, `kits/general/`); the former `rulith-dev/deep-rulith` repository is retired. Until the app
> ships in the `rulith` npm package, run it from a checkout of this repository.

## What is in `app/`

| Path | What it is |
| --- | --- |
| `harness/web/` | The dsh web profile overlay (`rulith-web.cordis.yml`), the host plugin that runs the Rulith Runtime manager beside dsh (`rulith-runtime.mjs`), the tool gate, the browser plugin (`rulith-dsh-ui`) and the launcher. |
| `harness/` | The MCP bridge (`rulith-mcp.mjs`), the gate and persona text shared with the web profile, and an experimental headless role. |
| `test/` | Node tests. |

Deep Rulith uses the general Worker kit in this repository's `kits/general/`. The former local `engineering-work/` kit is retired.

## What leaves your computer

- Model requests, including file text and command output the model has seen, go to the
  OpenAI-compatible endpoint set in Rulith's model settings. The overlay uses DeepSeek's thinking
  format and a 1M-token context window; change `rulith-web.cordis.yml` for other models.
- Tool calls go to the Rulith Gateway you sign in to. Worker receipts recorded on your Agent's
  Board include bounded file text (up to 1 KiB head and tail), command output and digests.
- The model's native web tools (D-1015c, read-only and outside Rulith): `web_search` sends its queries to DeepSeek's
  search API with the model key, offered only when Rulith's model is DeepSeek's own API; `web_fetch` sends GET requests
  to public http(s) URLs (local, private and link-local addresses are refused). Their results leave nothing on the Board.
- dsh telemetry, feedback, session upload and the DeepSeek account integration are disabled by the overlay.

## Install and start

Requires Node.js 22.19 or later (tested with 24).

```bash
npm install        # at the repository root; also installs dsh
npm run app
```

Deep Rulith opens in your browser (`npm run app -- --no-open` only prints the address). Stop it with Ctrl+C in
its terminal. The folder you start it in is the default workspace of new conversations; that is not a grant of access.

Everything it keeps on this computer is in one folder, `~/.rulith/app` (set `RULITH_APP_HOME` to use another; one Deep
Rulith runs per folder):

| Path | What it is |
| --- | --- |
| `manager/` | The Rulith Runtime manager directory: this computer's sign-in, its Agents and their local Workers. |
| `manager.key` | A random key for the local manager, made on the first start (owner-only file permissions where the system has them). Never printed. |
| `dsh/` | dsh's home, with the Deep Rulith profile (created on the first start). |
| `kit/` | The general Worker kit's home: its optional `settings.json` and pinned specs. |

Ports: the manager prefers 7790 and the browser page 3080; when one is busy another free port is used.

Then, in Rulith, a first-run wizard (开始使用 Rulith) takes you through three steps; each is read from the account's
current state, so it resumes where you left off, per account, and a returning user who has all three never sees it
(稍后再说 puts it away until the page is reloaded):

1. ① 登录: sign in to your Rulith account; the approval opens in the browser.
2. ② 选模型并填密钥: the endpoint, the model ID and the key, saved as the signed-in account's default model (PSC 0.2.27 ④).
   A saved model is used from the next turn of every conversation of that account; a turn already running finishes on
   the previous one. No restart. The key stays on this computer and is never shown back. The same form is under
   设置 → 模型, and the composer's 模型 chip opens it.
3. ③ 打开文件夹 (PSC 0.2.24), under the account's default Agent: choose the folder in the operating system's folder
   chooser (or 手动输入路径). An Agent not yet set up on this computer is set up first, in one step whose progress is
   shown (连接 → 安装编程工具 → 开启这台电脑 → 重新载入 → 完成; PSC 0.2.27 ② ③): it creates or reuses this Agent's
   instance, connects this computer (a Connection this computer already had is reconnected — after signing in again
   too — and one is created only when there is none), installs the general Worker kit, turns this computer's Worker on,
   and waits until the Worker reports the kit's tools, without a restart or a choice. Installing and turning on grant
   nothing: tools and folders are authorized by opening a project. A confirmation shows the folder, what may be done
   there (read, write and run commands), that "in this folder" is not operating-system isolation, and how to withdraw it
   (unlock the project in Console, or revoke this computer's sign-in); under 详细 it lists the account, the Agent, this
   computer, what the non-strict mode means and the tools with their versions, as the account service reports them.
   After 打开项目 the progress is shown; when the project is ready a new conversation starts in that folder under that
   Agent. Before anything is asked of the account service, 「在本机设置」 runs again in repair mode: whatever is missing
   (the kit, the Worker, an unfinished connection) is fixed first, and a working connection is left as it is. Existing
   conversations keep their settings. No Console step is needed; the Agent must hold the official engineering
   capability (new accounts get it on their Default agent). On Windows a network folder (a share, or a folder on a
   mapped network drive) cannot be opened: commands cannot use it as their working directory.

Later, more folders open from the sidebar: 「📂 打开文件夹…」 under an Agent. 「在本机设置」 there sets up an Agent that is
not set up here, with the same progress; 默认 marks the account's default Agent (when the account service says which),
and the Agent of the open conversation is highlighted. The one settings page (bottom left: the account, this computer's
state and ⚙ 设置) has 账户, 这台电脑 (each Agent's Worker state, and 「在本机设置」 again as a repair), 模型, 外观与语言 and
高级 (where other MCP clients get the Agent's token in Console, and the English Runtime workbench for diagnosis). The
composer has two chips: 档位, one per conversation (narrowing applies at once, widening asks first), and 模型; 审查
appears only when the Agent has a reviewer designated.

   This needs a Gateway with the open-project routes (`/local-devices/projects/*`); the manager in this repository forwards
   them (`/manager/projects/*`).

### Developers: a settings file

From a checkout (`npm install` at the repository root, which also installs dsh), `node app/harness/web/start-deep-rulith.mjs <settings.json> [dsh web flags]`
(or `Deep-Rulith.cmd` with `deep-rulith.json` beside it, ignored by git) starts the same launcher with the settings in the
file instead of the derived ones: see [`deep-rulith.example.json`](deep-rulith.example.json); all paths are absolute and
the file is used as it is. A missing dsh profile is created on the first start (`--init` after the file creates it and
exits). Settings files and their backups can carry credentials and are never packed.

The general kit is installed only by the Runtime manager's setup operation (`/manager/instances/setup-local`), which
「在本机设置」, opening a folder and the app's start all use. When the app starts and reaches the manager — whether it
started the manager or another launcher sharing this manager home did — it runs that operation in repair mode for each
Agent set up here with its Worker on that already has the kit (only `agentName`'s, kit or not, when the settings name one);
the start never makes a first install, which is 「在本机设置」 or opening a folder. An Agent whose kit is current is
left as it is. Otherwise the manager drains that Agent's Worker (calls in progress finish and settle; a Worker still busy
after 40 seconds keeps its old files and the refresh is retried at the next start or setup), then the installer replaces
the adapters in `adapters/engineering-work/` and merges the kit tools into that Agent's manifest, preserving other tools
and setting the Worker timeout from `settings.json` (including general web limits), and the Worker is started again and
must report the kit's tools. A new Agent's kit home is `kitHome` (the app home's `kit/`), else its own instance folder.

When the kit is (re)installed, owner edits to what it owns are undone: in the Agent's `local.json` Worker environment
`RULITH_WORKSPACE_TOOLS` is reset to `read` and `RULITH_WORKER_RUN_TIMEOUT_SECONDS` is recomputed from `settings.json`,
and in its Worker tool manifest every `eng.*` tool that is not in the kit is removed (non-`eng.*` tools stay). Change
limits in the kit home's `settings.json` instead.

The model: every turn of a conversation is routed to the model saved in Rulith for that conversation's Agent under the
account signed in at that moment (the Agent's own model, else the account default; `harness/web/model-runtime.mjs`).
The launcher no longer passes any model key to dsh; the key is read from the manager home per turn and kept in memory.
The turn's model is chosen when the turn starts, before dsh's step compaction, and a conversation's compaction and title
requests go to it (between turns, to the model in force then), never to an older route its log names; routes of an
account no longer signed in are unregistered. A model on this computer (127.0.0.1, localhost or ::1) has `localContextWindow`
as its context window. At start the launcher prints, for each Agent attached here, where its model comes from, the model id
and the endpoint (never a key).
`web_search` is offered when the signed-in account's model is DeepSeek's own API at start, and each search uses the key
of its turn's model. The local Worker's reviewer route follows the Agent's model too (the Runtime derives it at each
Worker start); the launcher writes only `reviewerRoutes` and the reviewer request extra into Worker settings.

| Launcher environment | Default | Purpose |
| --- | --- | --- |
| `RULITH_RUNTIME_DIR` | This repository | Another Runtime checkout whose `kits/general` the harness reads (tests, Worker inventory); normally unset. The manager, and so every kit installation, uses the configured `runtimeEntry`. |

| Launcher setting | Default | Purpose |
| --- | --- | --- |
| `agentName` | none | The Agent this launcher uses; the kit refresh at start covers only this Agent. |
| `kitHome` | none (`kit/` in the app home) | Kit home the setup operation gives an Agent that has none yet (passed to the host as `RULITH_DSH_KIT_HOME`). |
| `modelHome` | none | Developers: read the account default model from another manager home, the row of the account signed in to that home. Saving the default from this app is then refused. |
| `localContextWindow` | none (1M) | The context window of a model on this computer (a loopback endpoint); context relief and dsh's compaction measure against it. Must be a positive whole number. |
| `consoleUrl` | none (sign-in uses `https://console.rulith.ai`) | Console address (no secret), also used for this computer's sign-in. When set, a goal awaiting acceptance in the Rulith panel opens the Agent's cases in Console (`<origin>/console/#/cases?agentId=…`), where the person signs the criteria; without it the panel row offers only the local workbench and says so. |

## Tests

```bash
npm run test:app   # at the repository root
```

The tests use this repository's Runtime unless `RULITH_RUNTIME_DIR` names another. Set `DSH_BASE_FILE` to the installed `@deepseek-ai/dsh-base/cordis.patch.yml` (or `DSH_REFERENCE_DIR` to its source checkout) to run the tool-disable check as well, and `DSH_MODULES_DIR` to the installed dsh's `node_modules` to run the installed-dsh contract checks (disabled delegation providers/tools, and the outgoing trim on dsh's real agent loop and request path); after `npm install` these are the root `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` and `node_modules`. The launcher refreshes its shipped browser plugin on every start; upgrading does not require recreating your profile.

## License

Apache-2.0. dsh is MIT-licensed and installed from npm as a dependency (pinned); this repository contains none of its code.
