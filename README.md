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

The Agent's governed Actions name versioned Tools and Sources. The Worker Tool Manifest
is local deployment configuration: it maps a Tool id to an Adapter (`http`, `run`,
`db-query`, `db-exec-fenced`, or `mcp`), a Source, and an entry. It is not installed as
a Capability and is never uploaded to the board. A `run` entry must be a relative file
beneath the Worker root; it cannot select an arbitrary command, absolute path, or shell.
Credentials remain in the local source vault.

For a package that needs no private credential, run:

```powershell
$env:RULITH_CHANNEL = '<connection-id>'
$env:RULITH_CHANNEL_KEY = '<connection-key>'
$env:RULITH_TOOLS_FILE = 'C:\path\to\worker-tools.json'
node worker/rulith-worker.mjs
```

The Worker polls outbound and presents only Tool id, digest, and Source. Rulith pins that
manifest to the Agent-owned Connection and dispatches an Action only when its Tool and
Source match the pin. The Worker resolves the Adapter locally, executes it, and reports a
receipt before polling again. A model request cannot grant itself a Tool, Source,
credential, Adapter, or verification authority.

Adapters are a fast way to implement Tools; they are not an Agent-facing concept. For
example:

```json
{
  "format": "rulith-worker-tools/1",
  "tools": {
    "acme.read_report@1": {
      "adapter": "run",
      "source": "reports",
      "entry": "adapters/read-report.mjs"
    }
  }
}
```

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
