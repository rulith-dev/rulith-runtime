# Rulith Local Runtime

This repository contains **Rulith Local**, the local half of Rulith. One runtime
can start in Agent, Worker, or Agent+Worker mode and always exposes the same
loopback Local UI.

It is the canonical source for the downloadable local runtime. Hosted services may
carry release copies of these files, but changes must originate here and retain the
hashes recorded in `artifact-manifest.json`.

| Role | Responsibility | Trust boundary |
| --- | --- | --- |
| Agent Runtime | Drives the model-to-board loop | Model credentials stay in this process |
| Worker | Executes declared tools and reports synchronous receipts | Source credentials stay in the local vault |
| Local host | Starts selected roles and projects one Case-aware CLI/Web experience | Listens on loopback and requires a per-run key |

The runtime is domain-neutral. An Agent reasons in Actions. Its installed Capability
defines vocabulary, criteria, Actions, and Source requirements; an independent
Constitution may constrain them. A Worker Tool Manifest maps each versioned Tool
referenced by an executed Action to a local Adapter. The local processes contain no
hidden order-processing policy or other business workflow.

## Requirements

- Node.js 20 or newer
- A Rulith Cloud account and Agent token
- A model endpoint compatible with Anthropic Messages or OpenAI Chat Completions
- A Rulith Connection id and key when a workflow needs local execution

Clone the current beta release:

```bash
git clone --depth 1 https://github.com/rulith-dev/rulith-runtime.git
cd rulith-runtime
npm test
```

No build step is required. Start one of the three supported modes:

```powershell
npm start -- --role agent
npm start -- --role worker
npm start -- --role agent+worker
```

`rulith start` is the equivalent command after linking or installing this package.
The Agent and Worker remain separate child processes even in combined mode. Database
tools load the optional `pg` package only when used.

## Agent Runtime

```powershell
$env:RULITH_TOKEN = '<agent-token>'
$env:RULITH_AGENT = 'default'
$env:RULITH_MODEL_KEY = '<model-key>'
$env:RULITH_MODEL = '<model-id>'
$env:RULITH_MODEL_URL = 'https://your-model-endpoint/v1/chat/completions'
node agent/rulith-agent.mjs --agent default
```

Each task opens one Case under an installed Capability's Case Type. Use the
Case Type catalog exposed by Rulith Cloud; exploratory work defaults to the
platform-owned `exploration` contract:

```powershell
node agent/rulith-agent.mjs --agent default --case-type verified_calculation --business-key '{"job_id":"calc-001"}' "calculate and verify this job"
```

For the loopback service, `POST /task` accepts the same selection as
`{"text":"...","caseType":"verified_calculation","businessKey":{"job_id":"calc-001"},"sessionKey":"optional"}`.
`RULITH_CASE_TYPE` and `RULITH_BUSINESS_KEY_JSON` set local defaults. Contracted
Case Types require the exact business-key argument names shown by their Case
Contract; exploration omits them. The Runtime sends values only. Cloud computes
and pins the business-key, Capability Release, Case Contract, generation, and
commercial-term digests before the Case opens, so the model never fills them.

The working model receives one bounded **Case View**: the current terminal Goal,
verified acceptance state, frontier, missing evidence, blocking reasons, and the
relevant actions/state. It does not receive the complete Board history or billing
and Release-control records. Replying `VIEW:` refreshes that same bounded view.

The `exploration` Case Type is the only mode that permits provisional Case-local
predicates, rules, Actions, and Goals. They never modify installed Capabilities
or shared Agent law and disappear when the Case closes. Its Terminal Receipt is
exploratory and never Publisher-billable; only later attribution and replay may
turn repeated paths into a Capability draft.

Use Rulith Local for the browser workbench. The direct Agent entry point remains a
terminal and automation surface. Run `node agent/rulith-agent.mjs --help` to inspect
its options without configuring credentials.

The Agent Runtime sends board commands to Rulith Cloud and model requests directly
to the configured model endpoint. It does not upload the model key to Rulith.

## Worker

The Agent's governed Actions name versioned Tools and Sources. The Worker ships one
small built-in `workspace` Adapter and also accepts a local Tool Manifest for custom
integrations (`http`, `run`, `db-query`, `db-exec-fenced`, or `mcp`). Adapter
configuration is not installed as a Capability and is never uploaded to the board. A
`run` entry must be a relative file beneath the Worker root; it cannot select an
arbitrary command, absolute path, or shell. Credentials remain in the local source
vault.

The built-in workspace catalog mirrors the common file abilities of coding Agents
without exposing a shell:

| Tool id | Operation | Local ceiling |
| --- | --- | --- |
| `rulith.workspace.list@1` | List one directory | Read |
| `rulith.workspace.count@1` | Count files and directories exactly within a bounded path | Read |
| `rulith.workspace.search@1` | Search bounded text files | Read |
| `rulith.workspace.read_text@1` | Read bounded UTF-8 text | Read |
| `rulith.workspace.read_json@1` | Parse and return JSON | Read |
| `rulith.workspace.hash@1` | Compute SHA-256 | Read |
| `rulith.workspace.write_text@1` | Write bounded UTF-8 text | Read-write only |
| `rulith.workspace.write_json@1` | Serialize and write JSON | Read-write only |
| `rulith.mcp.discover@1` | List bounded MCP Tool metadata | Read |

Every path is relative to the bound file Source's `access` root. Traversal, absolute
model-supplied paths, symbolic-link writes, binary text reads, oversized files, delete,
and arbitrary command execution are rejected. Bounded read Tools are enabled by default;
set `RULITH_WORKSPACE_TOOLS=off` for a review-only process or `read-write` when the
workflow needs governed writes. This setting is only a local host ceiling; it never
grants the Agent permission to use a Tool. The Worker presents only the Tool ids carried
by its exact Connection recipe.

For a package that needs no private credential, run:

```powershell
$env:RULITH_CONNECTION = '<connection-id>'
$env:RULITH_CONNECTION_KEY = '<connection-key>'
$env:RULITH_TOOLS_FILE = 'C:\path\to\worker-tools.json'
node worker/rulith-worker.mjs
```

For a Capability whose Actions reference the built-in workspace Tool ids, a local
manifest is unnecessary:

```powershell
$env:RULITH_CONNECTION = '<connection-id>'
$env:RULITH_CONNECTION_KEY = '<connection-key>'
$env:RULITH_WORKSPACE_TOOLS = 'read-write' # optional; bounded read is the default
node worker/rulith-worker.mjs
```

Each work item names a governed file Source bound to this Agent Connection and configured
with an allowed root directory. The Connection must already carry each exact versioned Tool
id through an installed governed Action. A Worker's first poll pins implementation
digests; it cannot authorize Tools merely by presenting them.

The Worker polls outbound and presents only Tool id, digest, and accepted Source types. Rulith checks
that every presented Tool was authorized for the Agent-owned Connection, pins the
implementation set, and dispatches an Action only when its Tool accepts the Cloud-injected Source type. The
Worker resolves the Adapter locally, executes it, and reports a receipt before polling
again. A model request cannot grant itself a Tool, Source, credential, Adapter, or
verification authority.

Adapters are a fast way to implement Tools; they are not an Agent-facing concept. For
example:

```json
{
  "format": "rulith-worker-tools/1",
  "tools": {
    "acme.orders.lookup@1": {
      "adapter": "db-query",
      "sourceTypes": ["db"],
      "entry": "SELECT order_id, status FROM orders WHERE order_id={order_id}"
    },
    "acme.erp.lookup@1": {
      "adapter": "mcp",
      "sourceTypes": ["mcp"],
      "entry": "orders.lookup"
    }
  }
}
```

The governed Action declares the typed `order_id` slot and result mapping. The Worker
compiles database placeholders to driver parameters, never SQL interpolation. MCP
discovery is read-only; it does not grant a generic call surface. Each remote MCP Tool
must still be approved as its own versioned local Tool and governed Action.

## Rulith Local

Copy `config/rulith-local.example.json` outside the repository, select `agent`,
`worker`, or both roles, fill in the local values, and run:

```powershell
$env:RULITH_LOCAL_CONFIG = 'C:\path\to\rulith-local.json'
npm start
```

Rulith Local prints one loopback URL containing a random key. In Agent+Worker mode,
the Local UI uses the familiar Agent-workbench shape: Case/conversation navigation on
the left, dialogue and governed execution in the center, a composer at the bottom,
and Case View, frontier, Worker activity, evidence, and receipts on the right. Agent
and Worker modes use role-specific projections of the same UI and event contract.

The Local UI is a view of the runtime, not a board or authority service. A remote
Worker remains independently deployed and outbound-only; its authoritative activity
appears through the Cloud Connection and receipts rather than direct Local control.

## Five-minute verified file workflow

The smallest end-to-end example reads trusted numbers from one local JSON file,
derives the exact total on the board, writes another JSON file, reads it back, and
only then accepts the result.

```powershell
cd examples/verified-calculation
node prepare-runtime.mjs
```

Follow the generated paths and the instructions in
[`examples/verified-calculation/README.md`](examples/verified-calculation/README.md).
The model never supplies the trusted input values or the calculated output values.

## Security model

- Agent tokens and model keys belong to the Agent Runtime process.
- Connection keys and source credentials belong to the Worker machine.
- Built-in workspace Tools are fenced to the configured Source root, bounded in size and
  result count, and expose neither delete nor arbitrary shell execution.
- `run` tools execute relative adapters beneath the Worker root with the current Node
  runtime; packages cannot select arbitrary commands or escape that directory.
- HTTP tools are constrained to their declared source or allowlist.
- Database read tools accept a single `SELECT`; every model value is passed through the
  database driver's parameter array rather than interpolated into SQL. Fenced write tools
  classify and reject unsupported or destructive statements unless the declared contract allows them.
- Submitted work is not self-verification. Acceptance remains a board and policy decision.

See [`SECURITY.md`](SECURITY.md) for reporting and deployment guidance.

## Project status

The runtime is beta software. Protocol compatibility is versioned, but command-line
flags and the Local UI may still change before 1.0.

The Local UI and primary onboarding path are English. Runtime-facing diagnostics
must be English; internal source comments may use another language.

Please use the [setup question template](https://github.com/rulith-dev/rulith-runtime/issues/new?template=question.yml)
for workflow design questions and the other issue templates for reproducible defects and feedback.

## License

Apache-2.0. The license covers the code in this repository; it does not grant rights
to the hosted Rulith Cloud service or the Rulith trademarks.
