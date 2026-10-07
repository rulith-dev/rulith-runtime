# Verified Calculation

This is the smallest complete Rulith workflow: a local Worker reads a JSON input, the
Board derives an exact total, the Worker writes the result, and an independent read-back
must match before the Case can close. The model coordinates the work; it does not supply
trusted prices or computed totals.

**Verified Calculation 1.0.3** is a free Capability, available in Market only after the
operator explicitly publishes it on a compatible Core and Gateway. Building or starting
those services does not publish it. An Agent installs the published version through the
ordinary Market; existing installations stay pinned until upgraded. The local client
receives only Adapter code and sample files, not a client-owned recipe. No database reset
is needed. The historical 1.0.2 flow is documented below.

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
npm.cmd install --global rulith@0.12.2
node "$(npm.cmd root -g)/rulith/examples/verified-calculation/setup.mjs" ./rulith-demo
rulith start
```

Bash:

```bash
npm install --global rulith@0.12.2
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
this Agent's settings. Tool configuration reloads the Worker automatically after its current executions drain.

## Register the available Tools, then bind the Source

1. For this new demo Agent, open its gear menu → **Technical details → Files** to find
   the profile directory. Stop Rulith with Ctrl+C in its terminal before editing that
   directory's `local.json`. In the existing `worker.env` object, set only
   `RULITH_WORKER_ROOT` and `RULITH_TOOLS_FILE` to the **Worker root** and **Tool manifest**
   absolute paths printed by setup. Preserve the rest of the profile, including its
   credentials, model and session settings. Do not use an Agent with unrelated tool
   configuration for this demo. On Windows, escape backslashes in JSON or use `/`.
2. Run `rulith start` again, select the same Agent, and enable **Use this environment’s tools and files**.
   In Console, open the same Agent's Runtime and confirm its
   Connection advertises the three verified-calculation Tools.
3. Bind `verified-calculation-local` to that Connection. Keep the Release's default
   location, `runtime`, which the Worker resolves against its root, or use the **absolute
   Source location printed by setup**, ending in `rulith-demo/runtime`: both name the same
   folder. Select the three matching Tools and lock the binding. This data directory
   contains neither model credentials nor Adapter code.
4. The first message in the Local composer starts the Agent automatically. The running Worker loads the
   authorized Source the first time it is given work there, so it needs no restart. That
   holds for a newly bound Source only: when you bind a Source the running Worker already
   knows to another location (for example from a 0.9.1 absolute path to `runtime`), it
   keeps the old location until you turn **Use this environment’s tools and files** off and back on. The workbench keeps the same
   profile, Connection and conversation throughout; no separate CLI configuration is needed.

Steps 1 and 2 can also be done from the workbench in one click, without the setup script.
Open the Agent's setup (**Settings and details → Setup**), go to **Resources**, open
**Prepare the calculation sample**, enter a new, empty directory and click **Prepare calculation sample**. It writes the same files in the same layout as the setup script, points
this Agent's Worker at them, sends the Source folder (`runtime` in that directory) for
authorization unless other resources are selected on that page, and starts the Worker. In
step 3, the Release's default Source location, `runtime`, already names that folder: it is
relative to the Worker root.

The standalone Console setup download prepares the same assets using immutable release
pins. It does not create credentials, install a Capability, or grant access to a Source.

## Run and verify

In the Local composer, keep the preferred Case Type at **Automatic** and the business key
empty. The Agent first reads the trusted input through an `exploration` intake, then opens
`verified_calculation` using the returned `job_id`. Send:

```text
Complete a verified_calculation Case for job calc-001 using the installed Capability. Read the configured input, open the Case with the returned job_id, continue with its returned task node, write and independently read back the exact total, then close the Case as completed.
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
answer or output file alone is not acceptance. In 1.0.3, `OpenCase` plants the calculation
leaf, its direct relationship to the Case root and its `job_id` acceptance test from the
frozen contract. Use the returned Goal handle; the model does not add this structure.
Actions expose the logical Source and `job_id`; the Capability binds calculated values
from trusted Board premises. The model must not supply internal bound fields.

Keep the sample files synthetic. Ordinary conversation does not implicitly open a Case.
The order-processing example and paid billing are separate acceptance paths.

## Protocol troubleshooting (optional)

The normal run uses the Local composer. Inspect `QueryBoard` for the installed Action
schemas and descriptions. These examples apply to Capability 1.0.3; existing installations
remain pinned until their operator installs the new version.

```json
{"tool":"ApplyAction","input":{"action":"load_calculation_input","args":{"source":"verified-calculation-local"}}}
```

Read `job_id` and `node` from the actual intake result, then open the Case with that key.

```json
{"tool":"OpenCase","input":{"caseType":"verified_calculation","businessKey":{"job_id":"calc-001"}}}
```

Use the calculation task node in the Goal returned by `OpenCase` (for this sample,
`CALC_calc-001`). Inspect the returned root:

```json
{"tool":"QueryBoard","input":{"selector":{"roots":["<the root OpenCase returned>"]},"include":["nodes","taskStatus"]}}
```

Initially the leaf has `met:false`, the root has `certified:false`, and `close:"ready"`
means no running work or unresolved gap blocks a close attempt. It does not certify
completion. An early `completed` attempt is refused with `case_acceptance_missing` or
`case_not_certified` and leaves the Case open. No manual structure batch is needed.

The write and read-back expose only `source` and `job_id`. Their declared bindings obtain
the exact input, total and write receipt from trusted Board premises. Missing or ambiguous
bindings are refused before execution; copying model-calculated totals is not a substitute.

```json
{"tool":"ApplyAction","input":{"action":"write_calculation_result","args":{"source":"verified-calculation-local","job_id":"calc-001"},"target":"<the calculation task node OpenCase returned>"}}
```

```json
{"tool":"ApplyAction","input":{"action":"verify_calculation_output","args":{"source":"verified-calculation-local","job_id":"calc-001"},"target":"<the calculation task node OpenCase returned>"}}
```

```json
{"tool":"QueryBoard","input":{"selector":{"roots":["<the root OpenCase returned>"]},"include":["nodes","taskStatus"]}}
```

After the independent read-back agrees, check `met:true` and `certified:true`, then close:

```json
{"tool":"CloseCase","input":{"root":"<the root OpenCase returned>","disposition":"completed"}}
```

If closure is refused, inspect the returned gaps and task structure. A model answer,
a derived result or an output file alone does not prove completion. Console must show
a certified completed Case and its immutable receipt, backed by independent read-back.
Verify that its proof and receipt bind the exact result digests and remain unchanged
after closing the intake Case.

### Capability 1.0.2 (historical)

For an installation still pinned to 1.0.2, load the input and open the business Case with
its returned `job_id` as above. That version attests raw input but does not plant the task
structure. The Agent must declare the calculation Goal, connect it to the root returned
by `OpenCase`, and declare its acceptance test before writing and independently reading
back the result:

```json
{"tool":"ApplyBatch","input":{"operations":[{"op":"declare_goal","id":"CALC_calc-001","desired":{"predicate":"rulith.verified_calculation.calculation_completed","args":{"job_id":"calc-001"}}},{"op":"assert_fact","predicate":"goal_node","args":{"node":"CALC_calc-001"}},{"op":"assert_fact","predicate":"subgoal_of","args":{"child":"CALC_calc-001","parent":"<the root OpenCase returned>"}},{"op":"assert_fact","predicate":"acceptance","args":{"node":"CALC_calc-001","test":"calc-001"}}]}}
```

Use `CALC_calc-001` as the target of the same write and verify Actions, passing only
`job_id` and `source`. Inspect the root and close it as `completed` only after independent
read-back certifies it. This manual batch belongs only to the historical 1.0.2 flow.

## Publishing 1.0.3 (operator only)

See the Core/Gateway [Case task template deployment notes](https://github.com/rulith-dev/rulith-java/blob/main/docs/case-task-template.md).
Deploy the task-template-capable Core first, then the compatible Gateway. After both
services are stable and the owner confirms publication, arrange an offline Gateway
maintenance window: seed needs the identity database's exclusive lock. Run against the
target Gateway configuration and its reserved first-party Publisher owner:

```text
java -Dloader.main=ai.rulith.gateway.example.VerifiedCalculationSeedMain -cp gateway/target/gateway-0.1.0-SNAPSHOT-service.jar org.springframework.boot.loader.launch.PropertiesLauncher <offline Gateway configuration> <first-party Publisher owner> --version 1.0.3
```

Restart the same compatible Gateway, then install or activate 1.0.3 through the ordinary
installation, pending and drain gates. The default seed still publishes 1.0.2; neither
image builds, service startup nor deployment scripts publish the template Release.
Once the template Release is written, preserve compatible readers even before activation.
To roll back after activation, stop new template admissions and use the ordinary program
transition on a compatible build to return to immutable 1.0.2. Keep all history; replacing
only the images with old readers is no longer a safe rollback.
