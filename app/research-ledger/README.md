# Research ledger

A general Capability (published as `research_ledger_2`) for keeping an investigation on the Board: what is being tested, the data it
rests on, the directions given up, and which questions are still open. It is not specific to
programming; Deep Rulith uses it inside exploration goals. Version 0.4.0 (`rulith/v4`, package A)
keys the ledger by goal: `case_id` became `goal`, and `case_datum` / `case_open` became `goal_datum` / `goal_open`.

| Word | Who writes it |
| --- | --- |
| `research.ledger.hypothesis(id, claim, goal)` | the Agent, before an experiment; `goal` is the top-level goal's ID |
| `research.ledger.datum(name, value, unit, source, goal)` | the Agent, for every number it relies on, naming its source |
| `research.ledger.dropped(hypothesis, reason)` | the Agent, for a direction it gives up |
| `research.ledger.cites(goal, from_goal)` | the Agent, to use an earlier goal's data in this goal instead of recording it again (0.3.0, D-1008c) |
| `research.ledger.supported(hypothesis)`, `research.ledger.refuted(hypothesis)` | the Agent's own rules (`add_axiom`) over the receipts and data that settle it, so the reasoning is on the Board |
| `research.ledger.item(goal, hypothesis, claim, state)`, `research.ledger.goal_datum(...)`, `research.ledger.goal_open`, `research.ledger.is_dropped` | this package's rules only; the Agent cannot assert or redefine them |

A top-level goal is the root of its Case on the Board, so its goal ID is the `root` node. Every shown row is
derived from that goal's `root` and `case_context`, so a read of that goal includes it (a read follows the
goal's evidence forward and leaves other facts out of the page). Rows written under 0.3.0 with `case_id` are
not shown under 0.4.0; end the old exploration Cases before the cutover (A-25).

A rule that derives a goal's outcome can then require `naf research.ledger.goal_open(goal)`: the outcome
holds, and the Board can complete the goal, only when every hypothesis in it is supported, refuted or dropped.

## Build and check

```bash
node research-ledger/build.mjs
java -jar <local-authoring.jar> --check research-ledger/draft.json research-ledger/method.txt report.json
```

`program.json` is the package to publish. `draft.json` adds the citations, eight examples and a
Case contract that exists only so the mechanical checker can run (the checker requires one).
