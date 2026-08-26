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

Create an Agent named `verified-calculation` in Console. Create a pull Connection named
`local-worker` for that Agent and copy its public channel id and one-time key. Then open
the Agent's **Configuration** tab and install the Verified Calculation starter with that
Connection name. The capability recipe is governance-owned; the local REPL never
installs it. Then run:

```powershell
Invoke-WebRequest https://console.rulith.com/examples/verified-calculation/setup.mjs -OutFile verified-calculation-setup.mjs
node verified-calculation-setup.mjs
cd rulith-verified-calculation
```

The setup program downloads the public REPL and Worker plus the local adapters and sample
data. It does not request or store your Agent token, model key, Connection key, or Agent
configuration.

## Prepare from this source checkout

Install the example configuration in Console first, then prepare only the local adapters:

```powershell
cd examples/verified-calculation
node prepare-runtime.mjs
```

Configure the REPL directly or through Station:

```text
args: --agent verified-calculation --ui --case-boards
RULITH_CASE_BOARDS=on
```

Configure the Worker while preserving its Connection credentials:

```text
RULITH_TOOLS_FILE=<runtime>/rulith-tools.json
RULITH_CALC_INPUT=<runtime>/input.json
RULITH_CALC_OUTPUT=<runtime>/output.json
```

If another Station already works on this machine, derive a separate local config
without changing the existing one:

```powershell
node prepare-station.mjs D:\path\to\working\rulith-station.json
$env:RULITH_STATION_CONFIG="$PWD\runtime\rulith-station.json"
$env:RULITH_STATION_PORT="7791"
$env:RULITH_STATION_KEY="st-calculation-demo"
node ..\..\station\rulith-station.mjs
```

`prepare-station.mjs` copies credential values only into the ignored local runtime
directory and never prints them.

Start REPL and Worker, then submit:

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

The completed case must contain an `output_written` action effect and an attested
`output_record` matching the derived result. `runtime/output.json` must contain the same
values. A successful write alone therefore cannot certify the case.
