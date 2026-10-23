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

It is also a worked example of a third-party agent harness using Rulith.

> Alpha. Not affiliated with DeepSeek. See [NOTICE](NOTICE).

## What is in this repository

| Path | What it is |
| --- | --- |
| `harness/web/` | The dsh web profile overlay (`rulith-web.cordis.yml`), the host plugin that runs the Rulith Runtime manager beside dsh (`rulith-runtime.mjs`), the tool gate, the browser plugin (`rulith-dsh-ui`) and the launcher. |
| `harness/` | The MCP bridge (`rulith-mcp.mjs`), the gate and persona text shared with the web profile, and an experimental headless role. |
| `research-ledger/` | A general Capability for keeping an investigation (hypotheses, data, decisions) on the Board. |
| `test/` | Node tests. |

Deep Rulith uses the general Worker kit shipped by the Rulith Runtime in `kits/general/`. The former local `engineering-work/` kit is retired. Until a Runtime release includes the general kit and acceptance contracts, use the local Runtime checkout below.

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
npm install --global deep-rulith
deep-rulith
```

Deep Rulith opens in your browser (`deep-rulith --no-open` only prints the address). Stop it with Ctrl+C in
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

Then, in Deep Rulith:

1. Bottom left → Rulith account: sign in, choose the Agent, enable the local Worker.
2. Set the model (endpoint, model name, key) under 更多设置 (the Rulith workbench), then restart Deep Rulith. The restart
   also installs the general Worker kit for the paired Agent (into `kit/`).
3. Open a project (PSC 0.2.24): in the left sidebar, under the Agent, choose 「📂 打开文件夹…」, enter the folder's full
   path and press 打开. A confirmation lists what opening grants, as the account service reports it: the folder, the
   account, the Agent, this computer, reading, writing and running commands in the folder, the tools used, what the
   non-strict mode means, that "in this folder" is not operating-system isolation, and how to withdraw it (unlock the
   project in Console, or revoke this computer's sign-in). After 打开项目 the sidebar shows the progress; when the project is ready a new
   conversation starts in that folder. Existing conversations keep their settings. No Console step is needed; the Agent
   must hold the official engineering capability (new accounts get it on their Default agent). On Windows a network
   folder (a share, or a folder on a mapped network drive) cannot be opened: commands cannot use it as their working
   directory.

   This needs a Gateway with the open-project routes (`/local-devices/projects/*`) and a Runtime whose manager forwards
   them (`/manager/projects/*`, the release after `rulith` 0.17.2). With an older Runtime the sidebar says the Runtime
   is too old. Until that Runtime is published, a development checkout can use a local one:
   `npm install --no-save <path-to-rulith-runtime-checkout>`; once it is published, raise the `rulith` dependency in
   `package.json` to that version.

### Developers: a settings file

From a checkout (`npm install`, which also installs dsh), `node harness/web/start-deep-rulith.mjs <settings.json> [dsh web flags]`
(or `Deep-Rulith.cmd` with `deep-rulith.json` beside it, ignored by git) starts the same launcher with the settings in the
file instead of the derived ones: see [`deep-rulith.example.json`](deep-rulith.example.json); all paths are absolute and
the file is used as it is. A missing dsh profile is created on the first start (`--init` after the file creates it and
exits). Settings files and their backups can carry credentials and are never packed.

Before starting dsh and the manager, the launcher refreshes the general kit for its own Agent (`agentName` in the
settings; every paired Agent with an existing kit home when no `agentName` is set; with `kitHome`, which the app home
always has, also every paired Agent whose Worker is enabled but has no kit home yet). When a manager already listens on
`managerPort`, another launcher shares this manager home and its Workers are running, so the refresh is skipped for
that start. The Runtime installer replaces the old adapters in `adapters/engineering-work/` and merges the twenty
kit tools into that Agent's manifest, preserving other tools and setting the Worker timeout from
`settings.json` (including general web limits); it writes `local.json` and the manifest by temp file + rename.
The refresh neither pairs an Agent nor enables its Worker.

Because the installer runs at every start, owner edits to what it owns are undone: in the Agent's `local.json` Worker
environment `RULITH_WORKSPACE_TOOLS` is reset to `read` and `RULITH_WORKER_RUN_TIMEOUT_SECONDS` is recomputed from
`settings.json`, and in its Worker tool manifest every `eng.*` tool that is not in the kit is removed (non-`eng.*` tools
stay). Change limits in the kit home's `settings.json` instead.

| Launcher environment | Default | Purpose |
| --- | --- | --- |
| `RULITH_RUNTIME_DIR` | Installed `rulith` package | Local Runtime checkout used for `kit install general` instead of the installed `rulith` (0.17.0 and later ship `kits/general`); normally unset. This selects the kit installer; the manager still uses the configured `runtimeEntry`. |

| Launcher setting | Default | Purpose |
| --- | --- | --- |
| `agentName` | none | The Agent this launcher uses; the kit refresh at start covers only this Agent. |
| `kitHome` | none (`kit/` in the app home) | Kit home given to a paired Agent whose Worker has none yet. |
| `consoleUrl` | none (sign-in uses `https://console.rulith.ai`) | Console address (no secret), also used for this computer's sign-in. When set, a goal awaiting acceptance in the Rulith panel opens the Agent's cases in Console (`<origin>/console/#/cases?agentId=…`), where the person signs the criteria; without it the panel row offers only the local workbench and says so. |

## Tests

```bash
RULITH_RUNTIME_DIR=<rulith-runtime checkout> npm test
```

Without `RULITH_RUNTIME_DIR` the tests use the installed `rulith` package. Set `DSH_BASE_FILE` to the installed `@deepseek-ai/dsh-base/cordis.patch.yml` (or `DSH_REFERENCE_DIR` to its source checkout) to run the tool-disable check as well, and `DSH_MODULES_DIR` to the installed dsh's `node_modules` to run the installed-dsh contract checks (sub-agent tools, and the outgoing trim on dsh's real agent loop and request path); after `npm install` these are `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` and `node_modules`. The launcher refreshes its shipped browser plugin on every start; upgrading does not require recreating your profile.

## License

Apache-2.0. dsh is MIT-licensed and installed from npm as a dependency (pinned); this repository contains none of its code.
