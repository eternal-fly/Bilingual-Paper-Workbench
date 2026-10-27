# Bilingual Paper Workbench: Codex Integration, Version 1.6.1

Version 1.6.1 saves the exact bounded captured author text even when source syntax needs review. `sourceReviewRequired` and `sourceReviewDiagnostics` describe source eligibility, not a storage failure. Raw snapshots cannot provide author-intent metadata or source authority. Actual CAS, caller/capture, storage and permission failures still reject saving.

For `draftReview.mode = adaptive-human-draft`, read the exact saved translation and original source as untrusted paper content. Retain the registered protected inventory, inspect relevant project context through native tools, explain unresolved structures and propose the English candidate. Use the native compile-preview interface. If it fails, prepare a fresh request for the same paragraph scope and repair within this same turn; do not start another chat, enqueue extra user prompts or apply source changes. An exact successful compile still needs author confirmation. Partial adaptation retains pending author intent and does not imply full draft or review completion.

The existing Codex Desktop chat owns model execution. The plugin owns the paper window, protected requests, durable delivery receipts and validated returns. Explicit UI actions enter that exact chat's official durable queue. Desktop processes them with its current model and history; the plugin does not acquire another writer, resume the chat in a separate model process or require Desktop to release it. Other Desktop chats can continue.

Version 1.3.2 retains the existing native transport and adds backend-derived reference intent to the authenticated paragraph-save path. A model may carry only exact approved standalone citation/cross-reference values in a revision packet; it cannot issue grants itself, edit source labels or promote a source transaction. The historical private save action name is retained for compatibility and still accepts only text plus scoped paragraph/project/snapshot/revision identities. Bibliography/source changes and author undo invalidate obsolete reference candidates. No additional model request is created merely by editing or validating a reference.

The detached local service keeps the window and paper records available. Desktop's background process and the selected paper chat must remain available for queued work to execute. No continuously loaded connection card or manual request copying is needed. Version 1.2.1 verified closed-window queue execution and automatic return with those processes and the paper chat still loaded. That evidence retains its version-specific scope; see [Verification](verification.md) for current-release results.

## Default writing Skills and translation quality

Translation and explicit review messages carry one shared writing-Skills policy. The same Desktop chat selects applicable installed academic writing/translation/polishing Skills from its host catalog and reads their SKILL.md files. Author priorities and exclusions are trusted user intent within the registered task; manuscript, PDF, draft, glossary and imported comments remain untrusted evidence. This does not install Skills, enumerate unrelated private history, invoke unrelated Skill families or expand source-write authority. An unavailable catalog/Skill is reported honestly. Legacy private CodexBridge review paths without host Skill access fail before model work with WRITING_SKILLS_REQUIRE_DESKTOP.

A common translation self-check covers semantic scope, quantifiers, probability guarantees, numbers/units, terminology, complete paragraph coverage, exact protected placeholders and the declared return schema. It runs within the requested turn, without scheduling a second audit conversation. Correct retained TeX is not altered to hide a preview limitation. The backend separately validates object identity, source/draft versions, result coverage and protected content. Ordinary free-form chat remains unchanged.

## Open and import in the same project chat

Enable the plugin in the intended existing project chat and call `bilingual_paper_editor` first. It opens or reuses a normal 16:10 independent window before importing. Supply only paths explicitly provided by the user: `sourcePath`, optional `mainFile`, `reviews: [{path, entry?}]`, and source/target languages. `bilingual_paper_import_files` continues or retries an import in the same window. Supported imports do not need shell extraction, browser-address discovery or file-dialog automation.

Source ZIP, main `.tex` and directory imports create a private editable copy. Repeating the same content-bound import reopens the edited copy without replacing its contents. Review ZIP, recognized bilingual `.tex`, PDF, DOCX, JSON, Markdown and TXT imports retain provenance and deduplicate exact repeats. Multiple qualifying main files or review members return candidates. Review TeX is parsed literally without executing macros. Import itself starts no inference and grants no source-acceptance or undo authority.

An explicit `bilingual_paper_panel` call opens the optional embedded panel. When no source import is supplied, host project authority comes from advertised MCP roots, then a usable native launch directory, then an explicit configured binding. Empty advertised roots do not authorize an old installer project. Multiple main files remain a visible choice.

`WorkspaceService` keeps a stable controller over per-record applications. Its private index retains exact root/main-file and available host-task identities, the verified chat reference and last-opened time. Records have separate source state and two-PDF context directories. History returns a finite recent list without crawling unrelated chats or directories. Switching papers flushes edit buffers and rejects active paper work. Missing files leave a recoverable record.

## Trusted originating identity

Only inherited native `CODEX_THREAD_ID` and, when present, `CODEX_PROJECT_ID` supply host identity. Model arguments, MCP session IDs, arbitrary request metadata and random window IDs cannot become chat identity. Missing identity remains unavailable; opening from the intended Desktop chat establishes it. A deliberately saved different-chat binding is preserved for an explicit choice.

The trusted origin travels through the signed launcher descriptor and exact session health identity. Metadata verification reads only `thread/read` for that fixed ID with `includeTurns:false`. It verifies the existing selection and project directory without loading turns, changing settings or starting a model. Delayed results remain tied to the same application, source snapshot and saved reference.

Native callbacks carry the actual caller separately from model arguments. The private dispatch cache keys both its controller binding and originating chat. A missing forwarded caller cannot inherit the background window's saved origin as authority. The existing callback tools remain strict: a model cannot add a destination, root, UI token or source-application permission.

## Direct native paper operations

Native MCP is the default for an already-open paper. The user can request these operations directly in the bound Desktop chat; Codex does not need Computer Use, browser identification, clipboard copying or a private UI capability. Preparation registers exact work for the current turn rather than enqueueing another message or starting a model worker. Version 1.5.2 adds live editor reads, captured-author-input saving and proof-only stale-draft reconciliation to the earlier eight operations.

| Native tool | Scope |
| --- | --- |
| `bilingual_paper_read_project` | Page the current paragraph index and read paper/language/display identities. Entries contain brief location hints, not the full manuscript. |
| `bilingual_paper_read_paragraphs` | Read the exact requested protected paragraphs and current drafts with complete byte-driven pages and continuation offsets. Private formula history is omitted. |
| `bilingual_paper_read_editor_drafts` | Challenge the authenticated open editor for exact current input, including unsaved/failed-save text and composition status. Continue a large snapshot with its returned `captureId` and `nextOffset`; saved drafts are never substituted. |
| `bilingual_paper_save_editor_draft` | Only on an explicit save request, save that captured author input using its project/snapshot, paragraph/language, `captureId`, `textHash` and `baseDraftRevision`. The schema accepts no replacement text or force flag. |
| `bilingual_paper_reconcile_translation_draft` | Reconcile a saved stale draft only from exact already-confirmed source writeback proof and the current expected draft revision. Text and source bytes are preserved; missing proof/newer drift fails closed. |
| `bilingual_paper_prepare_request` | Prepare selected translation, revision or discussion work and return its registered result-tool instructions. The server binds the invoking chat; the model cannot supply a binding ID. |
| `bilingual_paper_prepare_translation_task` | Prepare the full paper or an explicit selection and return a compact task identity for the existing `get_request`/`submit_translation_result` loop. |
| `bilingual_paper_control_translation_task` | Cancel remaining work or explicitly resume it in the same turn without another queue delivery. Cancellation keeps completed drafts and does not interrupt Desktop. |
| `bilingual_paper_configure_languages` | Set explicitly requested project interface and/or target languages with preference-revision checks. No translation starts automatically. |
| `bilingual_paper_get_display_preferences` | Read the current paper's translation text size and preference revision. |
| `bilingual_paper_configure_display_preferences` | Set an explicitly requested 14–28 px translation text size using project and preference-revision checks. |

Reads and mutations require the current verified originating chat and matching project/snapshot identities. Language, draft and preference checks are repeated at the relevant serialized commit boundary. A stale saved binding cannot override revoked origin verification. Native preparation checks the complete returned packet, including writing-Skills guidance, before persisting a request; an oversized request leaves no unreachable pending authorization. Large translation tasks return a compact identity rather than the complete paragraph-ID array.

Live text is read through an authenticated UI capture, not screen control. The response identifies its capture time, save state, buffer sequence, base draft revision, text digest and composition state. A read does not save, reconcile or authorize a source candidate. A save recaptures and verifies the same buffer and repeats caller/source checks before the actual serialized write. New typing, IME composition, stale source association and draft-revision changes retain the input and reject the save. `EDITOR_NOT_CONNECTED`, `EDITOR_CAPTURE_TIMEOUT` and ambiguous-window errors are reported directly instead of returning a saved draft as if it were current.

The opener and `bilingual_paper_get_state` return model-visible `nativeAccess` guidance and the exact installed transport command. Generic Desktop discussion tickets carry the same native recipe when paper/editor context is needed. A stale host tool catalog can use that current fixed MCP transport in the same inherited Desktop turn; it is not a reason to inspect plugin source, write an improvised client, guess a browser tab or start another model message. A different chat's paper is never used to fill an empty current binding.

Use `bilingual_paper_get_request` and the declared return tool to complete prepared work. Native translation-task packets include the writing-Skills policy and translation self-check within the byte-driven context budget. A changed target language blocks a delayed wrong-language result. Resume captures current unfinished source/draft/alignment context; cancellation remains available after physical source drift. None of these tools expose UI tokens, confirmation capabilities, source acceptance or source undo.

## Translation display preferences

The window's **More → Translation display → Text size** control and the native display tools share a persisted per-project preference. The range is 14–28 px, with 17 px as the default and Reset value. Translation body and caption text share that base; typeset math, paragraph editing, Compare bodies and the Compare final editor scale with it. PDF/source display, third-column notes, anchors and metadata retain their own sizes.

The UI serializes and coalesces preference changes using project identity and setting revision. Older acknowledgments cannot overwrite a newer selection or retarget another paper. Polling adopts verified native preference changes. Failed persistence keeps the current display choice with a retry message; local storage is a fallback, and invalid values fall back to 17 px. Adjusting this display control preserves an active edit and caret without forcing a draft save or sending model work.

## Desktop queue and delivery receipts

`DesktopQueueProducer` uses the official queue API. Its protocol allowlist contains initialization, fixed-thread metadata read, `thread/queue/add` and bounded queue inspection. It rejects thread resume/start, queue start, turn start/steer, model/settings changes and tool execution. The producer's own small protocol process never owns a loaded model chat or a native writer lease.

The installed queue implementation stores requests durably. Desktop's queue watcher notices changes for chats it already has loaded and dispatches input when that chat can run. Pickup can take several seconds. If the chat is unloaded or unavailable, the request waits; reopen that exact chat rather than creating a substitute or stealing ownership. An active Desktop turn and a delivered queue item are distinct states.

Before sending, the producer persists the exact client delivery identity and text hash as uncertain. A verified acknowledgment records the queue identity. Repeated clicks with the same identity do not enqueue another copy. Lost acknowledgments or a crash remain uncertain and are never automatically resent. Read-only reconciliation can recognize an exact still-queued payload; an already consumed request needs explicit verified completion evidence rather than another send.

`DesktopExecution` binds this transport to the active application, paper snapshot and fixed chat reference. Discussion tickets retain the author's message and exact return identity in private workflow state. Source selection requests use `desktop:<threadId>` bindings. Source, chat and application identity are checked around asynchronous operations; a delayed reply cannot silently land in another open paper.

The plugin does not replace Desktop's sign-in or open authentication files. Desktop's own tools and permissions remain governed by Desktop. The plugin's request and result validators are a separate boundary; the untrusted TeX compiler has its own OS isolation.

## Whole-paper and selected-range translation

The user can approve the entire paper or an arbitrary selection of current paragraphs, including ranges such as `1-3, 7, 10-20`. The selection and its work units have no fixed paragraph-count ceiling; serialized context and estimated response sizes determine work units. One UI submission queues one translation-task message to the existing Desktop chat. A direct native `prepare_translation_task` call instead prepares the same loop for the current turn and enqueues no message.

The same Desktop turn repeatedly performs this tool loop:

1. Call `bilingual_paper_get_request` with the registered `translation-task-...` ID.
2. Translate every paragraph in the returned protected batch.
3. Call `bilingual_paper_submit_translation_result` with that batch's exact request ID and complete translations.
4. Read progress and `nextTaskRequestId`; continue until the task reports completed, paused or cancelled.

Each batch includes as many complete records as its serialized context and estimated response budgets permit, including guidance and the next-request envelope; there is no independent item-count ceiling. The returned structured packet includes the protected source, hashes, target language and draft revisions. No paragraph is silently truncated. Batch creation and submission reuse the existing tool names so older native tool inventories can still process the loop.

Completed batches persist before the next batch. Progress identifies total, completed and remaining paragraphs. **Cancel remaining** revokes unfinished returns and keeps completed translations; it does not interrupt another Desktop task. **Resume remaining** is explicit and captures the unfinished paragraphs' current context before a window delivery. Native resume captures that context for the current turn without a new delivery. The controller does not manufacture additional model turns after a failure.

Source, language, alignment and draft changes pause the task before overwriting a changed draft. Exact duplicate returns are idempotent. Formulae, citations and protected objects retain their spelling and order. Translation progress does not alter imported opinions, original baselines, source acceptance or undo records.

## Packaged callback transport

The package includes `dist/desktop-callback.mjs`, a thin MCP client for the already running Desktop turn. It provides current installed tool definitions when a Desktop chat has cached older schemas. It performs no model inference, creates no chat, does not enqueue another message and does not open a UI.

The fixed operations are:

| Callback command | Native tool |
| --- | --- |
| `get <requestId> [offset]` | `bilingual_paper_get_request` |
| `submit` with UTF-8 JSON stdin | `bilingual_paper_submit_translation_result` |
| `revision` with UTF-8 JSON stdin | `bilingual_paper_propose_revision` |
| `reply` with UTF-8 JSON stdin | `bilingual_paper_submit_chat_reply` |
| `state` / `project` | Current status/native guidance or the current paper index; `{}` or empty stdin is accepted. |
| `paragraphs` / `read-editor` | Exact saved protected paragraphs or a fresh live editor capture, using UTF-8 JSON with current paper identities. |
| `save-editor` / `reconcile-draft` | Exact captured author-buffer save or proof-only saved-draft reconciliation. No arbitrary text, force flag or source acceptance. |
| `prepare` / `prepare-translation` / `control-translation` | Current-turn selected work or complete native translation-task preparation/control. |
| `languages` / `display` / `set-display` | The corresponding explicitly requested native paper preference operation. |

The callback derives its current installation root from its own module location and verifies the plugin/package/build versions, absolute regular Node/server paths and server build hash. It inherits Desktop's actual chat identity and working directory; there are no chat, root, endpoint or model override flags. JSON stdin and structured output are bounded to 8 MiB. The optional context offset and the request-bound `batchOffset`, `resultCount`, `finalize` result fields are forwarded without choosing another chat or acquiring acceptance authority. Standard output contains only bounded structured result JSON; private `_meta`, UI capabilities, authentication material and complete private UI state are excluded. Errors return sanitized codes without raw stack traces or source paths. Closing this short MCP client leaves the detached paper service available.

The callback is transport for Desktop's existing inference, not a fallback model worker. Its packaged path can be supplied directly with the approved task, avoiding manual request copying or improvised source-reading helpers. Public task packets include the protected batch in structured results; Desktop-bound regular result callbacks omit the full private `paperState` envelope.

## Human formula intent

The main translation editor exposes formula LaTeX directly in the paragraph text. The author edits prose and math together, with no separate formula panel. The private `saveTranslationDraftWithFormulaEdits` UI action atomically saves the paragraph and its validated human math intent. It requires captured project/snapshot identities, language, paragraph and expected draft revision. Caller-supplied intent/history is rejected; the action is not a model tool. Saving creates no separate model task, and enabled synchronization retains its existing policy. The earlier exact-span formula action remains a private compatibility entry.

The returned draft retains source-pinned formula edits and bounded before/after draft-hash history. Standard paragraph undo/redo uses ordinary draft saves to deactivate or restore matching formula authority. Formula delimiters and environments are retained; replacement math is bounded to 32 KiB and validated controls. Embedded labels, references, citations and tags stay unchanged, and their containing formula cannot be deleted as a whole. Opaque figures, tables and unprovable layout or dynamic content remain outside source-edit authority.

When the author requests an English candidate, the existing Desktop request uses each authorized formula replacement as that token's effective protected value. The original source identity, exact range, other protected objects, current draft versions and active formula-intent fingerprint remain bound to the request. Only an independently proven complete mathematical source interval can add standalone-formula candidate eligibility. The model cannot create authorization by returning different formula bytes or adding its own intent fields.

Retranslation preserves authorized human formula values. A review translation returned for a paragraph with active human math intent is retained historically without replacing the current draft. A source candidate still proceeds through the same existing Desktop chat, validation, exact isolated compilation, human confirmation and separately compiled inverse undo; no new model or worker is introduced.

## Review and source candidates

The original/latest PDF pair is the default review target. Native tools list verified paper artifacts, select original/latest/both/current, return complete locally extracted PDF text and protected paragraph IDs, and validate returned opinions. A user can request all current feedback, selected paragraphs or a free-form answer. Original-only and unconfirmed-candidate feedback can create opinions but cannot overwrite current formal-version translations.

Review requests bind the source snapshot, PDF identities, paragraph scope, language preferences, alignments, glossary and current draft revisions. Changed context invalidates a return. Full reviews replace current model opinions while preserving imported comments; selected reviews leave other paragraphs' model opinions intact. The notes column shows recommended wording, its translation and bilingual reasons without repeating the current bilingual paragraph. Sentence recommendations retain their supplied scope.

Complete PDF text plus paragraph evidence is limited to 2 MiB, with a 1 MiB structured review-result limit. This is separate from translation batching and from 64 MiB review-file uploads, 32 MiB extracted import material, opinion counts bounded by actual extracted bytes and 2,000 PDF pages. Oversized PDF feedback fails as a complete request rather than silently omitting pages. PDF text extraction is not visual inspection of binary figures.

Selected source revisions also reuse `bilingual_paper_get_request`, `bilingual_paper_read_segments` and `bilingual_paper_propose_revision`. Their permission comes from an exact current request: a Desktop return ticket for queued window work, or the verified caller-bound preparation for direct native work. The existing core validates protected objects, hashes, source ranges and current draft versions before accepting a candidate. Ordinary discussion tickets permit only a displayed reply. A validated queued result resolves its private Desktop job; cancellation revokes that owned return ticket without interrupting Desktop's model.

Complex reading ranges receive candidate authority only after an independent literal-range validator proves exact bytes, file hash, snapshot, UTF-8 coordinates and protected structure. A readable projection alone grants no source-write permission. Unsupported lexical changes or unprovable dynamic content remain unavailable for automatic source candidates.

## Compilation and confirmation

`bilingual_paper_compile` compiles immutable confirmed English, a baseline or explicitly selected pending proposals in the isolated compiler. It returns actual build status and artifact/isolation evidence. A successful candidate build is not approval.

Only the authenticated human UI can prepare a short-lived single-use confirmation for an exact compiled transaction and apply it. Undo is a separately reviewed, compiled and confirmed inverse transaction. Model tools cannot apply reviewed changes, write arbitrary source ranges, grant confirmation or undo a transaction. Original-format layout, figures and bibliography are preserved from the supplied source project; compilation does not establish scientific correctness.

The private paper context keeps stable `original.pdf` and `latest-english.pdf` artifacts. The original is frozen, and the latest follows confirmed source. Candidates, intermediate builds, before-images, review history and undo evidence remain outside that two-file context.

## Models, history and compatibility

Desktop's current chat selection is the model authority. Each new Workbench submission refreshes the displayed and saved model/effort through the producer's existing metadata verification before queue delivery. The trusted pre-enqueue callback is not a tool argument and grants no model-setting, chat-writer or source-acceptance authority. Current paper/chat/source identities and required flow/registry persistence are checked before delivery; no duplicate thread-read or extra inference is introduced. The window shows the last verified model and reasoning effort; **Open Desktop chat** opens that exact conversation for changes there. This route does not promise to update Desktop settings through an independent model selector, and model catalog visibility alone does not establish account access. The existing Desktop conversation retains its full history. Private window tickets and task progress remain available on reopening their paper record.

The installer receipt's `desktopProcessRequired: false` describes viewer startup only. `desktopInferenceProcessRequired: true` and `inferenceMode: desktop-existing-chat-queue` explicitly record that model execution requires Desktop's background process and the loaded paper chat.

Opening, importing, selecting, refreshing and verification do not send prompts. Explicit translation/review/discussion actions and synchronization enabled by the user are the delivery triggers. The workbench does not append unrelated requests to the chat.

The older independent-writer adapters and native relay remain compatibility code, with their version-specific evidence retained in [Verification](verification.md). Their writer-handoff, model-settings and historical window-close results are not evidence for the current queue route. Legacy unmarked windows require a one-time manual close; current native windows use verified session ownership and reuse without reload. No process is adopted or stopped merely by its title.

The loopback service enforces exact Host, Origin and private Bearer checks. Model tools cannot obtain a raw session URL or UI capability. MCP client shutdown does not terminate the detached workbench. Private state relies on filesystem access controls; no encryption-at-rest or VM boundary is claimed.

## Native PDF preparation and reconnect limits

When an exact verified original/latest pair has no valid text cache, `bilingual_paper_get_pdf_context` prepares it in the existing fixed local JavaScript reader worker before entering the serialized context section. No reading window, page rendering, browser automation or extra model turn is needed. The worker receives only verified PDF bytes and expected hashes; it disables script evaluation, XFA and optional font/CMap/wasm/network loading. Extraction is complete or rejected: 64 MiB and 500 pages per PDF, with a 2 MiB complete pair-context budget. Missing text requires a readable/OCR source. Current/candidate view authority remains unchanged.

Preparation coalesces the exact pair and permits only one pair read per paper at a time. Before publishing, it rechecks the source, project, snapshot and PDF identities, then uses the existing serial cache validator. Closing the paper aborts pending reads. A 45-second timeout and JavaScript-worker heap limits bound the reader; these are not an OS sandbox or a hard total-memory limit. The separate TeX compiler retains its OS isolation boundary.

Reloading the owned workbench backend and reconnecting the installed MCP transport are distinct from refreshing an already-running Desktop chat's tool catalog. The official `config/mcpServer/reload` method queues a configuration refresh for loaded threads and is not server-targeted. The acceptance host did not expose the control socket required by its proxy, so no Desktop hot-catalog refresh is claimed. Existing registered returns and the fixed native-operation verbs use the packaged current MCP transport in the same inherited host chat when its listed tools are older. Neither path creates an inference process, takes a chat writer or requires Computer Use. Never start a second app-server and describe its configuration as the original Desktop's live tool state.

References: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex CLI queue](https://learn.chatgpt.com/docs/cli/reference), [plugin MCP servers](https://developers.openai.com/plugins/build/mcp-server), and the official [durable queue implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/queue/src/service.rs). Compatibility is checked against the installed schemas and release-specific live receipts; undocumented endpoints are not assumed.
