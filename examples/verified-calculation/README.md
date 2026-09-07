# Verified Calculation

This is the smallest complete Rulith workflow. A local Worker reads one JSON input,
the board derives an exact result, and the Worker writes and reads back another JSON
file. The model coordinates the work but never supplies trusted input values or
calculated output values.

## What this proves

1. `load_calculation_input` is a trusted local source adapter. It emits raw input and a
   task seed — rooted at the `batch_id` the input file states, never at an identity taken
   from its environment — but never calculates a result.
2. The `calculate_total` rule uses the board's exact-or-fail `mul` and `add` builtins.
3. `write_calculation_result` states values the board already holds, and the board checks
   every one of them against a fact grounded `attested` or stronger before an invocation
   is minted. The model reads them off the Board View; it computes none of them.
4. The writer independently checks consistency, writes through a temporary file, and
   reads the file back before returning success; that synchronous receipt applies the
   board-local `output_written` effect.
5. A separate read-only verifier then checks the persisted file against the exact
   board claim and attests `output_record`. Acceptance requires the derived result,
   the write receipt, and this independent read-back to agree exactly.

## Fastest public setup

**The order below is the only one that works, and each step is a precondition of the next.**
Binding a Source is not a step you can do early: Console refuses to lock one until the Worker
that would carry its Tools has reported them, and the Worker only learns which Sources it may
run against when it starts. So the Worker is started twice — once to be seen, once to see.

1. **Agent and Connection.** Create an Agent named `verified-calculation` in Console. Create
   one Worker Connection named `verified-calc-worker` for it, and copy the Connection id and
   the one-time key.
2. **Install the Capability.** Open **Capabilities → Capability market**, search for
   `Verified Calculation`, select the Agent, and install it once. It appears as one market item
   and one installed Capability with four inspectable sections: Vocabulary, Rules, Actions and
   Sources. Installing also creates the Source record `verified-calculation-local` — unbound.
   Governance owns the installed recipe and its binding; the local Agent and Worker cannot
   replace either.
3. **Prepare the local workspace.**

   ```powershell
   Invoke-WebRequest https://console.rulith.ai/examples/verified-calculation/setup.mjs -OutFile verified-calculation-setup.mjs
   node verified-calculation-setup.mjs
   cd rulith-verified-calculation
   ```

   The setup program downloads `worker-tools.json`, the local Adapters and the sample data,
   verifying every file against `artifact-manifest.json` before writing anything. It does not
   request or store your Agent token, model key, Connection key, or Agent configuration.
4. **Start the Worker** with its Connection credentials. It polls once and reports the Tools it
   implements. Until it has, step 5 is refused by name:
   `worker_tools_unavailable — The selected Worker has not reported every required Tool for
   Source type file … Start that Worker, then enable the matching Tools and lock again.`
5. **Bind the Source.** Open **Agent → Configuration → Data sources**, bind
   `verified-calculation-local` to `verified-calc-worker`, give it the location of the prepared
   `runtime` directory, and lock it. This deployment binding belongs to the Agent and is
   deliberately absent from the reusable Source package.
6. **Restart the Worker.** It reads its authorized Source table once, at startup, so a Source
   bound while it was already running is refused at execution time with
   `source_type_mismatch: Source "verified-calculation-local" is not an authorized Source on
   this Connection` until the process is restarted. This is a real constraint of the current
   Worker, not a workaround: after the restart nothing else has to be repeated.

## Prepare from this source checkout

Install the example Capability in Console first, then prepare the local Tool Manifest and Adapters:

```powershell
cd examples/verified-calculation
node prepare-runtime.mjs
```

Configure Rulith Local in Agent+Worker mode with the token created under the
Verified Calculation Agent's Runtime tab. The token itself selects that Agent;
there is no second Agent-name field. Business-key values name the Case, while
Cloud computes the digest and pins it before opening.

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

The model names one of the six tools; `ApplyAction` invokes an Action the Board View lists
as available. Every Action here reads or writes through a **file** Source, so each call
names the bound Source instance in `args.source`. That name is the logical Source — never a
Connection, credential, URL, or local path — and the Action contract itself pins no
instance: it declares only the Source types it accepts, and this deployment bound
`verified-calculation-local` above.

The Case is opened first, and its business key is governance's, not the model's: it is the
`job_id` the operator names (`--business-key '{"job_id":"calc-001"}'`, or the `POST /task`
body). Nothing downstream invents it, and the Worker never states one.

```json
{"tool":"OpenCase","input":{"caseType":"verified_calculation","businessKey":{"job_id":"calc-001"}}}
```

`OpenCase` answers with the Case id and the **root Cloud minted for it**. Keep that root: two
later steps need it. Then intake:

```json
{"tool":"ApplyAction","input":{"action":"load_calculation_input","args":{"source":"verified-calculation-local"}}}
```

Intake reads the configured `input.json` and returns what it found there: the job's raw
fields, and a task seed rooted at the **batch** the file names — `CALC_BATCH_calc-batch-a`,
not this Case. It cannot be otherwise: Case identity is not part of the Worker hop, and one
batch may be read on behalf of several Cases. Which Case this job belongs to is a decision,
and the client makes it with one ordinary structured write:

```json
{"tool":"ApplyBatch","input":{"operations":[{"op":"assert_fact","id":"link_CALC_calc-001","predicate":"subgoal_of","args":{"child":"CALC_calc-001","parent":"<the root OpenCase returned>"}}]}}
```

Skip it and the run still looks healthy — every Action succeeds and
`calculation_completed` is derived — but `CloseCase` answers `case_not_certified`: the
acceptance atom exists and the Case root has no planned work under it. Link the **leaf**,
not the batch: one node may hang under both, and a batch with a single child under the Case
root is a rename rather than a decomposition, which the board's plan gate refuses.

The write call carries the Source **and** the values the board already holds — read
`node`, `job_id`, `unit_price_cents`, `quantity` and `shipping_cents` off `calculation_input`
and `subtotal_cents`/`total_cents` off the derived `calculation_result`. The board re-checks
each one against a fact grounded `attested` or stronger, so a value the model made up is
refused before an invocation is minted:

```json
{"tool":"ApplyAction","input":{"action":"write_calculation_result","args":{"source":"verified-calculation-local","node":"CALC_calc-001","job_id":"calc-001","unit_price_cents":129900,"quantity":2,"shipping_cents":3000,"subtotal_cents":259800,"total_cents":262800},"target":"CALC_calc-001"}}
```

The final read-back uses the same Source and target, with the values `output_written` now
carries:

```json
{"tool":"ApplyAction","input":{"action":"verify_calculation_output","args":{"source":"verified-calculation-local","node":"CALC_calc-001","job_id":"calc-001","subtotal_cents":259800,"total_cents":262800,"status":"completed"},"target":"CALC_calc-001"}}
```

```json
{"tool":"CloseCase","input":{"root":"<the root OpenCase returned>","disposition":"completed"}}
```

The completed case must contain an `output_written` action effect and an attested
`output_record` matching the derived result. `runtime/output.json` must contain the same
values. A successful write alone therefore cannot certify the case, and `CloseCase` returns
a terminal receipt whose acceptance atom and evidence closure name exactly that chain.
