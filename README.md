# Rulith Local Runtime

For guided setup with a local model or an existing MCP client, run `rulith setup`. See [cross-end setup](docs/local-setup.md).

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

Task and conversation results include `closedCases` when the Runtime observed accepted
Case closures in that turn. Each entry identifies the Case, its root and disposition;
the CLI and Local result note list them together. A final cancellation does not hide an
earlier completed Case. Mixed dispositions are not reported as all successful, and
refused calls or roots merely leaving focus are not counted as completed work. The
summary describes observed outcomes, not a second verification decision.

- Node.js 20 or newer
- A Rulith Cloud account and Agent token
- A model endpoint compatible with Anthropic Messages or OpenAI Chat Completions
- A Rulith Connection id and key when a workflow needs local execution

Run the current Rulith Local CLI without writing to a system-wide npm directory:

```bash
npx --yes rulith@latest --help
npx --yes rulith@latest start --role agent+worker
```

The first start creates `~/.rulith/local.json` (mode `0o600`, in a `0o700` directory)
and prints the loopback Local UI address, which carries the per-run key as `?k=`.
Windows does not enforce those mode bits, so on Windows restrict the file through its
ACL or keep the secrets in the deployment environment instead. Edit that file or inject
equivalent secrets through the deployment environment: one Agent identity and token,
one local model configuration, and—when Worker is enabled—one Agent-owned Connection
and key.

For an OpenAI-compatible local model service, set `RULITH_MODEL_URL` to its server
root such as `http://127.0.0.1:1234`; the Agent derives `/v1/chat/completions`.
A model key is optional only for a loopback endpoint; remote providers still require one.

DeepSeek Flash uses the same OpenAI-compatible path: set `RULITH_MODEL_URL` to
`https://api.deepseek.com/chat/completions`, `RULITH_MODEL` to `deepseek-flash`, and
`RULITH_MODEL_KEY` to your local provider credential. `RULITH_MODEL_THINKING=disabled`
explicitly disables thinking; `enabled` enables it, while omission leaves the provider
default unchanged. Provider reasoning continuation is retained in the local conversation
for subsequent native tool calls; it is not displayed as an answer or submitted as Board
evidence. See the [DeepSeek thinking/tool contract](https://api-docs.deepseek.com/guides/thinking_mode/).

For a persistent command, install globally into a user-writable npm prefix:

```bash
npm install --global rulith
rulith start
```

To inspect or contribute to the source instead:

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

`rulith start` is the installed command.
The Agent and Worker remain separate child processes even in combined mode. Database
tools load the optional `pg` package only when used.

## Agent Runtime

```powershell
$env:RULITH_TOKEN = '<agent-token>'
$env:RULITH_MODEL_KEY = '<model-key>'
$env:RULITH_MODEL = '<model-id>'
$env:RULITH_MODEL_URL = 'https://your-model-endpoint/v1/chat/completions'
node agent/rulith-agent.mjs
```

With no positional task, the Agent starts an ordinary conversation. It opens no
Case until the model calls `OpenCase`. A positional task is the autopilot path:
the same loop, kept going while the Board still has something to say.

```powershell
node agent/rulith-agent.mjs --case-type verified_calculation --business-key '{"job_id":"calc-001"}' "calculate and verify this job"
```

For the loopback service, `POST /task` accepts the same host-owned selection as
`{"text":"...","caseType":"verified_calculation","businessKey":{"job_id":"calc-001"},"sessionKey":"conversation-1"}`.
The first request may omit `sessionKey`; the service returns a newly generated one,
which the caller must echo on follow-ups. Two clients that omit it never share a
conversation or selected Case. A caller may also send an existing `caseId` from
`/runs` or Console to select a running Case or resume a paused one without opening a
replacement Case.
`RULITH_CASE_TYPE` and `RULITH_BUSINESS_KEY_JSON` set local defaults. Contracted
Case Types require the exact business-key argument names shown by their Case
Contract; exploration omits them. The Runtime sends values only. Cloud computes
and pins the business-key, Capability Release, Case Contract, generation, and
commercial-term digests before the Case opens, so the model never fills them.

### The model surface: six tools on one endpoint

The Agent Runtime is an ordinary MCP client. It connects to one path — `/mcp` — performs
the MCP 2025-11-25 handshake, reads `tools/list`, and offers the model exactly the six
tools of the unified MCP surface: five that dispatch to Board operations, and one read of
already-generated result data.

That membership is not written here. It is compiled from `protocol/mcp-contract.json`, the
contract bundle exported from a named commit of the contract repository and verified
against that repository's Git objects before it was vendored. The protocol version, the
metadata namespace, the client capability this host declares and the recovery states all
come from the same bundle. `npm run check` regenerates the projection and fails on drift,
so the Runtime cannot quietly speak a surface the contract does not name — and there is no
hand-written list to fall back to if the bundle is missing: that is an error, not a
default. The private Worker hop is vendored the same way, as `protocol/worker-contract.json`.

Each bundle records the commit it came from, and every file in it records the Git blob object
id of the bytes it carries. `npm run check` recomputes those ids from the carried bytes, and —
when the contract repository is on this machine — compares them against that commit. Finding
the repository is a guess by default (`../rulith`, and only if it looks like the contract
repository), so **`RULITH_CONTRACT_REPO`** overrides it: point it at the checkout that really
is the contract repository, or at a path that is not a repository at all to skip the
comparison and rely on the recomputed ids alone. A repository that is present and cannot
resolve the pinned commit is a hard failure rather than a skip — "I could not ask" and "I
asked and the answer was no" are different, and treating them alike is how a pin to a commit
that does not exist would pass as verified.

| Tool | What the model is asking for |
| --- | --- |
| `OpenCase` | Create a Case, or bring an existing one into this session's focus |
| `ApplyBatch` | Apply one atomic batch of working-memory operations |
| `ApplyAction` | Invoke one Action the Board View lists as available |
| `CloseCase` | Close a Case with an explicit disposition |
| `QueryBoard` | Read the bounded Board View this Agent's Profile permits |
| `ReadArtifact` | Read a bounded fragment of an already-generated result object |

There is no second vocabulary, no reply protocol, and no privileged path a third-party
client cannot reach. The Agent ships as a single file, so the contract is compiled into it
rather than read from a sibling at startup: a downloaded `rulith-agent.mjs` needs nothing
beside it to know its own surface. `ReadArtifact` is the one tool served by the Gateway's
result data plane rather than by a Board operation: it returns bytes and a continuation position, not a
Board View, and it creates no Case, writes nothing and changes no focus. The tool schemas
the Cloud advertises are the templates, so nothing
in the prompt restates them. `caseType` stays on `OpenCase`, but an operator who pinned
one with `--case-type`, `RULITH_CASE_TYPE` or a `POST /task` body has made that governance
selection, and a model turn cannot move the work onto another contract.

That membership is a contract, not a menu. An endpoint that advertises a sixth tool, a
duplicate, or one of the retired host surfaces is a **protocol mismatch**: startup refuses
and names both sides. Silently reinterpreting it into the approved six would be this client
deciding on its own what the authority had offered. The same applies to the protocol
version: an endpoint that negotiates anything other than 2025-11-25 is refused at the
handshake, because the session, streaming, resumption and serial-call rules this client
depends on are that version's.

Answers are checked against the request that asked for them — `jsonrpc: "2.0"` and the same
JSON-RPC id, compared by type as well as value. Streamable HTTP event streams are read as the
transport specifies: an event ends at a blank line, its `data:` lines are joined,
server-initiated messages that arrive ahead of the response are skipped, and the read
completes on the matched event rather than waiting for a close that the spec only
recommends. Each event's `id:` is kept as a cursor, so a stream that breaks before the
answer arrives is **resumed** with `Last-Event-ID` rather than re-decided — reissuing the
request would turn one command into two. A command sent under one authenticated session and
answered under another is an **unknown outcome**, not a metadata refresh.

Two server answers are read as themselves rather than as generic failures. `HTTP 409` with
JSON-RPC `-32000` and `data.reason = "connection_replaced"` means another authenticated
client is now this Agent's one effective client: this Runtime stops and does **not**
reconnect, because two hosts that both reconnect on that signal fight over one Agent.
`HTTP 404` means the transport session is gone, and the answer is to initialize a new one —
which says nothing about whether the call made under the old session executed.

Host metadata travels beside the model's content, never inside it, in the MCP `_meta`
block under `rulith/v1`: the authenticated Agent identity, the Board revision (an audit
string, never a precondition), the `{caseId, root}` focus pairs, the complete
`affectedCases`, and the recovery record described below. It travels one way. The protected
query context — `audienceProfile` and `requestedRoots` — is injected by the Gateway from the
authenticated principal, and the session id is a response header, so a conforming client
attaches nothing of its own. A model cannot name any of it: the Core command kind, query
context, admission block, request identity, and the retired `case` / `expectedRevision` /
`expectedBoardSharedEpoch` / `viewToken` fields are stripped from every advertised schema and
refused visibly if a model sends one anyway.

Identity comes from that handshake. Ordinary conversation — including startup and a plain
greeting — never touches the Board: there is no bootstrap query issued merely to learn
which Agent this is.

A conversation holds a *set* of acceptance roots with independent lifecycles, not one
active Case. Bringing an existing Case into focus is a host feature reached through
`--case` and the Local UI, and it uses the same public `OpenCase({caseId})` the model
would. Deterministic discharge, bounded waiting and closure mechanics belong to Cloud and
the Board; this runtime runs no second wait or discharge state machine, and a stopped
model turn is not a paused Case.

### One connection, one call at a time, one recovery path

The Agent has **one authenticated MCP connection**, and everything goes through it: every
local conversation, `--case`, the Local UI, and the shadow reviewer. Conversations are
transcripts, not clients — they keep their own message queues and are served **one segment
at a time**. A second authenticated connection does not isolate two conversations, it takes
the Agent over from one of them, so a host that opened a session per conversation was
replacing itself; genuine parallelism needs another Agent, which means another process with
another token.

Calls are serial: each completes before the next is sent, including several proposed in one
model turn — which are executed **in order**, not reduced to the first. The authority judges
each against the premises, grounding and policy in force when it runs; there is no view
token, no observation ledger and no first-write exception.

A call is identified by **(Agent, MCP session, JSON-RPC request id)**. All three parts
matter: under a different session the same body is a *different* logical call, so a call
whose outcome is unknown is never re-presented after the session that carried it has gone.
This host holds at most one such call — it is serial, so there is only ever one — and
remembers it durably until the authority says what became of it.

When a call's outcome cannot be determined, the queue stops there. From that point this
Agent sends nothing — no write, no `QueryBoard`, no `ReadArtifact` — and asks the model
nothing, because a model asked to decide during an unresolved call can only propose work
that cannot be carried. The state comes from the authority, on the base protocol's own
`ping`, whose empty result carries a recovery record under `rulith/v1`:

| State | What this host does |
| --- | --- |
| `none` | Nothing outstanding; work proceeds. Nothing is polled for. |
| `waiting` | Waits and pings on the authority's own hint. No model turn, no tool call. |
| `result_ready` | Sends exactly one claim, which executes nothing, and receives the earlier call's outcome as an error tool result. |
| `reconciliation_required` | Stops automatic recovery and shows the operator where to reconcile the original call. |

A state this Runtime cannot read blocks as well, and so does a *missing* record: `none` is
the authority saying there is nothing outstanding, and silence is this host having no idea.
An unrecognised or absent state treated as "nothing outstanding" is the one mistake that
lets a command run twice.

The other disagreement that stops work is this host holding a call whose outcome it never
learned while the authority reports nothing outstanding. An empty recovery record is a
statement about the Gateway's records, not about the world, so neither reading is acted on:
the call is named, with its request id, for a person to reconcile in Console.

The recovered outcome goes to the model as a **host-recovery note in the user channel**,
labelled as such. It is not forged into an assistant tool call the model never made, and not
disguised as a message from the user. The model reads what ran, sees that the collecting
request executed nothing, and decides again.

The authority may also hand an earlier outcome back in answer to a request the model itself
made. That request **did not run**, and the result it gets says so: `requestExecuted: false`,
the name of the call the outcome belongs to, and that outcome kept whole beside it as data.
An earlier call's `accepted: true` is never allowed to read as this call's acceptance. The
rest of that turn's proposals are not carried either — they were chosen before the model
knew any of this — and the model decides again with the outcome in hand.

An authoritative refusal is never replayed by the host: the Board judged the step, and
resending it with the refusal's own words attached would be this client deciding on the
model's behalf. Local UI shows the unresolved call, its state and its tool beside the Cases
in focus.

Inside `ApplyBatch`, a step of reasoning takes one of five shapes:

| Shape | What it puts on the Board |
| --- | --- |
| `assert_fact` | A material fact, with the source it came from |
| `add_axiom` | A rule the Board may derive with |
| `declare_hypothesis` | A claim under test; the Board reports its status |
| `record_result` | A conclusion, with references to the evidence it rests on |
| `retract_node` / `revise_fact` | Withdraw or correct one of your own assertions |

Explanation and argument stay in the model's reply. They are not Board material.

Every tool result carries one bounded **Board View**, computed by the Board for the
operation the model just took and filtered to what the Agent Profile permits: the
acceptance roots and their status, the open gaps, the nodes, and the available Actions
with their parameters. It is not the complete Board history, and it carries no receipt,
permission, program, Connection or commercial records. Reading it costs nothing extra —
it arrives with the answer to the step. When the model needs a *current* view rather than
the one it last saw, it calls `QueryBoard`; the host never issues a read of its own, and
in particular never refreshes an observation immediately before a write.

Anthropic Messages and OpenAI Chat Completions tool use are both spoken natively. An
endpoint that rejects tool definitions gets the same six schemas described in the system
prompt and answers with one JSON object; set `RULITH_MODEL_TOOLS=emulated` to select that
transport up front. It is a transport, not a second surface: the names, the schemas and
the refusals are identical.

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
grants the Agent permission to use a Tool.

A built-in Tool and one declared in the Tool Manifest have the same standing. Both are
resolved by the same code, pinned by the same digest over their definition, and
advertised in the same descriptor — `id`, `digest`, `sourceTypes`, `kind` (`read`,
`write`, or `run`), `params`, and `returns` — so a host can synthesize a governed Action
for either without a Capability having declared it first. The Worker advertises every
Tool it has and authorizes none of them: a Tool is usable only while it is locked on this
Connection in Console, and one that is not locked simply never receives work. The startup
banner prints the same list the first poll sends, each Tool with its kind, so the line in
the terminal and the locks in Console are two views of one thing. A manifest entry may
state `kind`, `params`, and `returns` itself; left out, `kind` is derived from the
adapter and falls to `write` wherever the entry has not said otherwise. An entry that
names a built-in implementation states none of the three — that contract is fixed, and
restating it is refused when the manifest is read rather than quietly ignored.

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
with an allowed root directory. Presenting a Tool never authorizes it: a Tool is usable only
while it is locked on this Connection in Console.

The Worker polls outbound, resolves the Adapter locally, executes it, and reports a receipt
before polling again. Rulith checks that every Tool it uses is locked on the Agent-owned
Connection, and dispatches an Action only when its Tool accepts the Cloud-injected Source
type. A model request cannot grant itself a Tool, Source, credential, Adapter, or
verification authority.

### The Worker hop: an instance, a generation, a lease

A Worker process has a **random instance identity** minted at startup — never a configured
label, because a label is shared by two processes started from one copied Connection secret
and is inherited by a restart from the instance it replaced, which is exactly the identity a
fence exists to retire.

Nothing happens without a **confirmed active lease**. Without one this Worker claims no
work, executes no Tool and changes nothing about what it advertises; with one, every hop
states the instance and the fencing generation it holds, in the two protected headers and in
the operation. A long execution keeps its lease alive with `RenewLease`, which renews only
the lease already held and never acquires one — a refused or unreachable renewal stops this
instance taking further work rather than assuming it still holds anything. Shutdown releases
the lease, which says this instance is finished and never that an invocation already
dispatched did not happen.

A dispatched action row is checked against the contract's own **closed shape** before anything
is claimed: every mandatory field present, each of the stated kind, and nothing else carried
at all — a field nobody reads is a field nobody checks. It states each thing **once**: `work`
is the invocation and `tool` is the Action, and the request vector is built from those and from
nothing else. A row that also carried `invocationId`, `actionId` or a structured `grant` beside
the signed token would state one value under two names, and two readers preferring different
names would digest two different requests while each believed it had read the row. The row's
`connectionId` travels for comparison and is never adopted — it is checked against the
Connection this process authenticated as, because a row must not be able to tell a Worker
whose line it is on — and `toolDigest` is mandatory, so the local pin comparison cannot be
skipped by omitting it.

**Source-first.** A Tool declaration states which Source *types* it accepts and pins no
instance — the retired `toolSpec.source` made the governed Source record a decoration, because
what actually ran was chosen when the package was written rather than when the Action was
governed. The invocation names the instance it wants in its own `source` argument, and that
name must be the record the row was dispatched against *and* an authorized Source on this
Connection, of an accepted type. The three ways that can fail have three names —
`source_free_has_source`, `source_selection_required`, `source_type_mismatch` — because they
send an operator to three different places. An empty `sourceTypes` is a Source-free
declaration: nothing is resolved, no credential, root or endpoint is manufactured, and the
invocation may not name a Source. Such a Tool runs under the Tool authorization it already
has — a local computation needs nothing more — and gets no Source, so it also attests no
Source-backed business facts. An Adapter that needs a *located* Source still cannot run: the
database, HTTP, MCP and workspace Adapters are each refused a Source-free dispatch while the
Tool is compiled, which is before anything is claimed. There is no environment default behind
them — a database Tool runs against the DSN of the Source the invocation selected, held in
this machine's own secret store, and a connection string sitting in the host's own
environment is not a Source and is never borrowed as one. `source` is
therefore a reserved argument name: a Tool that declared it as a parameter would publish a
slot that can never be filled, so the declaration is refused where the operator can see it.
The selector is only ever *read* out of the arguments: `args` is one of the strings the
grant's digest covers, so it is stripped from what the Adapter sees and never rewritten.

Every dispatched action carries a **signed execution grant**, and it is decoded and verified
before anything is claimed — a claim is a dispatch recorded on the Board, so the licence is
matched first. The signature is checked with the Connection key this Worker already holds;
then every field the grant carries is compared against something the Worker knows
independently: its own instance, the generation of the lease it holds, its Connection, this
invocation's board / action / Tool contract / Source record, the Adapter pin of the local Tool
that would run, and the digest of the exact bytes it was served. A valid signature over
somebody else's document is still somebody else's document. A work item whose grant cannot be
read or matched is not claimed and not run.

When a lease is lost while work is in flight, two things follow. The rest of the batch is
**left unclaimed** — it stays dispatchable and comes back to whichever instance holds the line,
rather than being taken by one that does not. And the work that did run reports under the
identity it was **dispatched under**, not the live one: a receipt that quietly dropped its
generation would be this Worker awarding itself a permission it no longer has. Whether a late
receipt may land is the Gateway's decision, and it cannot decide on a field that was not sent.
A receipt retry is the same bytes and the same identity; nothing is ever re-executed.

**Poll** is the whole inbox surface and the only verb that takes the line. It states the
instance, the Tool Manifest, and — only once a lease is held — the generation that lease
carries; the acquiring poll of a freshly started process states none, because it has never
been given one. Resending that startup request keeps the same instance identity, so a lost
answer costs no generation. A refused poll means what this process believes about its own
lease is no longer true, so it drops the lease and takes the line again the way it did at
startup; restating a refused generation would be refused for the same reason forever.

The **Tool Manifest travels on every poll**, so a Worker re-states what it has whenever it
reconnects and there is no separate registration call to get out of step with. Each entry
states its effect class, its parameter table and its result-fact mapping. Reporting a field
is not the same as filling it: an empty `sourceTypes` declares a Source-free Tool, an empty
`returns` declares a Tool that deliberately attests nothing, and a row with no arguments
lands a bare proposition. None of the three may be refused as if the field were missing —
whether a Tool additionally qualifies for direct use is a separate judgement downstream, and
borrowing it here would refuse a legal report on an availability ground.

`caseId` and `caseRevision` are **gone from the hop**. Case identity is the Gateway's
authenticated envelope against Core, and which Cases an execution advances is the shared
graph's answer computed from real causal reach; a work item that still names one is refused
before the executor runs, because the alternative ordering leaves the world changed, the
receipt refused, and the invocation never dispatched again.

Execution identity is a digest of what was actually requested and reported, computed by the
contract's own canonicalization and checked against its committed vectors. `args`, `target`
and `toolSpec` are the exact strings Core served — reserializing them would make the digest
cover this Worker's rendering rather than the authority's bytes — and a Source-free
execution digests an empty `sourceRecordId` rather than substituting the Connection's name.
A grant naming another instance, an older generation or another request is refused before
the hand moves. `adapterDigest` remains a declaration and configuration identity; it is not
a verified pin of the code that ran.

Object production is **not wired yet**: the reference and permission boundaries are
implemented and tested, and no object bytes leave this machine. Only an explicit granted
off-machine permission from the actual Source record would admit them; a denial and a
missing permission — including the Source-free case, where there is no Source to have
granted anything — are each refused under their own name.

Adapters are a fast way to implement Tools; they are not an Agent-facing concept. For
example:

```json
{
  "format": "rulith-worker-tools/1",
  "tools": {
    "acme.orders.lookup@1": {
      "adapter": "db-query",
      "sourceTypes": ["db"],
      "entry": "SELECT order_id, status FROM orders WHERE order_id={order_id}",
      "params": { "order_id": "number" },
      "returns": [{ "predicate": "acme.orders.record", "args": { "order_id": "$order_id", "status": "$status" } }]
    },
    "acme.erp.lookup@1": {
      "adapter": "mcp",
      "sourceTypes": ["mcp"],
      "entry": "orders.lookup"
    }
  }
}
```

A governed Action may declare the typed `order_id` slot and its own result mapping; a Tool
that states `params` and `returns` — the same `[{predicate, args}]` mapping an Action uses,
with each fact argument read from a `$column` of the result row — is one a host can build a
direct Action from without a Capability having declared it. The Worker
compiles database placeholders to driver parameters, never SQL interpolation. MCP
discovery is read-only; it does not grant a generic call surface. Each remote MCP Tool
must still be approved as its own versioned local Tool and governed Action.

### Connect a local MCP server

The Local web page has **Worker tools · manage**, a single inventory for built-ins, manifest tools and selected MCP tools. Inspect contracts, edit native tool definitions or manage MCP services; built-in workspace availability uses its existing mode setting. Under **Add tools**, search the official MCP Registry, connect an existing service, declare a tool, or use a template such as Filesystem. MCP setup discovers and selects tools, then exports a credential-free Source definition for Console authorization. See [Local Worker tool management](docs/local-mcp-setup.md) for supported formats and boundaries. This batch is pending publication and requires the matching Gateway update.

Rulith Local's Worker is an outbound MCP client. It supports local **stdio** processes
and **Streamable HTTP** endpoints, including initialization, session headers, JSON/SSE
responses, and paginated Tool discovery. The Agent still calls Rulith's single `/mcp`.
Install the complete npm package so the pinned MCP SDK and Worker module are present;
copying only `rulith-worker.mjs` is insufficient.

1. Install and configure the chosen MCP server on the Worker machine. For stdio,
   its executable, arguments, working directory and credentials belong in the local
   Source vault, not in a Capability or model argument. The complete shapes are in
   [the Source vault example](config/rulith-sources.example.json). Keep `type: "mcp"`
   in the local entry even when the Cloud binding will be completed after startup.
2. In Console, establish a Source with that same name and the predicates it may
   attest. Declare its access modes and versioned Tool references. A stdio Source's
   public access address can be a non-secret locator such as `stdio:local-mail`;
   its actual process configuration stays local. HTTP uses its non-secret endpoint.
3. Declare the named remote Tool in the Worker manifest, start `rulith start --role worker`,
   then bind and lock the Source and its required advertised Tools in Console.
   If Local also supplies the model, use `--role agent+worker` instead.
4. Use the existing `rulith.mcp.discover@1` through a governed read Action to inspect
   remote names and schemas. Discovery reads up to 200 Tools across pages and reports
   truncation. It does not install or authorize what it discovers. Tool parameters
   and result mappings must be declared using the current Worker contract.

For a remote Tool named `mail.read` that accepts `message_id` and returns
`structuredContent: {"rows":[{"message_id":"m-1","subject":"Hello"}]}`:

```json
{
  "format": "rulith-worker-tools/1",
  "tools": {
    "acme.mail.read@1": {
      "adapter": "mcp",
      "sourceTypes": ["mcp"],
      "entry": "mail.read",
      "kind": "read",
      "params": { "message_id": "string" },
      "returns": [{ "predicate": "acme.mail.message", "args": {
        "message_id": "$message_id", "subject": "$subject"
      } }]
    }
  }
}
```

The adapter prefers `structuredContent`; text-only results remain supported. Declared
fact mappings require the existing `{rows:[...]}` shape. A returned `isError: true`
is a tool failure. Lost responses, exceeded result budgets, and unreadable required
fact output after dispatch preserve an unknown outcome; the Worker does not retry
the external action or manufacture a failed execution receipt.

One session is reused per Source until its configuration changes, the transport fails,
or the Worker stops. Local's normal stop closes owned MCP child processes first. A
stdio server runs with the local user's OS permissions, just like a run adapter; it
is not a sandbox. It inherits basic process environment plus explicitly configured
Source variables, not the Worker's Rulith credentials. No sampling, elicitation or
filesystem-root capability is granted to the remote server. Time and response-byte
limits can be tightened in the Source vault or Tool fence; the smaller limit applies
to the whole operation, including initialization and discovery pages.

Protocol interoperability tests use the official SDK server (`npm test`), including
stateful JSON/SSE HTTP and real stdio processes. A separate Java integration fixture
verifies Local → Worker → MCP → Source-backed shared Board facts. These establish
transport and evidence integration; a provider-specific mailbox still needs its own
authorization, Tool mapping and business acceptance test.

### What a `run` Adapter's process environment contains

A `run` Adapter is an ordinary local program started with the Worker user's rights.
**This is not a sandbox.** What the Worker controls is the environment it is handed, in
two modes:

- **By default, a deny-list of known credential patterns.** Removed are this runtime's
  own credentials (Connection key, Agent token, model and reviewer keys, database DSN)
  and the common credential name families a developer machine tends to carry: `*_API_KEY`,
  `*_TOKEN`, anything containing `SECRET` or `PASSWORD`, `*_PRIVATE_KEY`, `DATABASE_URL`
  and `*_DB_URL`, `*_DSN`, and everything under `AWS_`, `AZURE_`, `GOOGLE_`, `ANTHROPIC_`
  and `OPENAI_`. `PATH`, `HOME`, `TEMP`, `SystemRoot`, locale and proxy settings pass
  through. Names outside those families still reach the Adapter — a deny-list only covers
  what it names.
- **Per Tool, an allow-list, when the Tool declares one.** Add `env` to a `run` entry and
  the child receives the `PATH` / `HOME` / `TEMP` / `SystemRoot`-class basics plus exactly
  the names listed, and nothing else:

```json
{
  "acme.report.publish@1": {
    "adapter": "run",
    "sourceTypes": ["file"],
    "entry": "adapters/publish-report.mjs",
    "env": { "pass": ["ACME_REGION"] }
  }
}
```

`"pass": []` passes only the basics. A listed name is passed even when a deny-list family
would otherwise strip it; the Tool Manifest is local, operator-written configuration, and
this is how one specific variable is handed over deliberately. Matching ignores case, so
the fence holds on Windows, where `Rulith_Token` and `RULITH_TOKEN` are one variable.
`env` on any other Adapter is refused when the manifest is read rather than ignored. The
field is part of the Tool digest, so adding it changes what the Cloud pin authorizes.

- **The `RULITH_` namespace, always.** Every ambient variable whose name starts with
  `RULITH_` is stripped before an Adapter starts — on the deny path and against an
  `env.pass` allow-list alike — because that namespace is the runtime's to fill, not the
  environment's. What an Adapter receives from it is exactly what the work item decides:
  `RULITH_INVOCATION_ID` from the trusted work item, and `RULITH_SOURCE_ACCESS` and
  `RULITH_SOURCE_TYPE` from the Source this invocation selected. A Source-free execution
  is given neither of the last two, so an Adapter that needs a location finds nothing
  rather than something left over. An Adapter is told no Case: one execution may be
  reached by several Cases, and which ones is the shared graph's answer rather than
  something this hop could state.

An Adapter's own configuration lives outside that namespace — `ACME_REGION` is what
`env.pass` is for. The example adapters under `examples/verified-calculation/` read the
Source root they are handed and nothing else: they have no path override and no default
directory, so an Adapter granted no Source, or one of the wrong type, refuses instead of
reading a file of its own choosing.

## Rulith Local

Copy `config/rulith-local.example.json` outside the repository, select `agent`,
`worker`, or both roles, fill in the local values, and run:

```powershell
$env:RULITH_LOCAL_CONFIG = 'C:\path\to\rulith-local.json'
npm start
```

Rulith Local prints one loopback URL containing a random key. Open that exact URL: the
key gates every route, including the page itself, and the page reads it from its own
address rather than carrying an embedded copy. The Agent is conversational first:
greetings and ordinary discussion create no Case and perform no Board operation.
Rulith is an optional tool the model selects when work benefits from persistent state,
rules, evidence, external Actions, verification, or an auditable conclusion. One tool
call advances at most one Case step; an unfinished Case guides later decisions but never
forces another model turn.

In Agent+Worker mode, the Local UI uses a familiar Agent-workbench shape: conversation
activity on the left, dialogue and selected governed execution in the center, a composer
at the bottom, and the active Rulith Case, frontier, Worker activity, evidence, and
receipts on the right. Agent and Worker modes use role-specific projections of the same
UI and event contract.

The browser UI is a read-only runtime observer. It shows the configured Agent identity,
credential presence, model profile, Worker Connection, Tool and Source file locations,
process health, Cases, Trace, Frontier, evidence, and receipts. It never signs in to a
Cloud account, selects an Agent, edits credentials, or changes Worker and Source wiring.

The deployment configuration owns the model endpoint and key, Agent runtime,
Worker Connection key, Source credentials, Tool adapters, workspace roots, local Tool
ceiling, and process policy. Cloud remains authoritative for
account and Agent identity, Capability and Constitution Releases, Connection and exact
Tool authorization, Source attestation scope, Case acceptance, Terminal Receipts,
Entitlement, and Billing. Local observes those Cloud decisions but never keeps a second
governance ledger.

The Local UI is a view of the runtime, not a board or authority service. A remote
Worker remains independently deployed and outbound-only; its authoritative activity
appears through the Cloud Connection and receipts rather than direct Local control.

## Five-minute verified file workflow

The smallest end-to-end example reads trusted numbers from one local JSON file,
derives the exact total on the board, writes another JSON file, reads it back, and
only then accepts the result.

```powershell
cd examples/verified-calculation
node setup.mjs ./rulith-demo
```

Follow the generated paths and the instructions in
[`examples/verified-calculation/README.md`](examples/verified-calculation/README.md).
The model never supplies the trusted input values or the calculated output values.

## Security model

- Agent tokens and model keys belong to the Agent Runtime process.
- Rulith Local stores no Cloud account session. Runtime identity comes only from the configured Agent-scoped credential.
- Connection keys and source credentials belong to the Worker machine.
- Built-in workspace Tools are fenced to the configured Source root, bounded in size and
  result count, and expose neither delete nor arbitrary shell execution.
- `run` tools execute relative adapters beneath the Worker root with the current Node
  runtime; packages cannot select arbitrary commands or escape that directory. The
  Adapter process receives a deny-list of known credential patterns by default, and an
  allow-list per Tool when the Tool declares `env.pass`. This is not a sandbox: an Adapter
  runs with the Worker user's rights. See
  [What a `run` Adapter's process environment contains](#what-a-run-adapters-process-environment-contains).
- HTTP tools are constrained to their declared source or allowlist. Outbound MCP calls
  are bounded by a timeout and a 1 MiB response cap.
- Database tools take their statement from the Tool's own `exec` template. An Action
  argument never supplies or selects SQL text, and a database Tool that declares a
  parameter named `sql` is refused at declaration time. Read tools accept a single
  `SELECT`; every model value is passed through the database driver's parameter array
  rather than interpolated into SQL. Fenced write tools classify and reject unsupported
  or destructive statements unless the declared contract allows them.
- The model can name exactly six tools: `OpenCase`, `ApplyBatch`, `ApplyAction`,
  `CloseCase`, `QueryBoard`, `ReadArtifact`. Anything else is refused locally and never
  reaches Cloud, so injected text in a task, a document, or a tool result cannot spend the
  Agent's credential on verification, Worker receipts, clearance, or package and Board
  governance. Cloud authorization is the second line, not the first. The protected query
  context, the admission block and the request identity are envelope metadata the Gateway
  and this host own; they never appear in the schemas the model is given, and a model turn
  that names one is refused before anything is sent. `ReadArtifact` accepts only a
  reference this service issued — never a URL, a path, or another Agent's identity.
- The Local UI requires its per-run key on every route, including the page itself.
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
