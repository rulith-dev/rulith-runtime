# Explicit draft construction — proposed next release

Status: design only. Existing `check_draft@2` and `official_authoring@2.0.0`
continue to accept their exact canonical input. This document changes no runtime
contract or authority.

## Problem and measured limit

The model currently repeats predicate namespaces, alias wiring, argument names and
Case envelope fields while also interpreting the document. Isolated runs fail both
at this mechanical layer and at business boundaries. Better error messages fixed
one argument-array failure but did not fix invalid-input guards. A constructor can
remove repetition; it cannot decide the intended rule meaning or establish that
the model's own examples cover the document.

## Proposed boundary

Add a versioned construction input to an ordinary Source-bound authoring Tool in a
new Release. Use the same Worker, authenticated Connection, local material storage
and checker path. No Agent shortcut, new control-plane privilege or stronger
grounding tier is introduced. Existing @2 requests retain their current meaning.

The model must supply an explicit symbol table, rules, Case wiring, examples and
citations. The operator/model still decides every business predicate, field name,
key, condition, output, ambiguity and requested evidence floor. The constructor may:

- Expand an explicitly supplied namespace and local symbol into its canonical ID.
- Resolve explicit symbol references and map supplied arguments to declared names.
- Emit fixed structural envelope fields and aliases according to the new format.
- Preserve the declared order and compute the canonical proposal digest through
  the existing checker implementation after construction.

It must reject unknown symbols, duplicate bindings, missing required construction
fields and unsupported formats with a path and fixed diagnostic code. It must not
invent predicates, infer Case keys, insert validity guards, fill missing examples,
adjust citation text or choose a Source's floor. Deliberately incomplete inputs in
negative test examples must remain incomplete; normalization must not repair them.

The initial implementation should live beside the Java authoring compiler, using
its ordered JSON and exact number handling. The Node Worker invokes that one
implementation. Do not maintain a second rule or Case validator in JavaScript.

## Visible proposal and evidence

Construction returns a local immutable Artifact containing the submitted construction
input, expanded canonical draft, normalization version and detailed checker report.
The review screen shows the expanded rules and Case contract actually checked.
Certification and saving bind the expanded proposal digest. Constructor success is
not compilation success, compilation is not business acceptance, and independent
review must remain visibly separate from model-authored example results.

ReadArtifact permissions apply to every representation. Inline results may expose
fixed codes, field paths from a fixed schema, and numeric positions, but no free-form
labels, names, quotations or exception values copied from local material.

## Implementation and acceptance sequence

1. Specify the new construction schema and deterministic expansion with golden
   examples, refusals, exact-number cases and omitted-field negative tests. Have
   GPT-6 Sol review the mapping before shipping a new Tool/Release.
2. Invoke the constructor/checker through the ordinary Worker Tool, expose the
   expansion Artifact, and pin its descriptor and implementation digests together.
3. Update preparation to install that explicit new Release after checking active
   work. Never replace the meaning of a running @2 task or reissue an unknown Action.
4. Compare repeated independent-boundary outcomes and provider token usage on the
   fixed synthetic fixture. A held-out check must not feed its answers to retries.
5. Run the complete public-package browser journey: prepare, attach, clarify,
   construct/check, review exact proposal, save private draft, restart and recover
   its receipt. Include permission withdrawal, lost replies and a pending-call case.

Only then decide whether the new format improves success rate and total cost per
successful task. Retain a canonical-input path for exact hand-authored proposals;
do not interpret an unsuccessful experiment as a migration requirement.
