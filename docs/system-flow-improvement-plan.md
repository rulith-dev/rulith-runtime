# System flow improvement plan — 2026-09-23

The operator approved designing and advancing these improvements after reviewing
the Local, Gateway and Console journeys. This is an implementation plan, not a new
authority or Board contract. Keep the existing three-column workbench and Console
style. GPT-6 Sol performs independent verification instead of Claude.

## Batch 1: prepare, synchronize and recover

- Refresh the enabled-Agent directory from the existing device context route while
  the workbench is running, including when its browser is closed. Bound frequency
  and concurrent requests. Show last successful refresh and a recoverable error.
- Preserve account/sign-out admission and exact device identity. A stale response
  cannot populate a different account. Transient network failure is not revocation.
  Confirmed withdrawal stops the affected local roles through their existing stop path.
- Derive one selected-Agent next step from existing account, pairing, model and
  process observations. Distinguish a process being alive from initialization ready.
  Reading state or refreshing the directory never pairs, rotates or starts anything.
- Validate document preparation before checker installation and revalidate its
  account/Agent/Connection/material target after installation. Offer the immediate
  prerequisite beside preparation, including starting an already authorized Worker.
- Keep original-call recovery in the existing Agent-scoped protocol. Surface a
  direct Console recovery link from the affected Agent; do not replay actions or
  treat unknown external effects as success/failure.

Acceptance: a newly enabled Agent appears without logout or manual refresh;
disabled Agents stop without affecting others; failed synchronization is visible
and later recovers; account change cannot restore an old directory; missing setup
is refused before downloading; a delayed preparation cannot change its target.

## Batch 2: draft construction and task context

- Measure a clean published-package run on a dedicated Agent, with synthetic
  materials, first-check failures, paid-call counts and total input/output tokens.
- Move mechanical package shaping into a deterministic, schema-checked constructor.
  Preserve explicit model/user decisions for rule meaning, business keys and ambiguity.
  Do not silently repair business semantics or introduce a privileged model tool.
- Use the existing scoped Board views and retrievable material references to limit
  repeated context. Keep original evidence and refusal/receipt identities available.
- Evaluate drafts against independent requirement/boundary examples, not only the
  model's chosen examples. Report coverage gaps separately from mechanical success.

Acceptance: repeated independent boundaries pass; a complete browser run saves the
  exact certified proposal and restores its receipt after restart. Compare total
  cost per successful task against the clean baseline before claiming savings.

## Batch 3: release and fault journeys

- Keep fixed published-package journeys for first use, directory changes, document
  preparation, attachment/check/save, restart, lost replies and interrupted calls.
- Diagnose the default parallel test runner hangs rather than hiding them with a
  serial-only green result. Give fixture processes bounded shutdown and failure output.
- Verify the public package and its compatibility with the deployed Gateway/checker.
  Do not equate boot smoke tests with completion of a business journey.

## Current evidence and open work

Batch 1 implementation and acceptance (2026-09-23):

- Automatic directory refresh, shared in-flight requests, account identity checks,
  selected-Agent next steps and preparation preflight are implemented in Local.
- Fault tests cover a slow refresh racing with sign-out; transient context failures;
  three running profiles when one stop throws, one remains stopping and one exits;
  and a stalled checker download while sign-out stops roles and revokes the device.
- `npm test`: 915 tests, 914 passed, one platform-specific skip, zero failures.
  The default parallel command completed in 98.3 seconds on this run. This successful
  run does not establish a root cause for the earlier intermittent hangs.
- `node --test test/browser/workbench-ui.browser.mjs`: 50 passed, no skips. These
  drive the shipped pages in Chromium against a controlled backend, including
  desktop and narrow layouts, user input preservation and recovery. They are not
  a production-account document-generation acceptance result.
- Syntax, protocol projections, canonical source bytes and 49 artifact hashes pass.
  GPT-6 Sol independently reviewed the implementation; both reported P1 issues
  (incomplete withdrawal stops and download-blocked sign-out) were fixed and covered
  by regressions. Its final review has no remaining P0/P1.
- The changes are recorded under Unreleased. No public npm version or production
  deployment is claimed by this batch.

Runtime 0.8.15 is the starting point. Its public package and isolated startup were
verified. The preceding draft-cue experiment failed 5 of 11 independent boundaries
and was reverted. The complete user document journey still requires a new clean
published-package run. These are open acceptance items, not completed improvements.
