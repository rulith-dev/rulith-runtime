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
`compactedTranscriptBytes`. Also record `cachedInputTokens` and
`uncachedInputTokens` when the provider reports a consistent cache breakdown;
null means unknown, not zero. Compare the first checker submission and total model
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

For a real-account browser run, `test/browser/live-document.browser.mjs` drives the
installed npm package's Local UI through Chromium. It is deliberately excluded from
`npm test`: `upload` calls the configured model and `save` writes a private draft.
Set `RULITH_LIVE_RUN=1`, `RULITH_LIVE_AGENT` to a dedicated enabled QA Agent, and
`RULITH_LIVE_STEP` to `inspect`, `prepare`, `upload`, `review`, `save`, or `verify`.
Run the script once per step, in that order, with `RULITH_LIVE_CASE` set to the
certified Case displayed by `review` before `save` and `verify`. `upload` begins a
fresh local conversation transcript. The Agent's Board focus is shared across its
conversations, so this does not remove previously focused Cases from model context;
use a dedicated QA Agent with no old Cases for comparable token measurements. Each invocation
starts the installed workbench, uses its ordinary browser controls, then closes
the browser and workbench, and checks that no owned child was left running.
It never publishes the draft. `RULITH_PLAYWRIGHT_MODULE` must point to an
installed Playwright module unless Playwright resolves from this source tree;
set `RULITH_LIVE_PACKAGE_ROOT` or `RULITH_CHROMIUM_EXECUTABLE` when their
normal installed locations are unavailable.
The browser observer records only numeric `model-usage` diagnostics already sent
to the UI; it does not collect prompts, credentials or material bytes.

The 2026-09-23 run against published `rulith@0.8.11` used this synthetic fixture
and a previously used Agent. The first check failed because `program` was a rule
string; the corrected second check compiled with 9/9 examples and 2/2 citations.
The Agent closed a certified Case; the UI saved its private draft, and a workbench
restart restored the saved Case and disabled a second Save. That turn used 12 model
calls, 207,935 input tokens and 4,351 output tokens. Earlier Cases were still in
focus, so these totals are a diagnostic, **not** a clean before/after token baseline.
The first-draft shape cue needs another clean-Agent trial before claiming an
improvement in first-check pass rate.

A second, source-tree run on 2026-09-23 used a fresh local conversation on the
same Agent. Its Board still focused earlier Cases. The first check submitted a
`program` object but omitted required package fields; the next check still had
schema errors, and the third check passed (9/9 examples, 2/2 citations). The
Agent stopped at its 12-round limit before closing a Case. It used 213,099 input
and 6,857 output tokens. This is evidence of an unresolved first-draft and
completion problem, not evidence that the cue reduced model work. At the time,
the Worker reported the ingested material by Artifact reference and cleared its
accompanying result, so that run never exposed the draft-shape cue to the model.
The subsequent Worker change sends only a fixed format cue beside the reference;
it still needs a clean-Agent, published-package trial before any efficiency claim.

The 0.8.12 published-package run completed a new certified Case through the real
browser and local checker, but the first two checker submissions still failed:
bare predicate IDs in `vocabulary.defines`, then disagreeing Case business-key
fields. The third passed with 9/9 examples and 2/2 citations, and the Agent
closed the Case. This 12-call turn used 237,005 input and 8,372 output tokens.
Three older Cases remained in the same Agent's Board focus, so the totals cannot
be compared as a clean benchmark. No private draft was saved in this run. The
next cue revision targets the two observed mistakes, pending another real test.

For a cheaper first-draft diagnostic before another full browser run, execute
`$env:RULITH_AUTHORING_BENCHMARK='1'; node scripts/authoring-first-draft-benchmark.mjs`
from the Runtime source tree. This is an **opt-in paid model call**: it reads the
signed-in account's local default model credential in memory, sends only the
synthetic fixture and fixed draft-shape cue, makes one Chat Completions request,
and checks the returned `draft_json` with the installed local checker in a
temporary material area. It prints token counts, content hashes and bounded
checker diagnostics, not the credential, prompt, draft or document. It creates
no Gateway task, Case or private draft. Exit 0 requires compiled=true, nonzero
examples and citations all passing, and no open questions. A green result is
only a shape diagnostic; it cannot replace the browser run, Case closure or the
separate fixture boundary review above. This diagnostic supports configured
OpenAI-compatible Chat Completions endpoints; it does not call Anthropic
Messages endpoints.

On 2026-09-23, DeepSeek Flash used 600 input / 1,038 output tokens with the
original cue and failed because rule atom `args` was an array. Adding the
object-argument and package-ID guidance exposed undeclared predicates in one
generation. With explicit built-in names, one generation compiled and verified
all five citations but passed only 4/6 examples (781 input / 1,527 output
tokens); another generation with nearly the same cue also failed compilation.
These are single stochastic samples, not a pass-rate estimate. The fixed cue
now addresses observed syntax mistakes, but first-draft reliability and the
requested boundary coverage remain unproven. The next published-package trial
must use a clean QA Agent and record which examples failed before claiming a
reduction in retries or total token cost.

Two consecutive one-call checks with the compact cue each reported 703 input
tokens. The first had 0 cache hits and failed compilation; the second had 512
cache-hit and 191 cache-miss input tokens, compiled, and passed only 4/6
examples. Output was 1,297 and 1,354 tokens respectively. These provider
counts show why raw input-token totals alone overstate repeated-input cost,
but caching did not solve the first-draft correctness problem. The provider
defines the hit/miss breakdown in its [Chat Completions usage fields](https://api-docs.deepseek.com/api/create-chat-completion/).
This measured cost distinction is specific to this DeepSeek OpenAI-compatible
wire; another provider may report cache usage differently or not at all.
