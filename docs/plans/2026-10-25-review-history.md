# Current opinions and optional retained history

The author asks for current opinions by default, with a separate choice to retain or clear historical opinions.

1. Project opinion generations per exact source scope. All notes from the latest relevant batch remain current. Metadata-only enrichment does not advance a generation. Empty running/failed batches do not hide usable opinions; successful zero-finding results with exact reviewed scope create an empty current head.
2. Default the pane to current opinions and reset that view when the paragraph or project changes. History is an explicit read-only view. Keep unrelated paragraph/current records and separate manual annotations/formal revision audits.
3. Persist a project preference to retain subsequent historical model opinions, enabled initially. Turning it off governs subsequent replacement, rather than silently deleting existing history. Preserve an old multi-anchor note while it is current anywhere.
4. Expose authenticated UI-only history clearing. Preview a concrete scope and count, then require the matching short-lived confirmation. Recheck generation/content identity before deleting globally historical notes only. Keep current heads/tombstones so cleared history cannot resurrect older current results.
5. Verify latest-only display, zero findings, partial coverage, shared anchors, preference CAS, confirmation expiry/races and current-record protection. Test actual installed-paper controls read-only; do not clear the author's records during development.
