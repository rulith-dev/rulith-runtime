# Rulith Local Runtime

This repository contains the local half of Rulith:

It is the canonical source for the downloadable local runtime. Hosted services may
carry release copies of these files, but changes must originate here and retain the
hashes recorded in `artifact-manifest.json`.

| Component | Responsibility | Trust boundary |
| --- | --- | --- |
| Agent Runtime | Drives the model-to-board loop | Model credentials stay in this process |
| Worker | Executes declared tools and reports synchronous receipts | Source credentials stay in the local vault |
| Station | Starts, stops, configures, and observes both processes | Listens on loopback and requires a per-run key |

The runtime is domain-neutral. Workflow vocabulary, criteria, actions, tools,
sources, and constitutional constraints come from the agent's installed capability
packages. The local processes do not contain an order-processing policy or another
hidden business workflow.

## Requirements

- Node.js 20 or newer
- A Rulith Cloud account and Agent token
- A model endpoint compatible with Anthropic Messages or OpenAI Chat Completions
- A Rulith Connection id and key when a workflow needs local execution

Clone the current beta release:

```bash
git clone --branch v0.1.0-beta.1 --depth 1 https://github.com/rulith-dev/rulith-runtime.git
cd rulith-runtime
npm test
```

No build step is required. The three entry points are dependency-free single-file
ES modules. Database tools load the optional `pg` package only when used.

## Agent Runtime

```powershell
$env:RULITH_TOKEN = '<agent-token>'
$env:RULITH_MODEL_KEY = '<model-key>'
$env:RULITH_MODEL = '<model-id>'
$env:RULITH_MODEL_URL = 'https://your-model-endpoint/v1/chat/completions'
node agent/rulith-agent.mjs --agent default --ui
```

`--ui` opens the loopback-only timeline at `http://127.0.0.1:7788`. If that port is
already in use, set `RULITH_UI_PORT` to another local port. Run
`node agent/rulith-agent.mjs --help` to inspect options without configuring credentials.

The Agent Runtime sends board commands to Rulith Cloud and model requests directly
to the configured model endpoint. It does not upload the model key to Rulith.

## Worker

Tool and Source packages installed in Console define names, arguments, result mappings,
attestation scope, safety fences, and non-secret adapter locations. A `run` package may
select only a relative adapter already installed under the Worker root; it cannot send a
command, an absolute path, or a shell program. Local configuration is optional and is
reserved for credentials or deployment-specific endpoint overrides.

For a package that needs no private credential, run:

```powershell
$env:RULITH_CHANNEL = '<connection-id>'
$env:RULITH_CHANNEL_KEY = '<connection-key>'
node worker/rulith-worker.mjs
```

The Worker polls outbound, claims only work whose package selects a supported and locally
present adapter, executes it, and reports a receipt before polling again. A model
request cannot grant itself a tool, a source, a credential, or verification authority.

## Station

Copy `config/rulith-station.example.json` outside the repository, fill in the local
values, and run:

```powershell
$env:RULITH_STATION_CONFIG = 'C:\path\to\rulith-station.json'
node station/rulith-station.mjs
```

Station prints a loopback URL containing a random key. It is a local process host and
timeline, not a board and not an authority service.

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
- `run` tools execute relative adapters beneath the Worker root with the current Node
  runtime; packages cannot select arbitrary commands or escape that directory.
- HTTP tools are constrained to their declared source or allowlist.
- Database read tools accept a single `SELECT`; fenced write tools classify and
  reject unsupported or destructive statements unless the declared contract allows them.
- Submitted work is not self-verification. Acceptance remains a board and policy decision.

See [`SECURITY.md`](SECURITY.md) for reporting and deployment guidance.

## Project status

The runtime is beta software. Protocol compatibility is versioned, but command-line
flags and the Station UI may still change before 1.0.

The Station UI and primary onboarding path are English. Runtime-facing diagnostics
must be English; internal source comments may use another language.

Please use the [setup question template](https://github.com/rulith-dev/rulith-runtime/issues/new?template=question.yml)
for workflow design questions and the other issue templates for reproducible defects and feedback.

## License

Apache-2.0. The license covers the code in this repository; it does not grant rights
to the hosted Rulith Cloud service or the Rulith trademarks.
