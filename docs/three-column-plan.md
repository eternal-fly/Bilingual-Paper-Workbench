# Three-column paper review implementation plan

Goal: English PDF at left, editable paragraph translation in the middle, selected-paragraph annotation cards at right, aligned vertical reading boundaries. Add imported external opinions and complete-source Codex review using the existing persistent paper chat.

Architecture: Preserve the tested PaperService/PaperApplication transaction boundary. English PDF is a derived immutable reading artifact, never a source write. Review opinions are durable annotations, never implicitly accepted source proposals. Translation drafts retain independent revisions.

Decisions: Keep Node 24, existing PDF.js/vanilla frontend, AppContainer compiler and the exact current paper chat. A replacement desktop framework or another chat would discard already verified integrations. Existing four-layer comparison and full chat remain accessible auxiliary tools.

Constraints: No commit/push/publication or memory-kernel changes. Keep real paper, uploads, model content and screenshots in private application data. Unknown or ambiguous anchors remain unlocated; imported documents are untrusted data. No opinion can bypass protected-token validation or reviewed source promotion.

## Tasks and contracts

1. English reading projection: create src/english-view.mjs and synthetic tests. Export deriveEnglishView(source, filePath) with projected text, original-to-derived line map, bilingual reading paragraphs and exact original byte ranges. Preserve mathematical objects and English original prose; omit Chinese companions and pending replacement/reason blocks for the supported review template. Fail explicitly for unrecognized transformations. Root integrates compiler jobs kind english and source navigation through the projection map.
2. Opinion ingestion: create src/review-notes.mjs, ui/review-import.mjs and tests. Browser extracts bounded TXT/MD/JSON/PDF text+annotations and DOCX text/comments, retaining filename and digest. Backend splits external opinions and anchors only exact unique evidence. Durable records use noteId, batchId, origin, title/body/recommendation, sourceSegmentIds, sourceSnapshotId, confidence, revision and status. Uncertain opinions remain unanchored. Source files are never modified.
3. Full-paper review controller: snapshot every reachable textual manuscript file and its identity; send all UTF-8-safe bounded chunks through the bound Astra chat, record exact coverage and completed turns, then validate structured opinions. Final output stores annotations only. Errors/cancellation/stale source preserve partial evidence and never claim full coverage.
4. Frontend: replace default four-layer reading surface with editable translation; third column shows notes for exact selected source IDs and explicit unlocated/global notes. Common grid rows align PDF and translation content top/bottom. Codex becomes a drawer or third-column mode. File upload and full-review actions show actual scope, progress, cancellation and provenance.
5. Verification/install: unit and adversarial tests, browser geometry/paragraph selection/import checks, actual English PDF compile and real complete-paper review, source byte invariance, package/install readback. Reuse private drafts/history and user-level launchers.

## Review focus

- Derived English PDF must not present pending rewrites as applied originals.
- Annotation references must survive polling, reject wrong snapshot/IDs, and never silently choose among repeated quotes.
- Large or malformed PDF/DOCX uploads must fail within byte/page/entry limits; no external relationship fetching or macro execution.
- Whole-paper completion requires all textual input chunks delivered and completed, not a selected abstract advertised as full review.
- Editing translation must persist without accepting an annotation or changing official source.
- Matching reading-panel top/bottom boundaries must be verified on the installed product at desktop and narrow widths.

## Accepted follow-up requirements

- Raise external import to 64 MiB files, 32 MiB extracted text and 5000 opinions, with bounded PDF/DOCX parsing, visible progress/cancel and full input preservation. Use a separate authenticated large-upload route; keep ordinary request/model limits. Avoid retransmitting unchanged large state and avoid quadratic quote inference.
- Move workbench operations to an accessible left toolbar and expand the two reading surfaces. Opinions reserve space at the right, never cover the translation. Provide two selectable themes, including a warm yellow/orange light palette.
- Borrow bidirectional workflow ideas from the official Sync-Writer project while retaining PDF reading, the bound Codex conversation and reviewed source writes. Chinese changes generate pending English candidates; formal English changes may update translations. Sentence-end automatic sync is optional and off by default. Persist per-paper terminology and reject results based on stale draft/alignment/settings versions.

Status: complete and locally installed as v0.3.1. Core/native tests233/233, browser checks144/144, actual two-PDF review7/7 and installed read-only UI19/19 passed. The actual previously rejected review PDF imported completely. Same-thread Astra returned3 latest opinions and192 target-language translation units in one user turn; original source SHA-256 remains unchanged. Actual-paper evidence stays in private application data; synthetic reports remain under ignored work/.
