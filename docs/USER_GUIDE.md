# Bilingual Paper Workbench — User Manual

**Version 1.6.2 · Windows · English edition**

Bilingual Paper Workbench connects an English LaTeX paper, an editable translation and paragraph-linked review notes in one workspace. Your existing Codex Desktop chat performs translation and review; the workbench provides the reading, editing and confirmation interface. English is the default interface language. The translation language is a separate choice.

## Install once before opening your first paper

If the plugin has not been installed, follow [Install from source (Windows)](../README.md#install-from-source-windows). The public source archive requires the locked Node dependencies and a build; it does not contain a preinstalled TeX runtime or downloaded fonts. Use PowerShell 7, Node.js 24 and a supported signed-in Codex Desktop/CLI installation. Prepare the private fonts before the isolated compiler, preview and run the plugin installer, then restart Codex Desktop to load its tools.

An existing compatible Windows TeX Live installation is a compiler prerequisite for that documented setup path. Opening a reading window does not establish that compilation is available. First compile the included synthetic sample, then verify the classes, figures, bibliography and fonts of your own project. Do not compile imported manuscript code outside the isolated workbench worker to work around a setup failure.

## Recommended first-use workflow

**Upload the LaTeX source → translate with one action → generate and inspect a review file → import the review → revise selected paragraphs → compile and confirm.**

### 1. Open a paper chat and upload the original LaTeX project

1. Open a Codex Desktop chat in the paper's project. Enable **Bilingual Paper Workbench** in that chat.
2. Attach the original LaTeX source ZIP, or supply the full local path to its main `.tex` file or project directory. Include the document class, custom style files, bibliography and figures. A PDF alone cannot supply editable LaTeX source.
3. Ask Codex: “Open Bilingual Paper Workbench and import this LaTeX source project.” Specify the main file if the archive contains several possible main documents.
4. The normal 16:10 workbench window opens before import. Import updates that window; repeated calls reuse the same tracked session rather than opening another page.
5. Check the project name, main file and bound chat. A workbench opened from a chat inherits that chat and its project context. Choose **GPT-6 Astra** and your preferred available reasoning setting in the chat/model controls if necessary.

Source ZIP imports create a private working copy and retain the supplied archive. Reimporting the same source reopens that working copy with its saved edits. Opening a directory manually with **Project** uses the exact directory you select; check this location before confirming a later source write.

### 2. Build the English PDF and translate the paper

1. Select **Build English PDF**. The workbench compiles the project's main source with its original template, figures and bibliography.
2. Open **Language** and choose the target translation language. Changing the interface language does not change the translation target.
3. Open **Translate**, choose **Entire paper**, then select **Translate entire paper** once. For a smaller task, choose the selected paragraphs or enter paragraph ranges such as `1-3, 7, 10-20`.
4. Codex processes the approved scope in the same Desktop chat. Translations appear paragraph by paragraph in the middle column, with progress and saved draft state.

There is no fixed paragraph or opinion count limit on the complete selection. Work units depend on actual serialized size and estimated response size; you do not manually split your selection into groups of eight.

You can also ask Codex in the same paper chat: “Translate this entire open paper into French,” or “Translate paragraphs 3–7.” Codex reads the current paper and processes its protected batches within that existing turn. This direct route needs no Computer Use, window clicking or additional queued message. Ask it to cancel or resume the remaining scope when needed; completed translations remain saved.

### Read the request status

**Prepare English changes** saves your current edits and opens a request preview. This local preparation does not send another model message, compile a candidate or write source. Earlier acknowledged messages awaiting a return do not silently disable it. If a real paper operation or source write is active, the interface explains why the next execution step must wait.

Delivery and result status are distinct. An acknowledged delivery means Desktop accepted the request; it does not prove that the model finished or that a valid result reached the paper. The workbench distinguishes active work, waiting for a return, validated completion and uncertain delivery. It does not infer success from elapsed time or automatically resend an uncertain request. Keep the bound Desktop chat available and inspect that chat when a result has not returned.

Once Codex returns the complete current English candidate, compile it and inspect the PDF. Click **Write back English** to confirm that exact candidate. The latest PDF then updates automatically. A new edit requires a new current candidate; it does not require redoing unaffected translations.

### 3. Generate a review file before importing it — recommended

For a substantial review, first ask Codex in the paper chat to produce an inspectable review document. For example:

> Review the original and latest English paper using the applicable installed academic writing skills. For each concern, give a stable code, a paragraph quote or location, suggested English wording, its target-language translation, and reasons. Preserve mathematical meaning, formulas and references. Save the result as Markdown or structured JSON for import into Bilingual Paper Workbench.

Read the review file before importing it. Markdown or structured JSON is convenient for explicit fields; a PDF or DOCX review can also be imported. Providing a paragraph quote improves automatic correspondence. A review is a set of suggestions, not an instruction to apply every change.

Select **Import review file**, choose the generated document, and select **Parse & import notes**. Codex can also import an explicitly supplied review path from the chat. Identical imports are deduplicated.

The workbench supports TXT, Markdown, JSON, PDF and DOCX review documents, plus supported structured TeX review material. A file can be up to 64 MiB; extracted text can be up to 32 MiB, with at most 2,000 PDF pages and no separate opinion-count ceiling. Inputs exceeding a byte or page budget are rejected with an explanation rather than partially imported without notice.

Unique literal matches link automatically. Ask Codex to organize or locate remaining imported opinions using the supplied source context. Uncertain matches remain available for confirmation; one opinion can relate to several paragraphs when its concern genuinely spans them.

### 4. Alternatively, generate opinions inside the workbench

Select a paragraph and choose **Review paragraph**, or open **Codex review** and choose the PDF target and scope. Use **Additional instructions** for review priorities. Turn translation updates off if you want opinions only.

The default is feedback for the latest approved scope. You can request one paragraph, several paragraphs or the full paper. The model returns suggestions and reasons to the third column; permitted translation results go to their corresponding middle-column paragraphs. Ordinary discussion can remain a free-form conversation and does not have to create opinions.

## Understand the three columns

| Area | Purpose |
| --- | --- |
| Left: English PDF | Read the frozen original, latest confirmed English version, or an explicitly selected candidate preview. English builds preserve the LaTeX project's original layout. |
| Middle: translation | Read typeset text and formulas, select a paragraph, or edit its translation and inline LaTeX. Draft edits do not immediately change English source. |
| Right: paragraph notes | Read the current suggested English wording, its translation and reasons. Selection follows the middle-column paragraph. The notes stay in their own column. |

Use the left toolbar for projects, source inspection, history, outline, language, theme, translation, synchronization, discussion and revisions. The light theme uses subdued cream and warm yellow; the dark theme is separately selectable. The window is resizable and opens normally rather than maximized by default.

## Magnify the English PDF

The PDF controls change the view, not the PDF file. **Fit width** initially fits the page to its column. Choose a percentage or use **Zoom in / Zoom out** to inspect a region; **Actual size** returns to 100%. **View options** provides an exact percentage from 25% to 400%.

Use Ctrl+wheel or a trackpad pinch over the PDF to zoom around the pointer. To move a magnified page, use its scrollbars, hold Space while dragging, use the middle mouse button, or enable **Hand tool**. Ordinary scrolling remains ordinary scrolling. When hand mode is off, a normal click still locates the corresponding source; dragging does not submit that click.

Keyboard operation and scrollbars remain available without dragging. Zoom and pan preserve the current PDF identity and page coordinates. Returning to fit width adapts to a resized column. Visible zoom and rendering resolution are separate: very large views use a bounded canvas rather than allocating an unbounded bitmap.

## Adjust the translation text size

Open **More → Translation display → Text size**. Choose any size from **14 to 28 px**; the default is **17 px**. Select **Reset** to restore 17 px. Body paragraphs and captions use the same base size, while headings retain their relative hierarchy.

The choice scales middle-column reading text, rendered formulas, inline editing, Compare text and its final-candidate editor. It leaves the English PDF zoom, third-column notes, paragraph metadata and other controls unchanged. You can adjust it while editing: the current buffer and selection remain in place, and the display action does not force a draft save or synchronization request.

Each paper remembers its own size when reopened or selected from History. You can also ask the bound Codex chat, for example, “Set this paper's translation text to 22 px.” If a project preference cannot be saved, the size still applies in the current window and the control explains how to retry. Invalid or unavailable local preferences fall back to 17 px.

## Edit prose and formulas together

Click a translation paragraph or press Enter. Its text and formulas become editable in the same field:

```tex
The estimate holds for $n\ge 2$ and $M\ge 1$.
```

Change the prose, modify the formula source, or select and delete a complete formula directly. You do not need an insert-formula command or a separate formula panel. Select **Done**, leave the field, press Escape, or use Ctrl+Enter to save and return to reading. Ctrl+Z undoes; Ctrl+Y or Ctrl+Shift+Z redoes.

Reading mode uses offline Markdown and KaTeX. Supported equation/split environments, static project macros and mathematical boxes are typeset. Labels stay in the underlying source but are hidden in reading view; displayed equation numbers come only from verified auxiliary data. The preview never invents numbering.

A complete inline formula inside a math-only `\mbox` displays without the TeX wrapper. Balanced `\texorpdfstring` headings show their display branch. These are reading projections: the editable text, references and source bytes stay intact. Incomplete or unsupported formatting remains visible for inspection.

For English source authority, labels, references, citations and equation tags inside math remain fixed. Raw author drafts can retain their edits as source-review input. You can edit the mathematical body around them, but cannot delete their containing formula as a whole. Individual mapped edits retain their delimiter/environment type and are limited to 32 KiB of validated math syntax. The full-paragraph inventory described below also permits complete added or reordered formulas, while retaining the original boundaries of any formula containing fixed labels or references.

An incomplete expression, such as `$x^`, now saves as exact author text with a **Source review required** notice. It can reopen safely and remains available to Codex; it does not grant that malformed math permission to change English source. Complete or adapt it before the corresponding source edit. Actual storage, permission, version or connection failures remain **Save failed** and retain retry/export controls.

Uniquely mapped changes to existing formulas can become English revision intent. If your saved human paragraph adds or reorders complete formulas, **Suggest source revision** captures the paragraph's exact new mathematical inventory instead of guessing old-to-new formula matches. Review the **Original formulas** and **Requested formulas** lists. The model must use that complete inventory, preserve citations and labels, and return a pending English candidate. Added formulas still require a successful candidate compile and your final confirmation. Incomplete, unsafe or structurally ambiguous TeX remains unavailable for source changes; AI-generated drafts cannot grant themselves this authority.

## Edit citation and cross-reference keys

The same paragraph editor accepts existing standalone citation and cross-reference commands as inline LaTeX. You can change or delete them, add an existing bibliography key to a citation list, and undo or redo the change:

```tex
\cite{KEY_A,KEY_B}
\ref{fig:overview}
\eqref{eq:bound}
```

The supported commands are `cite`, `citep`, `citet`, `citealp`, `citealt`, `citeauthor`, `citeyear`, `ref`, `eqref`, `pageref`, `autoref`, `cref` and `Cref`. Choose keys already declared unambiguously in the paper's reachable bibliography/source files. Bibliography keys and label keys are checked separately. An unknown, incomplete, dynamic or ambiguous target is saved as author text with a source-review notice. Codex can review it against the original protected inventory, while the unresolved key cannot retarget English source. Repairing a valid known reference restores its validated intent.

This release accepts literal ASCII keys up to 128 characters, using letters, digits, `_`, `.`, `:`, `/`, `+` and `-`. Case-colliding bibliography entries are treated as ambiguous; label names remain case-sensitive.

This reference-editing scope retains command names and optional notes. Label definitions such as `\label{eq:bound}`, numeric citation display atoms and references inside formulas retain their source-validation rules. Inline structures have their own editable scope below. A newly inserted or ambiguously mapped reference can be saved as a local draft without permission to change English source; the workbench explains when source mapping must be resolved.

For a proven existing occurrence, the backend records your exact reference change as source-pinned author intent. Request an English candidate, review it, compile that exact candidate and confirm writeback. The model must retain all unedited formulas and references. Undoing the draft change revokes pending source authority; undoing a confirmed source change still needs a separately compiled inverse and confirmation. Later model translation/review output preserves active author reference edits rather than overwriting them.

## Edit inline TeX structures

The translation paragraph editor displays structural notation as text rather than forcing generic **Structure** chips. Edit spacing and formatting alongside prose, formulas and existing references:

```tex
Section~3.1 and \textbf{the main result}, with a literal 10\% value.
```

Supported source-revision intent includes nonbreaking spaces and safe spacing controls, escaped literal characters, and balanced static formatting such as `\emph{...}`, `\textbf{...}`, `\textit{...}`, `\textnormal{...}`, `\textrm{...}`, `\textsf{...}`, `\texttt{...}`, `\textsc{...}`, `\underline{...}` and `\mbox{...}`. The backend derives this intent from your exact saved paragraph and current source, alongside its formula and reference checks. The model must retain the exact authorized inventory in its English candidate.

Source grants remain bound to captured project dependencies. Deleting existing safe inline notation does not require a blanket proof that every project macro is standard. New or genuinely rebound controls receive source review; surviving risky calls and unknown-arity ranges retain their complete original bindings in the candidate. Raw authoring remains available in every case.

Being able to type and save a command does not make it a valid source edit. Incomplete wrappers, labels, environment boundaries, file controls and unknown macros are retained durably as raw author text, with source-review diagnostics. They are not forced browser chips and cannot execute through draft saving. Only an actual failed save requires retry/export before closing.

Generate the corresponding English candidate through the bound Codex chat. For a source-review draft, Codex receives the exact saved text, original source and retained protected objects. It can adapt wording/formatting and compile a pending candidate through native tools, repairing a failed candidate within the same turn. Review the resulting English and confirm **Write back English** as usual. Repeated confirmed writes update the draft's association with the new source. Model translation/review output cannot silently overwrite pending structural author intent. A partial source adaptation leaves unresolved text pending after writeback and does not mark an adopted concern complete. Repair or explicitly review that remaining intent; an older receipt cannot hide it.

## Default writing Skills and translation checks

Translation and explicit review requests ask the **same bound Desktop chat** to select applicable installed academic writing, translation and polishing Skills by default. The model must read each selected `SKILL.md` before applying it. It does not automatically invoke every installed Skill or activate unrelated memory, health or software-development workflows.

Use **Additional instructions** or the ordinary chat to state priorities, exclusions or a request to disable a Skill. For example, if installed:

> Prioritize `$fei-personal-write-skills` for academic wording. Preserve my theorem scope and argument order. Focus this review on terminology and transitions.

The workbench does not install Skills or change global Desktop settings. If the host catalog or a required Skill is unavailable, that limitation must be reported honestly. An older private model bridge without host Skill access asks you to use the bound Desktop route; it must not claim to have applied a Skill.

Before returning a translation, Codex performs a built-in check within the same requested turn: complete paragraph coverage, target language, terminology, conditions and quantifiers, negation, probability guarantees, numbers/units, sentence completeness, formula/reference placeholders and valid output structure. Protected English identifiers are not treated as missed translation. Correct retained TeX is not rewritten merely to work around a display limitation. The backend separately validates IDs, protected objects, versions and result scope.

This check does not schedule an additional review conversation. It also does not replace the author's assessment of scientific correctness.

## Turn an edited translation into confirmed English

1. Finish editing and save your translation paragraphs, including complete formula or citation changes.
2. Generate the corresponding English candidates through the bound Codex chat and inspect their proposed wording. The first PDF column now provides **Write back English** and shows how many current changed paragraphs are covered.
3. If an exact successful compilation is still missing, click the button to prepare the candidate preview. Review that PDF when it is ready. Compilation alone does not write the source.
4. Once the complete current candidate is ready and you have reviewed it, click **Write back English**. This direct author action confirms the exact compiled candidate, updates the English LaTeX and switches the first column to **Latest English**. No additional checkbox or visit to **Revisions** is required.

If a changed paragraph has no current English candidate, the entry opens the existing revision request flow for that missing scope. It never silently applies a partial selection or uses an obsolete proposal. Draft edits, source changes or a project switch invalidate the old candidate. Keep the workbench open until it reports the result; repeated clicks while busy cannot create another write.

The original uploaded English PDF stays frozen for comparison. If the source uses bilingual layout that differs from the English projection, the workbench builds that projection before publishing the latest English PDF. Compilation or write failure preserves the previous successful PDF; inspect **Log** and the visible status before retrying.

The detailed **Revisions** route remains available for inspecting individual differences, mathematical inventories and exact build identity. Translation saves, model responses and polling never approve source writes. Only the author's explicit ready-button click or detailed confirmation does so.

To undo a confirmed source change, choose **Create undo proposal** in **Revisions**. The inverse is independently compiled and requires its own confirmation. **Latest English** then switches to the verified restored version. This is separate from Ctrl+Z in an uncommitted translation draft.

## Choose the PDF and feedback scope

Use **Original**, **Latest**, **Original & latest**, or the explicitly displayed verified artifact. The normal paper context uses the frozen original and latest confirmed English PDF. A candidate preview is not the latest adopted version.

Original-only and unconfirmed-candidate reviews can return opinions but cannot replace current formal-version translations. Request paragraph-specific or full-paper feedback in the chat as needed. The model may identify an uncertain/global concern without pretending to have located it precisely.

Current notes are shown by default. Open **History** in the notes controls to inspect retained older model suggestions. **Manage** controls future history retention and previews an explicit history cleanup. Current opinions, human comments and formal revision/undo records are separate from removable historical model notes.

In the review-import dialog, **Withdraw notes** hides an imported file's opinions and keeps them recoverable. **Delete** has a separate preview and confirmation. Removing the imported record does not delete your original uploaded review file.

## Continue editing after a confirmed writeback

After **Write back English** succeeds, **Latest English** and its source identity update together. The translation used by that exact accepted revision keeps its text and receives a saved revision associated with the updated source. Click the same paragraph and continue editing; repeat the candidate, isolated compilation and confirmation cycle as needed. Editing another paragraph does not adopt its pending changes.

Undo is another compiled and confirmed transaction. It restores only an exact matching prior draft state; newer author text remains available for review. A source change outside the verified transaction history is not automatically treated as an accepted translation change.

## Read or recover unsaved input through Codex

In the bound Desktop chat, ask: “Read my current unsaved translation input through the native workbench interface.” The live-editor tool returns a fresh authenticated capture with its paragraph, exact text, save state, draft revision, source association and composition state. Saved paragraph reads and live-editor captures are distinct. Missing, closed or ambiguous editors produce an explicit status instead of a guessed browser window or substituted saved text.

If you request saving, Codex can save only that exact captured author text. The backend recaptures and rechecks it at the save boundary. Newer typing, active input-method composition, source changes or refused persistence preserve the editor and report the conflict. Reading does not save, enqueue a model request or write English source.

For a legacy stale draft left by an older confirmed writeback, ask Codex to reconcile that paragraph with its confirmed writeback history. This changes association metadata only when the retained transaction and captured draft prove it exactly. It cannot force a match for newer or ambiguous intent. After successful reconciliation, read the live editor again before saving. Keep or export unresolved input rather than discarding it to bypass validation.

If the Desktop tool catalog is older, use the current packaged MCP transport identified in the workbench's native-access instructions. It retains the inherited chat and exposes fixed paper operations. Supported reading and saving require no Computer Use, browser-address discovery, extra model worker or replacement chat.

## Check for plugin updates

Open **More → Updates** for the installed version, check status and available stable release. Automatic checks use the fixed public GitHub repository and a cached 24-hour cadence. No manuscript, draft or chat data is sent. **Check now** retries explicitly; the checkbox disables automatic checks. Offline, rate-limit and update-cache errors do not block editing or compilation.

Choose **Review update** to inspect its official version, runtime ZIP name, size and SHA-256 metadata. Only **Open official release** opens GitHub. Download and verify the package, save or export open editing buffers, and confirm installation yourself. This version never automatically downloads or executes new runtime code, changes a model or reloads an unsaved window.

## Change models in the bound Desktop chat

Select the model and reasoning effort in the paper's existing Desktop chat. No second model selection or chat rebind is needed in the Workbench. Every new task submission verifies that exact chat's current settings, updates the Workbench display and saves the project selection before queue delivery. This reuses the normal metadata check and does not send an extra model prompt. A default reasoning setting clears an earlier explicit effort.

The displayed model is the setting verified for that submission. Desktop controls execution when a queued turn starts; changing models later does not rewrite the earlier verification record. Metadata verification or required local-save failures stop before delivery and retain your request text for an explicit retry. A lost delivery acknowledgement remains uncertain and is not automatically resent. A later display-refresh failure cannot turn an acknowledged successful send into a second delivery.

## Recover from refused writes

If draft or project-record saving is refused, keep the window open and retain or export the editing buffer. Resolve the destination's intended write access and use the visible retry action. Do not recreate the paper or submit the same task repeatedly to bypass the error.

If source writeback is refused, the existing English source and previous successful PDF remain available. A read-only source and another editor's file lock are different conditions: restore the intended source access or release the external lock, then retry the same reviewed candidate if its source version is still current. Source drift requires a fresh candidate/compile. The Workbench does not force file permissions, bypass protected objects or treat a refused write as applied.

An interrupted multi-file commit can require recovery after an earlier file was durably written. The Workbench reports a partial/recovery-required state rather than success. Retain its transaction journal and use the exact recovery path; do not overwrite the files or start a competing candidate to hide that state.

## Select complete scopes and follow automatic progress

Select every opinion or paragraph you want to process, then prepare and send once. The matching, organization, translation, synchronization and English-candidate flows have no fixed item-count ceiling. Small records are grouped together; longer records automatically use more context pages or response batches in the same bound Desktop task.

The progress display retains the total selected scope and completed/remaining work. A large review response is staged until its complete selection validates. Large native translation or revision output can also be staged before publication. Returning an early part does not mark the request finished, overwrite part of a draft, or accept source edits. Identical retries cannot duplicate the final result.

If model context arrives in pages, Codex follows the exact continuation offsets and request identity. No paragraph or opinion is silently truncated to fit a page. You can still choose a smaller scope when that suits your writing task; manual groups of eight are unnecessary.

The application retains byte and file budgets: a 2 MiB context-page target, 8 MiB tool payloads, 64 MiB registered request storage, 64 MiB uploaded files and 32 MiB extracted review text. One indivisible protected record may exceed the page target within the tool budget, with an explicit exception and actual-size metadata. These are transport and memory controls, independent of the number of selected items. A single indivisible protected object exceeding the transport budget remains retained with an explicit error. Model availability and output capacity still apply.

## Keep imported opinions usable after revising the paper

An imported review file keeps its original source version as provenance. After you write back a paragraph, the workbench checks each opinion's linked paragraph hashes. An unchanged paragraph remains usable even when another part of the paper changed. A stable paragraph ID alone cannot validate changed text.

Open the imported-file organizer to see current opinions and items needing recheck. Its scope filter defaults to current opinions; choose the other filters to inspect affected items or explicitly organize the complete file. Counts and item labels show what will be included. No opinion is deleted or silently omitted from the retained import.

Use **Recheck against current paper** to update proven associations locally. It sends no model request and never changes paper text, translations, review decisions or the original uploaded file. Exact unchanged links can be refreshed; an absent identifier can be relocated only when its exact content has one verified current match. Changed or ambiguous paragraphs remain marked for review.

Use the existing Codex matching action when an affected opinion needs context-based relocation, or confirm its paragraph manually. Only an explicitly prepared request is sent to the bound paper chat. Ambiguous and cross-paragraph concerns remain choices for the author rather than guessed locations. A prior adoption decision stays recorded against its original version; it is not automatically renewed for changed evidence.

Opinions with both explicit adoption and a successful matching source write are retained under **Applied · skipped**. Their completed paragraphs are excluded from subsequent old-review matching and organization by default. Open the completed view and explicitly reopen an item when you want to review it again. Adoption without writeback, preview-only compilation, a failed transaction, an unrelated edit or an undone write does not complete that opinion. The completion proof binds the exact source changes and author decision, rather than assuming any edited paragraph is finished.

Importing the same unchanged file after another paper edit reuses the existing imported opinions, source provenance and decisions. A withdrawn import stays withdrawn. A different file or genuinely new current-source concern is kept separate; completion is inherited only with verified old-concern evidence, never just a reused paragraph number or review code.

You may explicitly organize an affected or unlocated opinion against the supplied current context. Its original wording remains historical evidence and its source-validation status stays visible. A newly organized suggestion is presentation only: it cannot silently validate the raw opinion's anchors, accept a change, replace the translation or write the LaTeX source. Changed requests or context still invalidate delayed results.

## Synchronization, chat and saved projects

Sentence-end synchronization starts off. When enabled, it uses the same Desktop chat, current paragraph alignment and glossary. Translation-to-English synchronization creates a pending candidate; English-to-translation synchronization updates only validated corresponding drafts. It never confirms a source write automatically.

**Cancel remaining** stops application of unfinished translation batches and keeps completed drafts. It does not interrupt unrelated Desktop work. **Resume remaining** is an explicit action after reviewing the current source, language, alignment and draft state. An uncertain delivery is not automatically resent.

Window requests use the paper chat's queue. Direct requests made to Codex in that chat use the current turn instead: it can read the paginated index and exact selected paragraphs, prepare translation or revision work, control a translation task, and change the paper's language or text-size preferences. These operations do not confirm source writeback, create another model worker or change global Desktop settings.

Native PDF review also works when the reading window is closed. The backend verifies the original/latest PDF artifacts and prepares their complete text in a bounded local JavaScript worker when no valid cache exists. It does not execute PDF actions, render pages or fetch external resources. Text extraction is limited to 64 MiB and 500 pages per PDF, with 2 MiB for the complete pair context. A page without extractable text requires a readable source/OCR result; partial text is not described as a complete review. Figure coverage remains PDF text only.

The workbench does not take over the chat writer in another model process. You can use other Desktop chats while the bound paper chat handles a request. The visible Desktop window can be closed while the required background services and loaded paper chat remain running; fully quitting those processes is outside that connected-window workflow.

Use **Project** in the left toolbar to choose a saved paper by title. Each entry identifies its source and saved chat. Selecting one loads that paper's latest PDF, drafts and notes and routes subsequent requests to its verified saved Codex chat. An explicit cross-chat choice uses the same window and the target chat's existing backend; it does not create a new model conversation. If its chat has not been verified, connect it explicitly first. Identical titles remain separate records, distinguished by their source and chat details.

Use **History** to inspect earlier records and **Manage projects** to import or open sources. Finish active saves and model/compile operations before switching projects; failed saves keep the current paper open. A normal invocation defaults to its invoking chat and current trusted project. Reopening uses that task's latest compatible saved state, while an explicit project selection restores the selected paper and its saved chat. Missing project files do not justify overwriting a different paper's state.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No editable project | Supply the original LaTeX source project, select its main file and include dependencies. A PDF is a reading artifact, not reconstructed source. |
| Chat unavailable | Open the paper's existing Desktop chat and workbench; check its displayed identity/model and required background services. Do not create a replacement chat merely to retry. |
| Selected project already has an open window | Use that paper's existing workbench window. The selector keeps the current project intact rather than creating a duplicate or replacing another window's unsaved editing state. |
| A formula remains source text | Check the complete delimiters, current macro definitions and source/context version. Unsupported dynamic TeX stays readable as source. Do not delete labels or mathematical content to hide the warning. |
| Source review required | The exact draft is saved. Ask Codex to adapt an English candidate, inspect retained source objects and resolve any remaining intent before final source approval. |
| Save failed | Storage, permissions, connection or draft identity prevented saving. Keep the input and retry or export it before closing. |
| Source changed elsewhere | Refresh the project and inspect retained drafts before generating another candidate. Old approvals cannot apply to the new source. |
| Imported opinions blocked after a source edit | Open the organizer, inspect the per-opinion counts and recheck current associations. Unchanged paragraphs remain usable; affected opinions need individual matching or confirmation. Reimporting the complete file is unnecessary. |
| Imported opinion not located | Provide an exact quote or ask Codex to match the remaining notes using the approved source context. Confirm genuinely uncertain matches. |
| Compilation failed | Read the build log and check missing classes, figures, bibliography or engine compatibility. Keep the last successful PDF and correct the dependency issue before retrying. |
| English PDF did not change after editing a translation | A draft save does not change English source. Generate and inspect the English candidate, then click **Write back English** in the first column when its complete current scope is ready. The workbench then replaces **Latest English** automatically; the first-upload **Original** remains available. Recompiling confirmed source alone does not generate a new English revision. |
| Older tool schema remains cached | An existing chat may retain its tool catalog until the host refreshes it. The packaged native transport reconnects to the installed MCP server for registered returns, preserving that chat and requiring no manual request copying. A workbench-backend restart is separate from a Desktop tool-catalog refresh; availability of the latter depends on the host's control transport. |

For release-specific evidence, see [Verification](verification.md). Technical details are in [Data and Source Boundaries](core-boundaries.md), [Compiler Security](compiler-security.md), [Codex Integration](codex-integration.md), and [Font Support](fonts-support.md).
