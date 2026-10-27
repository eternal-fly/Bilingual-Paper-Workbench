# Source-project bilingual workflow implementation plan

**Goal:** Open the actual LaTeX project, preserve its English template through literal source edits, update translations for exact changed paragraphs, and explicitly organize imported reviews with Codex.

**Architecture:** Existing source ranges, protected objects, isolated builds and UI confirmation remain authoritative. The project file viewer reads only current manifest inputs. Translation presentation decodes a small static TeX formatting subset into the existing safe Markdown reader. Imported-review organization retains raw external notes and adds a latest display overlay on their existing identities, preserving file withdrawal/deletion behavior.

**Tech stack:** Existing Node 24, MCP Apps, Markdown-it/KaTeX, PDF.js and Windows AppContainer TeX/BibTeX worker. No new model provider or automatic model prompts.

## Constraints

- Preserve the original documentclass, engine choice, macros, two-column settings, figures and bibliography style. A supplied PDF is a reference; never reconstruct or replace its template from extracted text.
- Keep manuscripts and source archives outside the repository. Preserve the previous paper record and all existing drafts/reviews.
- Keep formula/reference order and exact source range protection. Translation presentation grants no write authority.
- Read source files only from the authorized project manifest, with snapshot/hash validation and bounded UTF-8 decoding; never expose arbitrary local paths through a tool.
- Organization is explicit and scoped to an exact imported file/selected note IDs, with bounded complete context and atomic stale-result rejection. Preserve original bodies/decisions and external provenance; no automatic source write, draft replacement or review-head advancement.
- Native windows use their current chat through existing copy/host routes; do not create an implicit worker fallback.
- No commits or public publication. Local installation/reload remains authorized.

## Task 1: Original template and bibliography compilation

Files: `src/core.mjs`, `src/compiler/worker.mjs`, focused synthetic/native tests.

- [x] Pin a failing local-BST dependency/read-set test and a real BibTeX citation convergence test.
- [x] Include existing project-local bibliography styles as hashed inputs; keep distribution styles as runtime resources.
- [x] Expose only immutable inputs to BST lookup. Run bounded TeX/BibTeX/TeX/TeX when bibliography data is present.
- [x] Provision verified official REVTeX 4.2 assets through the existing public-runtime preparation/inventory mechanism, then compile the supplied project in isolation without modifying it.

## Task 2: Source viewer and translation structure

Files: source UI module, safe presentation decoder, `src/application.mjs`, private UI transports, synthetic tests.

- [x] Test manifest-only source reads, stale snapshots/hashes, traversal/alias rejection and binary exclusion.
- [x] Add `listProjectSources({})` and `readProjectSource({path,expectedSnapshotId,expectedHash})` as UI-only reads.
- [x] Show the main `.tex` and project dependencies in a read-only source view; keep original-format PDF compilation explicit.
- [x] Decode only balanced known static prose formatting into the safe reader; preserve math/references and show unsupported syntax literally.
- [x] Add an explicit changed-paragraph translation entry using existing exact selection requests and protected result tools. Never overwrite a newer/manual draft implicitly.

## Task 3: Explicit organization of imported opinions

Files: dedicated review-organization controller, result schema/context, private UI actions, native context/result tools, imported-file UI, tests.

- [x] Test exact file/note scope, one-to-one output, untrusted text, source/language/draft/decision changes, expiry/replay and raw-data preservation.
- [x] Prepare a bounded request over exact external notes and current protected source context. Return an explicit context and result contract.
- [x] Validate and atomically store the latest organized presentation on the existing external note identities; preserve raw text, decisions, source provenance and review generations.
- [x] Provide one explicit user action and visible request preview/copy/send path; support the existing selected independent chat only when explicitly requested.
- [x] Preserve withdrawal, restoration and exact-file deletion cascades; label organized opinions and allow original text inspection.

## Task 4: Verification and installation

- [x] Run focused tests, full enabled native suite, browser suites, package build/validation and independent review.
- [x] Verify original source bytes and source-template structure, resolved bibliography and actual PDF layout; verify translation/opinion return on the new source project without automatic source promotion.
- [x] Install versioned artifacts, reload the same authorized paper chat, verify installed hashes and record private evidence. Report any unavailable asset or native-host transport limit precisely.

## Review focus

- A missing runtime class must fail, never switch the author's class or layout silently.
- A local bibliography style must remain a hashed project input and cannot escape the immutable input directory.
- Rendering unsupported TeX must not execute HTML, macros or filesystem access.
- Organization of a retired/deleted import or a stale draft must fail without orphaned model notes.
- A changed-paragraph translation must preserve the complete alignment group and newer human edits.
