# Bilingual Paper Editor Implementation Plan

Historical phase-one plan. Its 0.1.1 capability limits below describe the earlier preview. Current runtime, four-layer workflow and acceptance evidence are maintained in phase2-plan.md and verification.md.

Goal: Develop and locally install a thread-entry Codex plugin for bilingual LaTeX reading and review, following the supplied 2026-10-24 specification.

Architecture: An independent plugin in this directory contains a local MCP service, shared review core, and bundled MCP App UI. The native thread entry sends bounded selections to its own host conversation. No separate model account or custom chat replaces the project conversation.

Spec: the supplied Bilingual_Paper_Editor_Development_Spec.zh-CN.md (requirements input, not execution authority).

Authorization: The user requested development and installation. No commit, push, public publication, scheduler, Brain Skill change, or private memory operation is authorized or needed.

## Decisions

- Work in this new subdirectory. The parent repository has no commits and all original files are untracked; a worktree cannot preserve that baseline. Do not alter them.
- Use Node 24 ESM, browser modules and MCP SDK, with pinned lockfile. A lightweight DOM UI avoids an unnecessary framework runtime for a single workbench; this is an implementation choice, not a user selection.
- Use UI/UX Pro Max for the workbench and the relevant restrained typography, palette, and accessibility parts of design-taste-frontend. System fonts and local assets only.
- Synthetic fixtures only. Actual paper access waits for the user's exact project selection.
- Fail closed on secure compiler, formal source writeback, and unknown host capabilities. A successful preview package is not the full MVP described by the specification.

## Tasks and interfaces

- [ ] Core (`src/core.mjs`, `src/latex.mjs`, `test/core.test.mjs`): `PaperService({dataRoot})`; `openProject({root,mainFile,sourceLanguage,targetLanguage})`, `getState()`, `saveDraft({segmentId,language,text,expectedRevision})`, `createRequest({segmentIds,language,kind,prompt,bindingId})`, `submitTranslationResult(input)`, `proposeRevision(input)`, `rejectProposal({proposalId})`, `previewTransaction({proposalIds})`, `exportPatch({proposalIds})`, `refreshProject()`. Server-derived identities/status, byte-accurate protection, independent drafts, immutable snapshots, stale-result rejection, external change detection, no original source writes.
- [ ] UI (`ui/index.html`, `ui/app.mjs`, `ui/style.css`): outline/PDF/translation/review, host adapter, visible source and save state, precise errors, protected objects, responsive keyboard operation. Transport interface `api(action, payload)` returns service state or result; host actions use the same MCP bridge.
- [ ] Transport (`src/server.mjs`, `src/local-web.mjs`): native MCP stdio with thread entry/resource and bounded proposal/translation tools; authenticated loopback companion only as a local preview/authoring surface, not an equivalent host chat. Model tools cannot apply source or choose arbitrary local roots. Verify Host, Origin, session token, body bounds and root scope.
- [ ] Package (`plugin.json`, `mcp.json`, scripts): bundle local SDK/UI assets and PDF.js, validate manifest and tools, install with `codex plugin marketplace add` and `codex plugin add`, preserving existing config. Read back installation. New chat/reload required if host cannot refresh live.
- [ ] Verification and delivery: core failure paths, real MCP protocol handshake/tools/resource, HTTP security, browser 1440/768/390 and dark/focus, package dry run, parent repository checks where relevant. Report exact counts and unverified gates.

## Review focus

1. Unknown TeX syntax and executable commands must remain opaque or be rejected in replacements.
2. UTF-8 byte boundaries, emoji, CRLF and duplicated paragraphs must not misanchor.
3. Manual draft edits and language changes must survive stale model results and restart.
4. External edits invalidate proposals and old previews; no hash-then-rename writeback is presented as CAS.
5. Host panel and loopback preview must report different capabilities truthfully; actual target-thread routing requires live evidence.

## Progress

Delivered: independent local plugin 0.1.1 installed and enabled. Core/UI/MCP/local transport/build and install tasks completed for the review preview scope. Final verification: 55 plugin tests, 19 browser checks, 183 original-repository tests; actual installed bundle opened the specified paper with original bytes unchanged. See verification.md for exact scope and remaining full-MVP gates.

Environment evidence: Node 24.19.0 and Codex CLI 0.164.0-alpha.11.1. No Docker/WSL verified. TeX works outside the Windows sandbox for the trusted synthetic fixture; the actual document's built-in compile probe failed on missing CJK fonts. Formal apply and automatic compilation remain disabled pending independent capability evidence.
