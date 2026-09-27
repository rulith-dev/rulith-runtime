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
3. Wait to bind the Source until the local Worker has reported its Tools.

## Install and prepare locally

Have Node.js and a working model endpoint ready. The model may be local or remote;
remote endpoints require a provider key. The five-minute run assumes those prerequisites.

PowerShell:

```powershell
npm.cmd install --global rulith@0.8.17
node "$(npm.cmd root -g)/rulith/examples/verified-calculation/setup.mjs" ./rulith-demo
rulith start
```

Bash:

```bash
npm install --global rulith@0.8.17
node "$(npm root -g)/rulith/examples/verified-calculation/setup.mjs" ./rulith-demo
rulith start
```

The bundled setup verifies five files without another network download. It creates
`worker-tools.json`, `adapters/`, and `runtime/input.json`, and refuses a non-empty
destination. Adapter paths stay relative to the configured Worker root; the runtime
does not permit a script manifest to escape that root.

Open the printed workbench URL. Sign in, select `verified-calculation`, and complete
its first-use setup. The workbench obtains that Agent's runtime credentials and Worker
Connection. Configure your default model through the account menu, or override it in
this Agent's settings. Keep the Agent and Worker stopped while configuring the tools.

## Register the available Tools, then bind the Source

1. For this new demo Agent, open its gear menu → **Technical details → Files** to find
   the profile directory. Stop Rulith with Ctrl+C in its terminal before editing that
   directory's `local.json`. In the existing `worker.env` object, set only
   `RULITH_WORKER_ROOT` and `RULITH_TOOLS_FILE` to the **Worker root** and **Tool manifest**
   absolute paths printed by setup. Preserve the rest of the profile, including its
   credentials, model and session settings. Do not use an Agent with unrelated tool
   configuration for this demo. On Windows, escape backslashes in JSON or use `/`.
2. Run `rulith start` again, select the same Agent, and click **Start Worker**.
   In Console, open the same Agent's Runtime and confirm its
   Connection advertises the three verified-calculation Tools.
3. Bind `verified-calculation-local` to that Connection. Use the **absolute Source
   location printed by setup**, ending in `rulith-demo/runtime`. Select the three
   matching Tools and lock the binding. This data directory contains neither model
   credentials nor Adapter code.
4. Click **Stop Worker**, then **Start Worker** to load the authorized Source. Click
   **Start Agent** and use the Local composer. The workbench keeps the same profile,
   Connection and conversation throughout; no separate CLI configuration is needed.

The standalone Console setup download prepares the same assets using immutable release
pins. It does not create credentials, install a Capability, or grant access to a Source.

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
