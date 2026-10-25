// SPDX-License-Identifier: Apache-2.0
/** The local host's projection of the Agent's recent-operations strip. It contains no Case or Worker authority. */

/**
 * This Agent's recent operations, as the authority last showed them.
 *
 * The Agent forwards the recent-operations strip in its state-only form — label, state,
 * stage and times — whenever the authority shows it: at `initialize`, on each `ping` while it
 * keeps a model's call open, and with every tool result. Nothing is inferred here: an entry
 * that was not received is not shown, and when the Agent process changes the list is kept
 * but marked as from before that change, because the new process has not reported yet.
 *
 * A held call — one the authority still holds while the Agent keeps the model's own call
 * open — gets its own line, so that a quiet conversation reads as waiting, not as stuck.
 *
 * The local host keeps this snapshot and sends it first on every read of its event stream (`runtime-operations`).
 */
export function projectOperations(events, initial) {
  const words = { running: 'Running', waiting_for_decision: 'Waiting for a decision in Console', done: 'Done',
    failed: 'Failed', refused: 'Refused', unknown: 'Reconciled, external effect unknown',
    needs_person: 'Needs reconciliation in Console' }
  const stages = { not_dispatched: 'not yet dispatched', at_worker: 'at the Worker' }
  let current = initial ?? { reported: false, stale: false, entries: [], held: null, accountId: '', agentId: '' }
  for (const event of events) {
    if (event.src !== 'agent') continue
    if (['spawn', 'exit'].includes(event.type)) current = { ...current, stale: current.reported, held: null }
    if (event.type === 'operations' && Array.isArray(event.operations)) {
      const entries = event.operations
        .filter((row) => row !== null && typeof row === 'object' && Object.hasOwn(words, row.state))
        .slice(0, 7)
        .map((row) => ({ label: String(row.label || row.tool || 'Operation'), state: row.state,
          words: words[row.state] + (Object.hasOwn(stages, row.stage) ? ' · ' + stages[row.stage] : '')
            + (row.contentWithheld === true ? ' · content withheld' : ''),
          since: String(row.since || ''), needsPerson: ['waiting_for_decision', 'needs_person'].includes(row.state) }))
      current = { ...current, reported: true, stale: false, entries,
        accountId: String(event.accountId || ''), agentId: String(event.agentId || '') }
    }
    if (event.type === 'held-call') {
      current = { ...current, held: event.phase === 'waiting'
        ? { tool: String(event.tool || ''), label: String(event.label || event.tool || 'A call') } : null }
    }
  }
  return current
}
