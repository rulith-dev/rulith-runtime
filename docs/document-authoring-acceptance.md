# Document-to-capability acceptance

Run this against the **published** `rulith` package and a dedicated QA Agent. Use
`test/fixtures/authoring-shipping-policy.md`; it is synthetic and may be sent to the
configured model. Do not publish the resulting private draft. Record the npm version,
the selected model, checker version, Case ID and the provider-reported token totals.
Do not put credentials, browser keys or document contents in the evidence record.

Before the browser run, execute `npm run release:verify-published -- <version>` from
the release source tree. It checks the registry tarball and starts an isolated installed
workbench. Its success does **not** prove the account or document workflow below.
For a release that changes authoring executables or their pins, also run
`npm run release:verify-published -- <version> --full-authoring`. The full mode checks
Java before transfer, downloads both public JARs through the downloader shipped in
that npm version, verifies their complete SHA-256 values, and runs a synthetic
constructor/citation/example CLI probe. It uses no account credential or customer
material and still does not replace the signed-in browser journey.

1. Start the installed `rulith` workbench, open its printed loopback URL, sign in if
   needed, and select the enabled QA Agent. Verify the account and Agent names before
   configuring its default or per-Agent model. Start the Agent and Worker in the UI.
2. Open **Document assistant**. Prepare the local checker and Source. Verify that the
   selected Agent, Connection, material area and permissions are shown. For this synthetic
   remote-model run explicitly allow both local material delivery and remote-model disclosure;
   neither permission is implied by selecting a file. A preparation
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
The workbench browser suite now exercises preparation refusal/retry, private-save
refusal/retry, a committed save whose HTTP reply is lost, and an unresolved save
whose read-back is temporarily unavailable. It checks that a later Review recovers
the receipt without a second UI save.

For a real-account browser run, `test/browser/live-document.browser.mjs` drives the
installed npm package's Local UI through Chromium. It is deliberately excluded from
`npm test`: `upload` calls the configured model and `save` writes a private draft.
For a newly enabled QA Agent, first run `test/browser/live-setup.browser.mjs` with
`RULITH_LIVE_RUN=1` and `RULITH_LIVE_AGENT` set; it refreshes the linked account,
uses the first-use dialog, and pairs the local profile without replacing another key.
Set `RULITH_LIVE_RUN=1`, `RULITH_LIVE_AGENT` to a dedicated enabled QA Agent, and
`RULITH_LIVE_STEP` to `inspect`, `prepare`, `upload`, `review`, `save`, or `verify`.
For a remote model, set `RULITH_LIVE_MATERIAL_DISCLOSURE=remote` only when the
synthetic fixture may be disclosed to that provider. The upload arm refuses to send
the fixture to a remote model without this explicit setting. Preparation retries
the same Source setup while Worker tools and program projection become current;
it does not count a pending projection as readiness.
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

On 2026-09-23 a fresh `Document QA` Agent paired and started through the real
workbench. The synthetic file attached and sent correctly, but both material
permissions had remained false. Preparation had reported a current Source and
program. The first ingest action ran locally, then Artifact registration was
refused as `source_material_denied`; no result receipt or completed Case was
invented. The Agent stopped with the original call unresolved, using two model
calls (19,824 input and 148 output tokens). The old local Worker was stopped;
operator reconciliation is required before another turn on this Agent. The
source-tree preparation guard now rejects this no-delivery configuration before
installation. This run is a failure finding, not a clean first-draft benchmark.

For a cheaper first-draft diagnostic before another full browser run, execute
`$env:RULITH_AUTHORING_BENCHMARK='1'; node scripts/authoring-first-draft-benchmark.mjs`
from the Runtime source tree. This is an **opt-in paid model call**: it reads the
signed-in account's local default model credential in memory, sends only the
synthetic fixture and fixed draft-shape cue, makes one Chat Completions request,
and passes the returned `construction_json` through the current deterministic
`construct_draft@3` Tool and checker in a
temporary material area. It prints token counts, content hashes and bounded
checker diagnostics, not the credential, prompt, draft or document. It creates
no Gateway task, Case or private draft. Exit 0 requires compiled=true, nonzero
examples and citations all passing, no open questions, and an independent
12-example boundary check (including a fractional amount above the free threshold).
A green result is
only a shape diagnostic; it cannot replace the browser run, Case closure or the
separate fixture boundary review above. Invalid-input examples only assert the
absence of a fee; a caller-visible input-error result remains unverified even
when `passed` is true. This diagnostic supports configured
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

On 2026-09-25 the benchmark itself was found stale: it had paired the v3
constructor cue with the old `check_draft@2` argument and could reject a correct
construction before exercising the current Tool. The diagnostic now submits the
synthetic material under a real local Agent binding, preflights the Java checker
before paying for a model call, invokes `construct_draft@3`, and separately audits
its expanded draft. The old-shape rejection was a harness failure, not a product
first-draft measurement. With a matching constructor cue, three independent
DeepSeek Flash samples compiled but all three produced fees for invalid negative
or fractional amounts. The subsequent generic integer-guard cue yielded one
sample passing eleven independent fee examples, but only one of its two output
rules had the required guard; two other samples failed construction or compilation.
After a twelfth held-out example was added and the pin shape clarified, one of
three samples passed its own checks, all 12 independent examples and both rule
guards; the other two were refused for unknown pin aliases. A later alias/pin
wording change still produced a constructor refusal in one single-call diagnostic.
These small, nonidentical cue
samples establish remaining first-draft instability, not a pass-rate improvement
or a complete document-to-release workflow.
The candidate cue edits were not adopted. Repeating three one-call samples with
the unchanged production cue (`sha256:20bce3b20192fae8c3d74a0f2e8f5b7b614ebe2f5a0d4b783ef6f9e96cfe0147`)
and the corrected current constructor path gave 0/3 diagnostic passes: two
constructor refusals at `program.predicates[].args`, then one compiled proposal
whose own examples passed 4/6 and independent fee examples passed 6/12. Each
request used 694 input tokens and 1,260–1,488 output tokens. This is the
comparable synthetic first-call baseline; it does not exercise the browser,
Case closure, private save, visible input-error result or capability adoption.

The Worker now adds fixed, source-independent repair advice when the constructor
rejects a predicate field-name array or a local alias. It names the required
shapes without echoing the submitted names or document. Two opt-in, two-call
DeepSeek Flash diagnostics still ended in failure. In both, constructor feedback
let the second submission compile, but the independent fee audit passed only
8/12 and 6/12 respectively, and neither proposal guarded its output rules.
The second run exercised the final field-array advice: first call failed on
three `program.predicates[].args` declarations; the next compiled, passed
4/6 self-selected examples and 6/12 held-out boundaries. Cumulative provider
usage was 3,263 input and 3,347 output tokens. These small stochastic runs
demonstrate a usable format-repair path, not business correctness, lower total
cost, a visible input-error result or an automatic product retry.

The next isolated one-call diagnostic exposed a concrete chain of first-check
failures on the same synthetic shipping document: an invalid Case Type,
unbound conclusion variables, then output rules that still inferred a fee for
negative or fractional input despite passing the other examples. A candidate
generic cue stated the Case Type and alias identifier shapes, required
positive premise bindings and explicit validity guards in every affected
output rule, and required a questions array even when it is empty. The
benchmark now reports bounded failed-example labels and missing/unexpected
counts without saving or printing the generated draft.

With that cue (SHA-256 `bfb6cb94b762e3141018cdc50bae8a94940c2b4fc7b1ab5d120d53a4fef285f8`),
three consecutive DeepSeek Flash one-call diagnostics compiled and passed all
their own examples and citations: 6/6 and 4/4, 6/6 and 8/8, then 7/7 and 6/6.
Each used 892 reported input tokens; cache-miss input was 380, 252 and 252,
and output was 1,575, 1,852 and 1,901 tokens. These are three stochastic
samples of one synthetic document, not a general first-draft pass-rate or a
paired cost comparison. The checker verifies only the model's chosen examples;
the specified boundary cases and two independent order IDs still need a
separate audit. The published-package browser run on a clean Agent remains
required before claiming that Local now saves a correct private draft in fewer
rounds or tokens.

The first independent audit ran eight checker examples it built independently of
the model's selected examples: zero, 199, 200 and 201 yuan; negative, fractional
and missing amounts; and two order IDs in one closure with distinct expected
fees. It maps the input and output predicates and field names from the draft's
Case contract and vocabulary, so a draft with an unmappable shape fails this
fixture-specific audit rather than silently skipping it. With the cue above,
one additional one-call sample passed its own 6/6 examples and 8/8 citations
and the independent 8/8 examples (892 input / 1,591 output tokens). The cue was
then made generic by removing order-specific variable names. Its new SHA-256 is
`2b21b7c03f41bf9241aebcdcbc33812c0e3c06eabe07348b32a813d5567db851`.
One diagnostic with that version passed 6/6 model examples, 3/3 citations and
all eight independent cases (912 input / 1,454 output tokens, of which 784
input tokens were cache misses). These samples establish only the local
synthetic-shape check; a clean published-package browser run and paired
end-to-end token comparison are still needed.

The Worker test initially held the inline cue below 2 KiB. An overlong revision
failed that test. A compressed 2,026-byte revision met the limit but omitted a
concrete namespaced-predicate example; its one-call model draft failed to
compile because both predicate IDs were not canonical. A 2,024-byte
cue restored that example while retaining generic business-key and numeric
variables (SHA-256 `7e5e7cac7d04c0e5e40488f3ffc3c6fa04e94b21ccb3b171850085e47e325ba5`).
One diagnostic with that cue compiled, passed 6/6 model examples and 4/4
citations, and passed all eight independently supplied boundary examples. It
used 745 input / 1,486 output tokens with no reported input cache hit. This is
one stochastic synthetic check, not a measured production success rate. Later
samples exposed more invalid predicate and Case-key shapes, so the candidate
was not accepted as reliably green.

The current diagnostic uses twelve independently authored boundary examples,
checks that each contracted key field exists in both defined input and output
predicates, and checks numeric guards on every direct output rule. These are
fixture-specific assertions, not a general proof of business correctness.
A 3 KiB cue was also tried with explicit guidance for alias names, output
guards and unique business keys. It used about 956 input tokens per synthetic
call, versus 745 for the short candidate, but its sampled drafts still failed
different Case-key or example checks. That cue and the larger inline allowance
were not retained; there is no established retry or total-token improvement.
The Java checker source now rejects Case keys absent from locally defined
predicates before examples run. Further prompt changes should be judged by
repeated independent checks and a clean published-package browser run, not by
one passing sample.

For the 0.8.14 candidate, the new Java checker release and the bounded Worker
cue were paired locally. One DeepSeek Flash call used 718 input / 1,550 output
tokens and failed its first mechanical check: two vocabulary definitions lacked
argument-name arrays. This is a measured first-draft failure. The checker
upgrade narrows false acceptance of malformed Case keys; it does not yet prove
that the model will produce a complete draft in one call or save tokens across
the published browser workflow.

An additional 2,041-byte cue explicitly described `vocabulary.defines[].args`
as a field-name array. Its single DeepSeek Flash diagnostic used 728 input /
1,344 output tokens and compiled, but only 4/6 self-selected examples and 6/11
independent boundary examples passed. Neither direct output rule had the
required numeric guards. This candidate was reverted. The download optimization
below is independent of draft quality; first-draft reliability and total model
cost remain open acceptance work.

The 0.8.14 checker installer was separately measured against its pinned public
JAR URLs. A whole-file stream ran for over eight minutes without finishing
both files. Six bounded 256 KiB byte-range transfers in parallel installed and
SHA-verified both files (67,926,367 bytes) in 223.7 seconds on the same
computer and network. This measures dependency preparation only, not the
document-to-capability workflow or model cost. The installer retains an exact
digest check in both Range and whole-file modes and has a 30-minute overall
preparation deadline. The whole-file fallback and cancellation paths are covered
by local tests, not yet by a live non-Range production server.

## Bounded repair diagnostic and recovery inspection (2026-09-23)

The benchmark still defaults to a single paid request. An explicit
`RULITH_AUTHORING_REPAIR_ROUNDS=1` or `2` permits one or two additional attempts.
Each attempt records `checked` (checker ran) separately from `passed` (the complete
diagnostic gate passed), plus cumulative input/output usage. The final record
reports attempt count and pass/fail. Missing provider usage remains unknown.
Only model-selected checker feedback enters repair prompts; the independent
boundary answers are held out. These local diagnostics make no Gateway Case or
private draft and do not establish UI acceptance.

One three-call run used 6,787 input / 4,088 output tokens. Call one failed because
definition arguments were not name arrays. Calls two and three compiled, verified
5/5 citations, and passed 4/6 model examples but only 6/11 independent examples.
Neither of the two output rules had the audited numeric guards. The process
correctly exited nonzero. This run preceded the final privacy-safe projection of
diagnostics; it cannot establish the final implementation's repair quality or cost.

The current checker projection retains free-form errors, labels, details and
quotations in the local Artifact. Only fixed codes and bounded numeric indexes/
counts can accompany its receipt, and optional guidance is omitted when it would
exceed the negotiated receipt budget. Detailed report reads keep their Source
permissions. The input grammar and installed @2 Release are unchanged.

`RULITH_LIVE_STEP=inspect-recovery` starts only the selected local Agent to inspect
startup recovery markers. It sends no conversation message and starts no Worker.
It does not by itself force a server recovery query. On the real michal account,
Document QA still reported an inherited ApplyAction with unknown outcome. Its
original action was not replayed. The test exposed an inspector bug that said
"No unresolved call" despite the marker; the UI now distinguishes this local record
and keeps it visible across conversation changes. A clean end-to-end authoring run
remains pending resolution through the original-call recovery protocol.

A subsequent authenticated MCP initialization probe matched Document QA's Agent ID
and returned `waiting` for `ApplyAction`. It made zero Tool calls and closed its
transport session with HTTP 204. This confirms the current server still has the
call outstanding; the startup marker is not merely a stale local-file warning.
