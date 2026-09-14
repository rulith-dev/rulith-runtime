# Verified Calculation

This is the smallest complete Rulith workflow: a local Worker reads a JSON input, the
Board derives an exact total, the Worker writes the result, and an independent read-back
must match before the Case can close. The model coordinates the work; it does not supply
trusted prices or computed totals.

The platform publishes **Verified Calculation 1.0.2** as one free Capability. An Agent
installs it through the ordinary Market. The local client receives only Adapter code and
sample files, not a client-owned recipe. No database reset is needed.

## Prepare the cloud side

1. In Console, create an Agent named `verified-calculation`.
2. Under **Market**, install **Verified Calculation** to that Agent. It appears as one
   installed Capability with four inspectable sections: Vocabulary, Rules, Actions and
   Sources, plus its `verified_calculation` Case Type.
3. Under **Agent → Runtime**, create the Agent MCP token and one Worker Connection named
   `verified-calc-worker`. Copy the token, Connection ID and Connection key when shown.
   Wait to bind the Source until the Worker has reported its Tools.

## Install and prepare locally

Have Node.js and a working model endpoint ready. The model may be local or remote;
remote endpoints require a provider key. The five-minute run assumes those prerequisites.

PowerShell:

```powershell
npm.cmd install --global rulith@0.7.1
node "$(npm.cmd root -g)/rulith/examples/verified-calculation/setup.mjs" ./rulith-demo
$env:RULITH_LOCAL_CONFIG="$PWD/rulith-demo/rulith-local.json"
```

Bash:

```bash
npm install --global rulith@0.7.1
node "$(npm root -g)/rulith/examples/verified-calculation/setup.mjs" ./rulith-demo
export RULITH_LOCAL_CONFIG="$PWD/rulith-demo/rulith-local.json"
```

The bundled setup verifies five files without another network download. It creates
`worker-tools.json`, `adapters/`, `runtime/input.json`, and an empty `rulith-local.json`.
It refuses a non-empty destination. The configuration is outside the `runtime/` data
folder, so the file Source need not expose credentials or Adapter code.

Edit `rulith-demo/rulith-local.json` once:

- `agent.env`: fill `RULITH_TOKEN`, your `RULITH_MODEL_URL` and `RULITH_MODEL`; supply
  `RULITH_MODEL_KEY` for a remote endpoint. The generated URL is a loopback example.
- `worker.env`: fill `RULITH_CONNECTION` and `RULITH_CONNECTION_KEY`.
- Keep the generated absolute `RULITH_WORKER_ROOT` and `RULITH_TOOLS_FILE` paths.

The existing standalone Console `setup.mjs` download prepares the same directory by
verifying assets from the immutable Runtime release. Rulith Local still comes from npm.

## Register the available Tools, then bind the Source

Start only the Worker (`rulith.cmd` in PowerShell):

```text
rulith start --role worker
```

Wait for its Tool Manifest to appear under **Agent → Runtime**. Then bind
`verified-calculation-local` to `verified-calc-worker` under **Source bindings**. Use the
**absolute Source location printed by setup**, ending in `rulith-demo/runtime`. Select
the matching required Tools and lock the binding. Use the printed absolute path to make the intended directory unambiguous.

Stop that Worker with Ctrl+C. It reads authorized Sources at startup, so a restart is
required after the first binding. From the same shell and configuration, start both roles:

```text
rulith start --role agent+worker
```

Open the loopback Local UI URL printed by Rulith Local. No separate Agent script,
Worker script, source checkout, or developer test suite is needed.

## Run and verify

In the Local composer, open the **＋** Case options, set **Preferred Case Type if Rulith is used** to `verified_calculation`, and set the business key to
`{"job_id":"calc-001"}`. Send:

```text
Complete a verified_calculation Case for job calc-001 using the installed Capability. Read the configured input, connect its calculation task to the Case goal, write and independently read back the exact total, then close the Case as completed.
```

The sample input contains `batch_id: calc-batch-a`, `job_id: calc-001`, price 129900,
quantity 2 and shipping 3000. The Board uses exact `mul` and `add` rules. The expected
`runtime/output.json` is:

```json
{
  "job_id": "calc-001",
  "subtotal_cents": 259800,
  "total_cents": 262800,
  "status": "completed"
}
```

Completion requires the Board-derived result, the write receipt and the independent
read-back to agree. Check the closed Case and its terminal receipt in Console; a model
answer or output file alone is not acceptance. Model-generated structure must connect
the calculation leaf to the Case root before `CloseCase` can certify it. Actions expose the logical Source and `job_id`; the Capability binds calculated values
from trusted Board premises. The model must not supply internal bound fields.

Keep the sample files synthetic. Ordinary conversation does not implicitly open a Case.
The order-processing example and paid billing are separate acceptance paths.

## Protocol troubleshooting (optional)

The normal run uses the Local composer. Inspect `QueryBoard` for the installed Action
schemas and descriptions. These examples apply to Capability 1.0.2; existing installations
remain pinned until their operator installs the new version.

```json
{"tool":"ApplyAction","input":{"action":"load_calculation_input","args":{"source":"verified-calculation-local"}}}
```

Read `job_id` and `node` from the actual intake result, then open the Case with that key.

```json
{"tool":"OpenCase","input":{"caseType":"verified_calculation","businessKey":{"job_id":"calc-001"}}}
```

Intake attests only raw input. The Agent proposes its goal and links the task to the root
returned by `OpenCase`; the Source does not create task structure. For this sample:

```json
{"tool":"ApplyBatch","input":{"operations":[{"op":"declare_goal","id":"CALC_calc-001","desired":{"predicate":"rulith.verified_calculation.calculation_completed","args":{"job_id":"calc-001"}}},{"op":"assert_fact","predicate":"goal_node","args":{"node":"CALC_calc-001"}},{"op":"assert_fact","predicate":"subgoal_of","args":{"child":"CALC_calc-001","parent":"<the root OpenCase returned>"}},{"op":"assert_fact","predicate":"acceptance","args":{"node":"CALC_calc-001","test":"calc-001"}}]}}
```

The write and read-back expose only `source` and `job_id`. Their declared bindings obtain
the exact input, total and write receipt from trusted Board premises. Missing or ambiguous
bindings are refused before execution; copying model-calculated totals is not a substitute.

```json
{"tool":"ApplyAction","input":{"action":"write_calculation_result","args":{"source":"verified-calculation-local","job_id":"calc-001"},"target":"CALC_calc-001"}}
```

```json
{"tool":"ApplyAction","input":{"action":"verify_calculation_output","args":{"source":"verified-calculation-local","job_id":"calc-001"},"target":"CALC_calc-001"}}
```

```json
{"tool":"CloseCase","input":{"root":"<the root OpenCase returned>","disposition":"completed"}}
```

If closure is refused, inspect the returned gaps and task structure. A model answer,
a derived result or an output file alone does not prove completion. Console must show
a certified completed Case and its immutable receipt, backed by independent read-back.
