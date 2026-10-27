# Markdown paragraph reading and revision comparison

The author asks for readable translation paragraphs, click-to-edit protected drafts, and whole-paragraph bilingual review with sentence-level revision colors.

1. Share one offline Markdown + KaTeX renderer between translation and opinions. Keep HTML input disabled, external media disabled, mathematical expansion bounded and custom macro context tied to the authorized source snapshot. Unsupported syntax remains explicit source; presentation never executes source TeX or requests a model turn.
2. Keep translation paragraphs in reading mode until click or keyboard activation. Editing retains the existing atomic math/reference objects, autosave, conflict handling and paragraph IDs. Save/finish returns to reading only when safe; active IME and unsaved/conflicting buffers remain editable.
3. Preserve CURRENT and RECOMMENDED bilingual paragraphs from structured review files. New model review requests default to whole-paragraph wording and exact current context. Compare sentences conservatively, treating math/reference objects atomically: changed current sentences use #8D470B, recommended sentences #135B7A, and unchanged sentences use normal ink. Dark mode adapts these colors for contrast.
4. Old sentence-only notes remain identifiable; reconstruct a whole paragraph only from a unique literal replacement, never by guessing missing text. Reimporting the author's same review may fill exact missing CURRENT metadata without duplicating notes or changing decisions.
5. Verify Markdown/KaTeX security, sentence correspondence, edit protection/IME/conflicts, contextual notes, existing regressions, offline fonts and actual installed-paper behavior. Preserve formal TeX compilation, confirmation/writeback and undo boundaries.
