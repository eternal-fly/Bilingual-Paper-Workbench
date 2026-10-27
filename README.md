# Bilingual Paper Workbench 1.6.4

A local Windows plugin for reading, translating and revising LaTeX papers with Codex. Three aligned columns show the English PDF, an editable translation in reading view, and paragraph-linked notes. Import the original LaTeX project to preserve its document class, columns, figures and bibliography when compiling English revisions.

English is the default interface language. Interface and translation languages are independently selectable from 46 common languages. The light theme uses low-saturation cream and warm yellow accents; dark mode is also available. The left toolbar keeps controls away from the reading area. Notes expand in their own right column without covering the translation.

Read the [User Guide](docs/USER_GUIDE.md), [Codex Integration](docs/codex-integration.md) and [Verification Record](docs/verification.md). The verification record distinguishes release-specific completed and pending checks; this feature list does not substitute for acceptance evidence.

First-party code, documentation and original icons are licensed under [MIT](LICENSE). See [NOTICE](NOTICE), [Security](SECURITY.md), [Contributing](CONTRIBUTING.md) and [Open-source distribution](docs/OPEN_SOURCE.md) for dependency licenses, clean-source setup and the separate privacy-checked source archive. Compiler/font installations and private paper/chat data are not distributed with that archive.

## Install from source (Windows)

The source ZIP and a Git checkout require a build before installation: `dist/` and downloaded compiler/font assets are intentionally excluded. Use Windows, **Node.js 24**, **PowerShell 7**, and a supported, signed-in Codex Desktop/CLI installation. The installer requires the actual `node.exe` and `codex.exe`; put them on PATH or supply their full paths with `-Node` and `-Codex`. A shell shim alone is not the executable path expected by the installer.

Open PowerShell 7 in the extracted source or repository root. Install the package manager version pinned in `package.json`, then the locked dependencies and build:

```powershell
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm build
pnpm validate
```

For English PDF compilation and source writeback, first provide an existing compatible **Windows TeX Live** installation with `xelatex.exe`, `pdflatex.exe`, `xdvipdfmx.exe`, `bibtex.exe`, `kpsewhich.exe` and `fc-match.exe`, the corresponding formats/packages, and Latin Modern OTF fonts. The preparation helper accepts TeX Live's `bin/windows` or `bin/win32` layout; it does not adapt an arbitrary TeX distribution. Ensure the paper's required classes and packages exist in that installation before copying its runtime. The following commands derive its root from the selected `xelatex.exe`, install the private font bundle, then prepare the isolated compiler in the location used by the plugin installer:

```powershell
$ErrorActionPreference = 'Stop'
$TexBin = Split-Path -Parent (Get-Command xelatex.exe -ErrorAction Stop).Source
$TexRoot = Split-Path -Parent (Split-Path -Parent $TexBin)
$PrivateRoot = Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor'
$FontRoot = Join-Path $PrivateRoot 'fonts'
$RuntimeRoot = Join-Path $PrivateRoot 'compiler/runtime64'
./scripts/fonts-install.ps1 -TexBin $TexBin -FontRoot $FontRoot
./scripts/compiler-prepare.ps1 -TeXRoot $TexRoot -FontRoot (Join-Path $FontRoot 'bundle') -RuntimeRoot $RuntimeRoot
```

These helpers download pinned public fonts and copy TeX assets into the private runtime. They do not compile your manuscript or register fonts system-wide. Compiler preparation builds its broker with Windows' .NET Framework compiler and grants read/execute access to the prepared public assets; see [Compiler Security](docs/compiler-security.md). The optional `compiler-install64.ps1` helper downloads its pinned TinyTeX distribution but **expects the font bundle to have been prepared already**; it is not a complete first-machine bootstrap. Do not skip a missing compiler/font prerequisite or replace isolated compilation with an unrestricted TeX command.

Preview the installation, then install and restart Codex Desktop so it loads the plugin and native tools:

```powershell
./scripts/install.ps1 -DryRun
./scripts/install.ps1
```

Use the same explicit `-Node`, `-Codex`, or `-PrivateRoot` arguments in both commands when overriding defaults. If overriding `-PrivateRoot`, also set `$PrivateRoot` to that location before the font/compiler steps above. Without a compiler runtime, the reading window can open, but English compilation and source writeback are not ready. Installation and a source build do not prove a new machine's compiler or host compatibility; open `fixtures/sample-paper/main.tex` and compile that synthetic sample first, then check the imported paper's dependencies. Continue with the first-use workflow below. Development tests and optional browser setup are in [Contributing](CONTRIBUTING.md).

## Get started

1. Enable **Bilingual Paper Workbench** in the intended Codex Desktop chat and provide the paper's LaTeX source ZIP, main `.tex` file or project directory, plus any review files. Ask Codex to open the workbench and import them. The independent window opens first and binds to that same chat.
2. Include the original class, style, bibliography and figure dependencies. Imports create a private working copy and retain the uploaded source unchanged. Multiple main-file choices remain explicit. A PDF alone does not provide editable LaTeX source.
3. Build the English PDF, choose a target language and translate the paper or selected paragraphs. The three columns show the English PDF, translation and current paragraph notes.
4. Click a translation paragraph to edit its full inline TeX. Prose, formulas, citations, labels, macros and environments can be added, changed or deleted. Saved text is retained even while its TeX is incomplete. No content whitelist or protected-object inventory vetoes the default author writeback route.
5. Use notes as advice: inspect suggested wording, its translation and reasons, and choose which changes belong in your draft. Imported or model-generated advice is never adopted merely because it was received.
6. Click **Write back English** once. It saves current input, asks the bound Desktop chat for the corresponding English, compiles the exact result in the isolated compiler, writes the complete authorized scope and updates **Latest English**. This author click authorizes that task; the default route requires no second confirmation.

The task stops on newer typing, changed source or alignment, cancellation, failed compilation or uncertain delivery. It preserves drafts and reports the reason rather than applying an obsolete or partial result. Use the advanced **Revisions** route when you prefer to inspect and confirm a compiled candidate manually. Undo remains a separate compiled inverse transaction.

Use **Export → LaTeX project ZIP** to download the current source and all declared compilation inputs. **Latest English PDF** downloads the verified PDF for the current source. Draft/review/chat state is not included in the source ZIP.

You can also open the installed shortcut and select a saved project. Imported projects use their private working copies; manually opened projects use the selected directory. Repeating an identical import reopens its existing working copy without overwriting edits. Importing alone starts no model request or source write.

The window opens normally from a 1440 × 900 (16:10) baseline fitted to the screen. At widths of at least 1000 CSS pixels, all three columns remain visible. Calls from the same session reuse its verified window and update state without losing the editing position. Different paper sessions remain separate. Legacy unmarked windows require a one-time manual close after upgrading.

## Continue the same Desktop chat

The existing Codex Desktop chat runs the model. After source selection, the workbench verifies the chat that opened it and retains that chat's model, reasoning effort, history and project directory. An explicit window translation, discussion or review action enters that exact chat's durable queue. Desktop executes it and returns results through the plugin's validators. The plugin does not acquire another chat writer, create a replacement model chat, or require Desktop to release the paper chat. Other Desktop chats can continue.

For an already-open paper, ask Codex directly in that same chat to read paragraphs, translate a selection or the whole paper, change the target language, or adjust the translation text size. The native paper tools perform these operations. Codex can page the paragraph index, prepare protected requests and process translation batches within the current turn, without Computer Use, a UI token or another queued model message. Native task cancel/resume also stays in the current turn. The [integration guide](docs/codex-integration.md#direct-native-paper-operations) lists the tools and their scope.

The connection bar shows the chat and its last verified settings. Use **Open Desktop chat** to inspect the conversation or change its model and reasoning effort in Desktop. The plugin displays verified settings; it does not promise to change Desktop settings through its own selector. A saved binding to a different chat is preserved rather than silently replaced.

Keep Codex Desktop's background process, the plugin service and the paper chat available. A queued request waits if Desktop has not loaded that chat; reopen the exact chat to let it continue. No connection card or manual copying of requests is required. Version 1.2.1 verified closing the Desktop window while those processes remained running, followed by automatic reply return and restored history/model on reopening. That receipt retains its version-specific scope in the verification record. Fully quitting the required processes stops execution.

Whole-paper translation is one user submission. Choose the entire paper or paragraph selections such as `1-3, 7, 10-20`. The complete selection has no fixed paragraph count ceiling. Internal work units are chosen by serialized context and estimated response bytes, rather than a fixed eight-paragraph batch. The same Desktop turn repeatedly reads and returns batches until the approved task is complete, paused or cancelled. Progress is retained; **Cancel remaining** keeps completed work. **Resume remaining** explicitly captures the current context before a window delivery, while a native resume continues within the requesting chat turn without another delivery.

Queue acknowledgment, model completion and accepted paper results are separate states. A lost acknowledgment is retained as uncertain and is not automatically resent. Changed source, language, alignment or draft versions pause affected work rather than overwriting a newer edit. The packaged callback transport lets the Desktop turn use the currently installed tool definitions without creating a model worker or requiring an improvised helper.

## Features

- **Original-format English:** revise exact UTF-8 source ranges while preserving unaffected bytes, document class, columns, figures, bibliography and line endings.
- **Free inline authoring:** edit or delete prose, math, citations, labels and TeX structures in the translation. Incomplete input can be saved and corrected; reading mode uses offline Markdown and KaTeX with source fallback for unsupported display constructs.
- **One-click English writeback:** the existing Desktop chat generates English from the exact saved author intent. The controller compiles and atomically applies the authorized result, then publishes the latest PDF. No separate model writer or default confirmation dialog is introduced.
- **Accurate status:** exact applied-source receipts update the paragraph immediately. New edits and undo reopen the appropriate pending state. Physical source application and semantic review/adoption are reported separately.
- **Focused feedback:** the third column shows recommended wording, its translation and bilingual reasons without repeating the current bilingual paragraph. Current opinions appear first; history can be retained or cleared explicitly.
- **Review imports:** import ZIP, recognized bilingual-review TeX, TXT, Markdown, JSON, PDF text/annotations or DOCX text/comments. Original evidence is retained. Unique quotes locate notes; uncertain or multi-paragraph matches remain explicit author choices.
- **Readable workspace:** selectable light/dark themes, 46 independently selectable interface/translation languages, 14–28 px translation text, and PDF fit-width, zoom and panning.
- **Saved paper/chat context:** retain project bindings, drafts, history and the same Desktop chat. The paper context contains the frozen `original.pdf` and current `latest-english.pdf`; intermediate build and undo evidence remain private.
- **Exports and advanced review:** download all current compilation inputs as a source ZIP or the current English PDF. Detailed candidate inspection, manual confirmation and compiled undo remain available in **Revisions**.
- **Optional synchronization:** sentence-end synchronization starts off. Enabling it does not silently authorize a source write; author writeback remains an explicit action.

## Limits and tested scope

Earlier verification includes the original 18-page REVTeX paper compiled with isolated pdfLaTeX, both figures, BibTeX and retained SyncTeX, and the supported bilingual XeLaTeX template. These are tested projects and pipelines, not support for every LaTeX package. Missing dependencies/fonts fail visibly. The default author-click route accepts complete inline TeX without a content veto. Invalid TeX or missing dependencies can still fail compilation; source scope, versions, input manifests and compiler isolation remain enforced.

Review imports allow **64 MiB per file**, **32 MiB of extracted text/annotations** and **2000 PDF pages**, with no independent opinion-count ceiling. Extraction reports progress and supports cancellation. Oversized imports fail as a batch. Scanned PDFs without text require external OCR. A complete PDF-review request has a separate **2 MiB context limit** and **1 MiB structured-result limit**; exceeding it does not create extra automatic requests.

PDF review supplies text and paragraph evidence, not visual inspection of binary figures. SyncTeX offers coarse navigation. Compilation and feedback do not prove scientific correctness. The compiler enforces CPU, memory, wall-time and process limits with sampled output monitoring rather than a hard volume quota. Private state relies on user filesystem access controls; encryption at rest and a VM boundary are not claimed.

See [Data and Source Boundaries](docs/core-boundaries.md), [Compiler Security](docs/compiler-security.md) and [Font Support](docs/fonts-support.md).

## Version 1.6.4: free editing and one-click writeback

An author click now drives saving, English generation in the bound Desktop chat, isolated compilation, atomic source application and the latest PDF update. It authorizes only the captured paper, source, draft and alignment scope. Changed input or a failed stage stops the task; an uncertain delivery is not automatically resent.

The default author route permits all inline TeX edits, including complete paragraph deletion and reinsertion at its retained exact source slot. It does not use formula/reference/layout whitelists to veto content. Translation and review requests outside an author writeback task retain their own scoped result contracts.

Verified current write receipts clear the physical pending state, including compatible older raw-source writes. Semantic review history remains separate: only explicitly adopted concerns with matching source-write evidence can complete. New typing and undo invalidate the appropriate receipt. Split/merged paragraphs use their complete confirmed alignment rather than guessed paragraph positions.

An advanced protected partial adaptation is different: its physical source write can succeed while unfinished author intent remains pending. It does not receive a full author-task completion receipt.

The source export is the full current compilation-input ZIP, with a manifest; the PDF export must match the current English source. Advanced manual candidate review and separately compiled undo remain available.

## Version 1.6.3: coherent authorization and bound-chat editing

The bound chat can inspect declared project source, current reviews and pending candidates; prepare review matching/organization; record review decisions; and edit translation text and supported inline TeX through native tools. Draft edits use exact revisions and prior-text hashes, record the trusted chat actor, and preserve unsaved editor input. Formula, reference, spacing and formatting intent can enter pending English candidates. Source acceptance remains a separate author confirmation after isolated compilation.

Inline protection is applied to provable objects rather than freezing surrounding prose merely because the project contains an unrelated macro definition. Unknown input-consuming TeX retains an explicit protected boundary; it is not executed or guessed safe.

For unfamiliar structures, **TeX source review** offers complete raw candidates over exact current source ranges, rather than a layout whitelist. The bound chat can prepare, propose, compile, inspect logs and repair through MCP. Raw candidates need a checked human review of the full TeX diff before writeback; project inputs and compiler isolation stay bounded. Paragraph identity survives repeat edits and reviewed undo. Unresolved draft intent remains saved separately from confirmed source application.

Translation and synchronization choose one best natural expression while preserving the complete meaning and latest author draft. They do not authorize unsolicited deletions, scientific changes or adoption of review advice. Shared fidelity instructions cover both first requests and later native reads; the compiled candidate still requires author review.

Native request reads and result returns refresh the exact current durable request and Desktop execution ticket, including when an identical binding is reused. A background cache loaded before another process registered a request no longer hides that request or its ticket. Result commits recheck current authorization so a later cancellation or revocation cannot be bypassed by a previously valid read.

Refresh preserves exact paper, snapshot, chat and fingerprint checks. Conflicting, dirty or unreadable workflow state is reported explicitly and is not overwritten. It neither resends a request nor approves source changes. See the [verification record](docs/verification.md) for the separate-process regression and release gates.

## Version 1.6.2: preparation availability and delivery status

Preparing an English candidate remains available while an earlier Desktop request is awaiting its return. Delivery acknowledgment, actual owned model work and validated paper results are separate states. Retained queued messages do not silently hold a global writeback lock. Current execution or uncertain delivery is explained in the request dialog; uncertainty is never resolved by automatically resending a request.

Compilation and writeback still require the complete current candidate and the exact successful build. Source changes require your explicit confirmation. Execution guards are checked again after asynchronous refresh and confirmation preparation. See the [verification record](docs/verification.md) for the tested scope.

## Version 1.6.1: durable drafts and adaptive source review

Authoring and English source authority are separate. Translation paragraphs save the exact bounded author text, including incomplete formulas, unknown keys and unproved structural notation. **Saved** means the draft is durable; a source-review notice does not mean storage failed.

Deleting existing nonbreaking spaces or balanced safe formatting can produce a validated omission candidate despite unrelated project macros. Other unresolved changes remain available to the bound Codex through an exact-draft adaptive request with original source and protected objects. Codex can prepare and compile a candidate in the same chat turn, using a fresh same-scope request if a compile needs repair. It cannot invent file/exec controls or retarget an unproved source invocation. Review and confirm the exact compiled candidate before writeback.

A partial adaptation keeps unresolved author text pending, with no all-applied receipt or completed-review exemption. Repairing the draft restores validated reference/math intent; source/PDF promotion and reviewed undo remain unchanged.

## Version 1.6.0: inline structures and genuine PDF zoom

Translation paragraphs expose inline TeX structures directly, including nonbreaking spaces, escaped literal characters and supported balanced static formatting. Their validated author intent can enter the same protected English-candidate, isolated-compile and confirmed-writeback workflow. Incomplete or unsafe text remains available for correction; typing never grants source acceptance or arbitrary TeX execution.

The English PDF has actual display zoom, fit width, 100% actual size, pointer-anchored Ctrl/wheel zoom and optional hand panning. Scrollbars and keyboard controls remain available. Enlarging the view does not change the PDF or its source, and bounded rendering prevents huge zoom settings from allocating an unbounded canvas.

Editing performance work targets measured repeated source indexing, per-key toolbar work and language scans through manuscript/math content. It preserves live native capture, input-method composition, caret position, undo/redo and save-failure recovery. The release-specific verification record reports measured improvements and their limits.

## Version 1.5.2: reliable repeated editing

Confirmed writeback advances the exact translation draft and its formula/reference source association. Edit that paragraph again, compile another candidate and confirm writeback without inheriting the previous source epoch. Unrelated pending edits retain their intent. Undo and interrupted-operation recovery use exact private transaction evidence and preserve newer human text. A legacy failed draft can be reconciled through the native interface only when retained accepted-writeback records prove its association; unrelated source drift remains a conflict.

The bound Desktop chat can read a fresh authenticated capture of unsaved or failed editor text, including its base revision, composition state and source identity. Native saving accepts only that exact author capture and rechecks it at the actual save boundary. It cannot supply arbitrary replacement text or approve source changes. Supported operations default to native MCP; fixed verbs in the current packaged transport remain available when the Desktop tool catalog is older. Screen scraping and browser-address discovery are unnecessary for these operations.

Status refreshes reuse document derivations and preserve the active editor, caret and input-method composition. **More → Updates** checks public stable releases on a cached 24-hour cadence, supports opt-out and never blocks editing. Review the verified official release before manually downloading and installing it; the plugin does not execute installers or reload an unsaved window automatically.

The opt-in [repeated-editing acceptance](scripts/acceptance-repeated-editing.mjs) generates its own small TeX paper, translations and reviews. It exercises matching, author decisions, repeated isolated compilation/writeback, undo and reopening without selecting an existing manuscript. Fresh release results appear in [Verification](docs/verification.md).

## Version 1.5.1: verify the Desktop model before submission

Change the model and reasoning effort in the bound Desktop chat. Before each new Workbench task is queued, the existing chat-metadata verification refreshes the Workbench display and saved project selection, without a second model request or chat reconnection. A model-default reasoning setting clears the previous saved effort. The displayed value records verification at submission; Desktop remains the authority when the queued turn actually starts.

If metadata or required local persistence cannot be verified, the unsent request retains its content for an explicit retry. Known successful delivery remains acknowledged if a subsequent display refresh fails. Refused source writes retain the manuscript and previous successful PDF; restore the intended file access or release an editor's lock before retrying the same reviewed candidate. Human writeback confirmation and current-source checks remain required.

## Version 1.5.0: complete selections without fixed record counts

Matching, organization, translation, synchronization and revision selection no longer stop at eight, twenty, fifty or five thousand items. Select the complete intended scope once. Short records fit together in one request; larger content is processed automatically in the same bound Desktop chat using context pages and response batches chosen by bytes. Progress identifies the full scope and remaining work. No hidden prefix becomes a complete result.

Native context reads return continuation offsets when needed. Large translation and English-revision outputs can use registered staged parts; only the validated complete result updates drafts or creates the pending proposal. Review organization/matching likewise stages complete root results before publication. Retries retain exact identities and cannot publish twice. Human source-write acceptance remains separate.

Application policy targets 2 MiB context pages, bounds a tool payload to 8 MiB and bounds a stored registered request to 64 MiB. One indivisible protected record may exceed the page target within the tool budget; its packet reports that exception and its actual serialized size. These are local transport/memory budgets, not claims about every model's token window. File provenance, upload/text limits, current-source checks and display pagination remain in place.

## Version 1.4.2: imported opinions follow verified paragraphs

A localized paper edit no longer blocks the entire imported review file. Opinions are checked individually against their linked paragraph hashes. The organizer shows current, changed, missing, ambiguous, unlocated and completed items, and defaults to current opinions. **Recheck against current paper** locally refreshes only associations that can be proved from exact current content. Original import provenance, comments and decisions remain retained. Changed opinions can be reviewed or matched separately through the same Codex chat; organizing their presentation never approves their location or writes the paper.

An opinion adopted by the author and actually written back through a verified source transaction is retained as **Applied · skipped**. Old matching work skips its completed paragraph until explicitly reopened; a preview, failed build or adoption checkbox alone is insufficient. Undo restores eligibility. Reimporting an identical review file after a paper edit reuses its original identities and decisions instead of creating another copy. A genuinely new current-source concern does not inherit an older concern's completion merely because it mentions the same paragraph.

## Version 1.4.1: first-column writeback

The PDF column provides **Write back English** with a visible paragraph count and preparation status. It selects the newest matching candidates for the complete current human-edited draft scope. A ready candidate writes with one author click, without opening the Revisions confirmation dialog. Missing or uncompiled candidates are prepared first; readiness never triggers an automatic source write. Draft/source changes invalidate old candidates. The verified latest PDF replaces the displayed English version after success, while the original and compiled undo remain available.

## Version 1.4.0 project and revision workflow

Choose a saved paper by title from **Project** in the left toolbar. Its PDF, drafts, review notes and verified saved Codex chat travel together. An explicit cross-chat selection moves the existing window to that chat's canonical backend; model inference stays in Desktop. A normal first opening still inherits its invoking chat and trusted project directory, and reopening restores the latest compatible saved record. Missing bindings and ambiguous main files remain explicit choices.

Saved human paragraphs may also add or reorder complete formulas. **Suggest source revision** captures their exact mathematical inventory and displays the original/new formula lists. The model must preserve that inventory and the remaining protected citations and labels. Later draft changes invalidate an obsolete candidate or confirmation; exact isolated compilation and human acceptance still precede a source write.

Successful candidate compilation opens an explicitly unconfirmed PDF preview. After the author confirms writeback, the workbench automatically switches to the verified **Latest English** PDF and updates the original/latest review context. The first-upload original stays frozen. A confirmed undo follows the same handoff; failed or stale builds cannot replace the last successful PDF. Bilingual templates receive a separate English-projection build when the reviewed source build contains both languages.

Saving a translated paragraph and recompiling the confirmed source are separate operations. Use **Suggest source revision** to turn saved translation edits into a pending English candidate, then compile, review and confirm it. No model response or successful compilation can approve its own source changes.

## Version 1.3.2 reference editing

Existing standalone citation and cross-reference commands are editable in the translation paragraph. For example, change `\cite{KEY_A}` to `\cite{KEY_A,KEY_B}` or retarget `\eqref{eq:first}` to an existing label. Keys are checked against the bounded reachable bibliography and literal-label index. The backend derives exact source-pinned author intent from the saved paragraph; a model cannot issue that intent itself. Undo revokes an obsolete candidate's permission.

Command names, optional notes, source label definitions and reference commands nested in a formula retain their protection. A new or ambiguous citation placement can be saved locally without source authority; resolve its source mapping before requesting an English candidate. Unknown, incomplete or unsafe edits keep the input buffer available for correction. Compilation and separate human confirmation still precede source writeback and undo. Final regression passed **904/904 Node tests** and **409/409 browser checks across 34 suites**; the copied-paper native candidate/compile/confirmation/undo also passed. Release evidence is in [Verification](docs/verification.md).

## Version 1.3.1 release notes

- Give translation body and captions one 17 px base, with a 14–28 px size selector and Reset in More. Persist the choice per paper and retain active editing buffers, selections and formula rendering.
- Add eight direct native tools for paginated paper reads, selected request preparation, complete translation preparation/control, language settings and translation display preferences. Native work stays in the current Desktop turn; source acceptance and undo remain human actions.
- Check caller, paper, snapshot, target language and setting revisions at the relevant read or commit boundary. Budget complete native packets before persisting requests, and return compact identities for large translation tasks.
- Repository verification: **877/877 Node tests**, **392/392 browser checks across 33 suites**, and a validator result covering **254 JavaScript files and 20 artifacts with zero external resources**. Installation and live acceptance are recorded separately in [Verification](docs/verification.md); regression results alone do not establish a live model round trip.

## Version 1.3.0 release notes

- Apply relevant installed writing and translation Skills by default in the bound Desktop chat; respect author priorities and exclusions, and report unavailable skills honestly.
- Run a shared semantic and structural translation self-check in the same task, and render equation/split, labels and supported mathematical boxes without rewriting manuscript bytes.

- Edit math directly within the translation paragraph using ordinary LaTeX delimiters, without separate formula controls. Reading mode keeps offline Markdown/KaTeX typesetting.
- Save prose and math together through a project-, source- and draft-pinned human action; retain invalid input for correction and do not infer English writeback authority from ambiguous correspondence.
- Retain citation/structure protection, Desktop-owned inference, safe compilation, explicit writeback confirmation and source undo.

## Version 1.2.2 release notes

- Add explicit formula editing and deletion to the main translation column, with LaTeX preview, cancellation, persistent drafts and undo/redo.
- Bind authored math intent to the exact project, source snapshot, paragraph, original formula and draft revision. Retranslation retains authorized human math; review translations for a paragraph with active math intent remain historical without replacing its current draft.
- Use the human-authorized formula as the effective protected value in an English-candidate request. A whole mathematical source interval is eligible only after independent proof of a complete, exact formula range. Opaque figures, tables and dynamic structures remain read-only for generated source changes.
- Preserve formula delimiters, labels, references and citation keys. Formula replacements are bounded to 32 KiB and validated mathematical controls; source writeback and undo still require the exact compiled candidate and separate human confirmation.
- Saving formula intent creates no separate model task. Candidate generation uses the existing Desktop queue, and enabled synchronization retains its existing user-controlled policy. No additional model worker is created.

Current acceptance and any remaining release checks are recorded in [Verification](docs/verification.md). These notes describe the feature and do not claim a new live Astra run.

## Version 1.2.1 release notes

- Route explicit requests to the existing Desktop chat; Desktop retains model execution and writer ownership.
- Translate the entire paper or arbitrary paragraph ranges through one approved task, with internal protected batches, durable progress, cancellation and explicit resume.
- Return translations, source candidates and discussion answers through exact chat/request tickets and existing source, placeholder and draft-version validators.
- Include a small installed callback transport for current MCP tool definitions; no manual request copying, replacement model chat or source inspection is required.
- Inherit model and reasoning settings from Desktop; open that exact chat to change them there.

Current acceptance is recorded separately below and in [Verification](docs/verification.md). Historical release results retain their original scope.

## Version 1.2.0 release notes

The 1.2.0 connection-handoff behavior described here is historical; 1.2.1 uses Desktop-owned execution.

- Automatically verify and bind the chat that opened the workbench once paper source is ready, retaining its model, reasoning effort, project directory and history.
- Show automatic connection progress and writer contention without a manual `CHAT_BINDING_REQUIRED` step. Preserve an explicit different-chat binding and keep advanced overrides explicit.
- Reuse one verified native window for repeated, parallel and cross-process calls to the same session. Imports update state in place; closing the window still permits reopening.
- Keep binding and window management separate from model prompts, source acceptance and undo. See the verification record for live-test limits and the completed release gates.

## Version 1.1 release notes

- Open the independent window before discovering/importing a paper; an unbound first-use task no longer requires an already-open project.
- Import explicitly supplied source and review files through native plugin tools into the same background window, with candidate selection and repeat-import deduplication.
- Preserve supplied source archives/directories through private editable copies; import starts no model turn or approved source revision.
- Show suggested wording, translation and reasons without repeating the current bilingual paragraph; preserve formula rendering, note identity and decisions.
- Correct first-use English help, backend status and narrow-toolbar word wrapping. Model tools address the active window's background state.

These describe the implementation. See [Verification](docs/verification.md) for the current release's recorded checks; a missing receipt remains unverified.

## Version 1.0 release notes

- English-first product naming/documentation, selectable languages, three-column reading, normal window placement, and light/dark themes.
- Paper-scoped background chat, saved exact-thread binding, recent history and acknowledged model/effort selection.
- Original-format English compilation, protected translation editing, full bilingual paragraph recommendations and import management.
- Strict API review schemas with explicit nullable optional values; domain and external-import validation remain strict.
- Isolated candidate compilation, explicit writeback and separately confirmed undo remain mandatory.

The [Version 1.0.0 Release Acceptance](docs/verification.md#version-100-release-acceptance) remains historical evidence with its original scope; it is not a substitute for current-release verification.

## Development and local installation

Follow [Install from source](#install-from-source-windows) for dependencies, compiler/font prerequisites and first installation. The following checks assume the locked dependencies are already installed:

```powershell
node scripts/build.mjs
node scripts/validate.mjs
node scripts/icons-verify.mjs
node --test test/*.test.mjs
./scripts/install.ps1 -TargetFile 'C:/path/to/main.tex' -DryRun
```

Review the dry run before an authorized installation without `-DryRun`. `-NoShortcuts` skips Desktop/Start Menu shortcuts. `-PreferredModel` and `-PreferredEffort` remain compatibility configuration; the current Desktop-owned route inherits the existing chat's actual selection. `scripts/launch-workbench.ps1` is the independent entry; `launch-preview.ps1` remains an alias. `-NoOpen` starts/checks the service without opening a browser or printing its private capability URL.

The installation receipt distinguishes the viewer from model execution: `desktopProcessRequired: false` applies to opening the saved reading window; `desktopInferenceProcessRequired: true` and `inferenceMode: desktop-existing-chat-queue` require running Desktop for translation, discussion and feedback.

Installation uses absolute runtime paths. Drafts, history, manuscript data, compiler assets and fonts stay outside the package. `dist/build-manifest.json` records hashes; dependency notices are in `dist/THIRD_PARTY_NOTICES.md`. Browser checks use synthetic repository fixtures. The SVG/PNG/ICO icon contains no paper content. Local installation does not publish the project; MIT and the applicable third-party licenses govern redistribution.

Synchronization interaction was informed by [Sync-Writer](https://github.com/observerw/sync-writer). Host integration follows installed Codex schemas and documented [App Server](https://learn.chatgpt.com/docs/app-server), [plugin extensions](https://developers.openai.com/plugins/build/extensions) and [plugin packaging](https://developers.openai.com/plugins/build/plugins).
