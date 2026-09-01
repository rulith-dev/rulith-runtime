# Verified Calculation

This is the smallest complete Rulith workflow. A local Worker reads one JSON input,
the board derives an exact result, and the Worker writes and reads back another JSON
file. The model coordinates the work but never supplies trusted input values or
calculated output values.

## What this proves

1. `load_calculation_input` is a trusted local source adapter. It emits raw input and
   a task seed, but never calculates a result.
2. The `calculate_total` rule uses the board's exact-or-fail `mul` and `add` builtins.
3. `write_calculation_result` receives its parameters from matching trusted input and
   the derived result. The model calls it with only the target leaf.
4. The writer independently checks consistency, writes through a temporary file, and
   reads the file back before returning success; that synchronous receipt applies the
   board-local `output_written` effect.
5. A separate read-only verifier then checks the persisted file against the exact
   board claim and attests `output_record`. Acceptance requires the derived result,
   the write receipt, and this independent read-back to agree exactly.

## Fastest public setup

Create an Agent named `verified-calculation` in Console. Create one Worker Connection named
`verified-calc-worker` for that Agent and copy its public channel id and one-time key. Open
**Capabilities → Capability market**, search for `Verified Calculation`, select the Agent,
and install the **Verified Calculation** Capability once. It appears as one market item and one
installed Capability, with four inspectable sections: Vocabulary, Rules, Actions, and Sources.
Internally the protocol records program and source packages, but that is not a user
installation ritual and there is no starter-only installer. After installation, open
**Agent → Configuration → Data sources**
and bind `verified-calculation-local` to `verified-calc-worker`. This deployment
binding belongs to the Agent and is deliberately absent from the reusable Source package.
Governance owns the installed recipe and binding; the local Agent and Worker cannot replace
either. Then run:

```powershell
Invoke-WebRequest https://console.rulith.ai/examples/verified-calculation/setup.mjs -OutFile verified-calculation-setup.mjs
node verified-calculation-setup.mjs
cd rulith-verified-calculation
```

The setup program downloads `worker-tools.json`, the local Adapters, and sample data.
It does not request or store your Agent token, model key,
Connection key, or Agent configuration.

## Prepare from this source checkout

Install the example Capability in Console first, then prepare the local Tool Manifest and Adapters:

```powershell
cd examples/verified-calculation
node prepare-runtime.mjs
```

Configure Rulith Local in Agent+Worker mode. The business-key values
name this Case; Cloud computes the digest and pins it before opening:

```text
agent.env.RULITH_AGENT: verified-calculation
```

Configure the Worker with its Connection credentials and local Adapter Manifest. The governed
Actions name versioned Tools and Sources; the manifest is the Worker-local binding
from those Tool ids to fixed Adapters. It is not a second workflow recipe:

```text
RULITH_CONNECTION=<connection-id>
RULITH_CONNECTION_KEY=<connection-key>
RULITH_TOOLS_FILE=<this-directory>/runtime/worker-tools.json
RULITH_WORKER_ROOT=<this-directory>/runtime
```

If another Rulith Local configuration already works on this machine, derive a separate config
without changing the existing one:

```powershell
node prepare-local.mjs D:\path\to\working\rulith-local.json
$env:RULITH_LOCAL_CONFIG="$PWD\runtime\rulith-local.json"
$env:RULITH_LOCAL_PORT="7791"
node ..\..\local\rulith-local.mjs start --role agent+worker
```

`prepare-local.mjs` copies credential values only into the ignored local runtime
directory and never prints them.

Open the printed Local UI, then submit:

```text
Read the configured calculation input, calculate the exact total, and write the verified result.
```

The first model action should be:

```json
{"kind":"ApplyAction","action":"load_calculation_input"}
```

After the board derives `calculation_result`, the write call should contain no business
arguments:

```json
{"kind":"ApplyAction","action":"write_calculation_result","target":"CALC_calc-001"}
```

The final read-back uses the same board-bound target:

```json
{"kind":"ApplyAction","action":"verify_calculation_output","target":"CALC_calc-001"}
```

The completed case must contain an `output_written` action effect and an attested
`output_record` matching the derived result. `runtime/output.json` must contain the same
values. A successful write alone therefore cannot certify the case.
