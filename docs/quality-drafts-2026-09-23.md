# Runtime 0.8.9 quality acceptance — 2026-09-23

## Scope and result

This batch repairs unsent conversation drafts, file-add recovery and local view export.
It preserves the gray workbench design and does not change Gateway, Board, Source
permissions or capability publication. No production server restart is required.

## Reproduced defects

- Text and Case preferences followed the user into another conversation while attachments
  already belonged to separate drafts. The new regression failed before the fix.
- An unsent new conversation had no entry to return to after switching away.
- Failed file additions offered removal but no explicit retry.
- Session export included every loaded conversation under a misleading activeCase field.
- Narrow standalone pages hid both the sidebar and the Conversations entry, while the
  embedded page worked. Narrow history controls were also hidden by a generic CSS rule.

## Automated and independent checks

The shipped UI script is exercised with delayed replies, concurrent draft edits,
attachment removal, changed model destinations, archived targets and actual export
serialization. Real loopback HTTP tests verify refusal before material storage and the
unset-provider default. Focused suite: 67 passed. Final prepack: 890 tests, 889 passed, one existing
platform-conditional skip, zero failures. Syntax, protocol guards and all 49 artifact
hashes passed. The installed 0.8.9 package matches all 49 hashes.
Tarball SHA-256: `16c725734f19c12fe9d7fc5dd9bda204c5f6392c37454a5d25f67ea950b54cfc`.

Read-only Claude review found two blocking material destination issues (default endpoint
mismatch and missing initial status); both were corrected and covered. Subsequent reviews
found no P0/P1. Lower-priority export scope, archive recovery and responsive layout findings
were addressed, including the MediaQueryList compatibility fallback.

## Real browser acceptance

Used the existing michal account and the synthetic UI acceptance Agent's saved history.
The Agent and Worker stayed stopped; no model request or new Board task was submitted.
No production account, Agent enable/disable or connection setting was changed.

- Entered text and advanced fields in an old conversation; selected a new conversation;
  verified empty fields; switched back and recovered all old fields.
- Created a new unsent draft, navigated away, and selected it again from Conversations.
- Used the native browser file chooser to add a short synthetic text file. It reached
  Ready locally, and did not appear when switching to the other conversation. Immutable
  custody storage retains that synthetic original; removing a draft chip is not deletion.
- Desktop export created a real JSON file in Downloads with 12 loaded events belonging
  only to the selected session; no unsent test text. CUA's download event timed out, but
  the filesystem receipt and decoded JSON verified the completed download.
- At 390 x 844, archived the synthetic history, selected All activity, restored it using
  the visible control, and confirmed one active conversation again. No message was sent.
- Export from the narrow Conversations dialog created another JSON file with null paging
  coverage for All activity, rather than falsely claiming no older messages exist.
- Tested both embedded and standalone pages at 390 x 844. At 1440 x 900, the standalone
  dialog closed, its nodes returned to the sidebar and focus landed on New conversation.
  There was no horizontal overflow and no browser console warning/error.

Temporary browser tabs and owned manager processes were closed. Synthetic history was
restored to its original active state; the cloud synthetic Agent remained disabled.

## Limits

Unsent drafts are held in the open page, not durable storage. Closing/reloading discards
unsent input; accepted history remains separate. Explicit retry may retain an extra local
immutable copy after a lost acknowledgement. Downloaded view files contain loaded local
trace events, are incomplete, and are not original materials or Board proof.

Transient retry and delayed-response failures were injected in deterministic UI/HTTP
tests, not by disrupting a live production service. This batch does not claim to rerun the
unchanged complete document-to-capability workflow; that earlier acceptance remains in
quality-continuity-20260923 and the Java quality records.
