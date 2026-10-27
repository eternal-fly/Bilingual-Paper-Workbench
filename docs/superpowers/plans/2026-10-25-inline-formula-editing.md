# Inline LaTeX formula editing

The user wants formulas to be ordinary inline LaTeX while editing a translation paragraph, without a separate formula dialog or an insert-formula step. Reading mode retains Markdown/KaTeX typesetting. Existing English candidates still require safe compilation and explicit writeback confirmation.

1. Add backend tests for one atomic, project/snapshot/revision-pinned human draft save containing prose and formula edits/deletions. Preserve source math matching, citations, labels, structural protections, candidate revocation and undo. Never infer source authority from ambiguous math alignment or model callbacks.
2. Replace math chips in the paragraph editing surface with raw editable LaTeX. Retain protected non-math atoms, the active paragraph's third-column notes, keyboard editing and undo. Show any validation error beside the current input and preserve incomplete input for correction.
3. Route the new save only through the existing authenticated UI capability, with strict input schema. Prove unauthenticated/model calls cannot grant math intent.
4. Run focused red/green tests, browser real-backend cases, enabled regression and artifact validation. Verify the supplied paper in a private replica, leaving the real manuscript/drafts/reviews unchanged.
5. Bump to 1.3.0, document the simpler interaction, back up the exact current task, upgrade the installed copies, reopen and read back the same project/chat. Package only allowlisted public artifacts and verify hashes.

No new chat, independent inference worker, author-source write, commit, push or public publication is part of this change. Reuse Desktop-owned inference and the existing confirmed-write/undo mechanisms.
