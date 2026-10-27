# Intentional Formula Editing Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans. Follow each change with a failing regression and its passing result.

**Goal:** Let an author edit or delete formulas in the translation column and carry only those explicit mathematical changes into a reviewed English candidate.

**Architecture:** Keep the ordinary protected editor and citation guards. An explicit formula editor updates a versioned human draft through a private UI action. Source changes remain confined to independently verified source ranges, exact author formula authorizations, isolated compilation, human confirmation and inverse undo.

**Tech Stack:** Existing Node/MCP service, plain JavaScript UI, offline Markdown/KaTeX and Windows isolated TeX compiler.

**Spec:** Current user request and confirmed choice to use formula edits as English revision intent.

## Decisions

Directly unlocking every protected atom would allow accidental citation damage and would fail source candidate validation. A translation-only formula editor would not meet the confirmed English revision requirement. Use explicit formula editing with a pinned authorization instead.

## Global Constraints

- New controls and documentation default to English; existing interface preference is preserved.
- No direct source write from formula editing or model output.
- Model translation results retain their existing placeholder checks.
- Only exact, complete mathematical objects are editable; citation and structure changes never inherit formula authority.
- Preserve prior drafts, original baselines, opinions, chat identity/model and project history.
- No new model chat, external publication, commit or push.

## Review Focus

- Repeated equal formulas must map by exact occurrence, never by guessed text match.
- Undo/redo and ordinary prose saves must retain or revoke the correct formula authorization.
- Stale source, draft, language, selection and alignment must reject delayed edits without losing input.
- Formula deletion must preserve unrelated references, including nested protected objects.
- Complete math-only ranges need independent authority; reading-only ranges must remain honestly limited.

### Task 1: Formula editor and author history

Files: `ui/protected-editor.mjs`, `ui/app.mjs`, `ui/style.css`, a focused inline formula controller and browser regression.

- [ ] Reproduce blocked formula editing/deletion.
- [ ] Add explicit keyboard-accessible formula edit/delete actions, LaTeX preview and cancellation.
- [ ] Rebuild protected atoms correctly through undo/redo.
- [ ] Persist through `editTranslationFormula`, retaining unsaved input on conflict.
- [ ] Verify reload, reading rendering and continued citation protection.

### Task 2: Draft authorization and source candidate boundary

Files: a bounded formula-authorization module, `src/core.mjs`, `src/reading-workflow.mjs`, `src/application.mjs`, source-range validation where needed, focused tests.

Private UI contract: `editTranslationFormula({segmentId, language, expectedRevision, expectedSnapshotId, start, end, before, replacement})`, using UTF-16 draft offsets and complete math raw strings; empty replacement requests deletion. Return the updated draft and source-candidate availability/diagnostics.

- [ ] Reproduce current draft persistence but source candidate rejection.
- [ ] Validate exact mathematical span and explicit human operation, pinned to current source and draft.
- [ ] Preserve/reconcile bounded author formula history through ordinary saves and undo/redo.
- [ ] Capture effective math tokens only in revision requests; keep deleted placeholders mandatory.
- [ ] Revalidate authorization during proposal creation, candidate editing and preview/compile.
- [ ] Verify denied citation/structure/model mutations and independently compiled inverse restoration.

### Task 3: API, installation and acceptance

Files: `src/server.mjs`, `src/local-web.mjs`, API tests, version metadata, English guide/verification.

- [ ] Add capability-protected UI routing and rejection tests; expose no new model mutation tool.
- [ ] Build and run relevant tests, full release regression and browser acceptance.
- [ ] Verify actual paper formula draft edit/delete/undo and a disposable source compile/writeback/inverse cycle without altering author originals.
- [ ] Install and reopen the updated workbench with saved paper/chat records preserved.
- [ ] Compare installed hashes and package only allowlisted public files.
