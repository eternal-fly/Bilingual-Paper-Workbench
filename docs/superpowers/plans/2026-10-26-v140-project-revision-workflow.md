# Project and revision workflow 1.4.0 implementation plan

The author requested a complete native revision workflow, correct default chat
and project restoration, full-paragraph math edits, and a title-based project
selector that changes the associated background chat together with the paper.
This release extends the prior latest-PDF handoff plan without publishing data.

## Boundaries

- First opening inherits the invoking native chat and its trusted project roots.
  Restoring a record reads that paper's latest saved source and private state.
- Reopening the same task reuses its daemon/window. A current host-project hint
  is signed; model arguments and imported text cannot assign an origin identity.
- The Project selector uses human selection of an exact private record. A
  cross-chat choice navigates the same window to that chat's canonical daemon;
  it never creates another inference worker or copies one chat into another.
- Each paper record keeps one verified saved chat binding. Missing or ambiguous
  bindings require an explicit connection, rather than an invented chat target.
- A whole-paragraph math inventory is derived from the latest saved human draft.
  Original source and before/after inventories are shown for review. Model output
  must preserve the resulting exact inventory, citations, labels and structure.
- Compiled candidates stay pending until human confirmation. Confirmation and
  confirmed undo automatically publish and display the verified latest English
  PDF; the first-upload baseline remains frozen.

## Tasks and independent checks

1. In `native-window`, `background-workbench`, `server`, `workspace-service` and
   `task-registry`, derive and sign the current host context; restore only its
   exact compatible record. Verify fresh chat, changed root, imported private
   source, multiple mains, same-task reuse, tamper/replay and busy switching.
2. In `formula-edits` and `core`, derive full human math inventory grants and
   revalidate at proposal, preview and acceptance. Verify added/reordered math,
   malicious controls, label/reference preservation, native packets and stale
   draft/undo rejection. Independently review this authority boundary.
3. In the project-switch controller, registry and Windows handoff helper, select
   the exact saved binding, prepare its canonical daemon and navigate once.
   Transfer the verified window registry only after the target UI acknowledges
   its one-use navigation nonce. A failed navigation keeps the current window.
4. Add the compact Project popover and mathematical review lists. Keep keyboard
   access, unsaved-buffer protection, current reading style, and project history.
   Verify title selection, chat identity, failure/retry, same-window navigation,
   nonce cleanup and confirmation-time before/after formula visibility.
5. Build, run complete enabled Node/native and browser regression, and validate
   all artifacts. Test the actual saved paragraph through its original Astra
   chat, compile its returned English candidate, and verify confirmed write/undo
   on a disposable paper copy. Do not confirm the author's actual source.
6. Install 1.4.0, preserve records and source hashes, read back installed bytes,
   update the English manual and prepare the local MIT runtime/source packages.
   No public repository or marketplace mutation is part of this release.
