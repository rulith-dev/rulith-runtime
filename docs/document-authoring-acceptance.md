# Document-to-capability acceptance

Run this against the **published** `rulith` package and a dedicated QA Agent. Use
`test/fixtures/authoring-shipping-policy.md`; it is synthetic and may be sent to the
configured model. Do not publish the resulting private draft. Record the npm version,
the selected model, checker version, Case ID and the provider-reported token totals.
Do not put credentials, browser keys or document contents in the evidence record.

Before the browser run, execute `npm run release:verify-published -- <version>` from
the release source tree. It checks the registry tarball and starts an isolated installed
workbench. Its success does **not** prove the account or document workflow below.

1. Start the installed `rulith` workbench, open its printed loopback URL, sign in if
   needed, and select the enabled QA Agent. Verify the account and Agent names before
   configuring its default or per-Agent model. Start the Agent and Worker in the UI.
2. Open **Document assistant**. Prepare the local checker and Source. Verify that the
   selected Agent, Connection, material area and permissions are shown. A preparation
   error must leave a visible retry path and must not claim readiness.
3. Use the conversation's file chooser to attach the fixture. Verify the file name
   appears, then ask for a capability draft from that material. The Agent must ingest
   the material through the configured Source, read the returned Artifact, and use
   the local checker. A file that did not finish attaching must not be silently sent.
4. Inspect the checker result and its immutable Artifact. Record compilation, citation
   and example counts. Confirm cases at 0, 199, 200, 201, negative, fractional and
   missing amounts, plus two independent order IDs. If a question remains, answer it
   and require another check of the corrected draft; a previous passing report does
   not authorize saving a changed proposal.
5. Confirm the matching Case closes as completed and certified. Open **Review checked
   draft** and inspect vocabulary, Case boundary, every rule premise/conclusion,
   source quotation, examples and notes. Save privately only when the exact checked
   proposal has no unresolved questions. Record the saved pack and Case IDs.
6. Close and restart Local, reopen the same Agent and Review. The saved receipt and
   certified Case must still be shown, Save must be disabled, and the private draft
   must be visible in Console. Restart must not replay the earlier task or create a
   second pack. Stop the workbench process started for this run.

For each model call, capture the local `model-usage` event's `inputTokens`,
`outputTokens`, `requestBytes`, `transcriptBytes`, `compactedViews` and
`compactedTranscriptBytes`. Compare the first checker submission and total model
calls to the previous fixture run. A schema rejection, missing source citation or
unexpected token increase is a finding, even if a later retry succeeds.

Exercise the exception states in a separate disposable run: unsupported/oversized
material, unavailable checker, compiled=false, open questions, lost Agent/Worker,
and a refused or interrupted Save. Every state must say whether work ran, keep the
user's input where safe, and offer a concrete retry or recovery action. Do not infer
Case completion from a green local checker alone.

Automated coverage currently includes the real Chromium UI tests in
`test/browser/materials-ui.browser.mjs` and `test/browser/workbench-ui.browser.mjs`,
the real manager/child-process tests in `test/local-manager.test.mjs`, and Worker,
Agent and persistence tests under `test/`. Those browser fixtures use simulated
Gateway responses, so they do not replace this published-account acceptance run.
