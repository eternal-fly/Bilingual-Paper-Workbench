# Bilingual Paper Workbench — User Manual

**Version 1.6.4 · Windows · English edition**

Bilingual Paper Workbench connects an English LaTeX paper, an editable translation and paragraph-linked review notes in one workspace. Your existing Codex Desktop chat performs translation and review; the workbench provides the reading, editing and author-initiated writeback interface. English is the default interface language. The translation language is a separate choice.

## Install once before opening your first paper

If the plugin has not been installed, follow [Install from source (Windows)](../README.md#install-from-source-windows). The public source archive requires the locked Node dependencies and a build; it does not contain a preinstalled TeX runtime or downloaded fonts. Use PowerShell 7, Node.js 24 and a supported signed-in Codex Desktop/CLI installation. Prepare the private fonts before the isolated compiler, preview and run the plugin installer, then restart Codex Desktop to load its tools.

An existing compatible Windows TeX Live installation is a compiler prerequisite for that documented setup path. Opening a reading window does not establish that compilation is available. First compile the included synthetic sample, then verify the classes, figures, bibliography and fonts of your own project. Do not compile imported manuscript code outside the isolated workbench worker to work around a setup failure.

## Recommended first-use workflow

**Open the LaTeX project → translate → review suggestions → edit the translation → Write back English once → export the current project or PDF.**

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

Translation and English synchronization use one best natural wording while retaining the complete meaning. They do not authorize summarizing, deleting qualifications, adding claims or automatically adopting review advice. For English writeback, the latest saved author draft is the intended content; the old English is comparison context. Follow explicit author edits and deletions and keep unsolicited advice separate. Read the resulting English/PDF after writeback, or choose the advanced manual route to review before applying. Model instructions guide fidelity but do not mechanically prove semantic equivalence.

### Work directly from the bound chat

Ask the bound Codex Desktop chat to inspect source, edit a saved translation, organize imported reviews, or record pending/adopt/revise/keep decisions. Native tools operate on this paper without screen control or another model conversation. Reads and edits retain the exact paper, source and draft revision; unsaved or composing window input is preserved.

The default **Write back English** route accepts the complete author-edited inline TeX, including changes to formulas, references, labels, macros and environments. Codex follows your latest saved intent and returns English for the exact registered ranges. It does not receive a general source-write command: the controller alone compiles and applies the task you authorized by clicking.

For manual control, open **Revisions** and inspect a pending candidate, build log and complete source diff. The advanced manual route keeps its own explicit confirmation. Ordinary native preparation or compilation outside a one-click task does not apply source changes.

### Read the request status

After **Write back English**, the status progresses through saving/preparing, generating in the bound chat, compiling, applying and completed. Keep the workbench and Desktop background process available. The default task continues automatically after a valid model return and successful isolated build; it does not wait for another confirmation click.

Changed drafts, source or alignment revoke the old task. A failed compile keeps your saved text and the previous successful English PDF. Correct the pending candidate or reported problem and use the explicit retry/resume action. **Cancel writeback** cancels remaining work; a source commit already in progress must finish or recover safely.

Delivery acknowledgment, active model work and validated results are separate states. Uncertain delivery is not automatically resent. Check the bound chat before retrying an uncertain send. Repeated clicks and reconnecting the same chat do not create another task for the same click identity.

When the exact source write completes, the paragraph shows it as written back. A later edit becomes pending again. This physical status does not certify a faithful translation or automatically adopt review advice.

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

Click a translation paragraph or press Enter. Edit prose and inline TeX in the same field, then choose **Done**, leave the field, press Escape or use Ctrl+Enter to save and return to reading. Ctrl+Z undoes draft edits; Ctrl+Y or Ctrl+Shift+Z redoes them.

```tex
The estimate holds for $n\ge 2$; see \eqref{eq:bound} and \cite{KEY_A}.
```

You may add, change, reorder or delete formulas and their labels/references. Empty saved text can intentionally remove a paragraph through writeback; later text can be written into its retained exact source slot. The default author route has no formula/content whitelist. Incomplete TeX is saved as text and may need correction when compiled. A genuine save, permission, version or connection failure remains distinct from a TeX compile error and preserves your input for retry or export.

Reading mode uses offline Markdown and KaTeX. Supported mathematical environments and static project macros are typeset; unsupported or incomplete constructs retain a visible source representation. This display fallback does not make a paragraph read-only or authorize an unrequested source edit.

## Edit citation and cross-reference keys

Edit commands such as `\cite{KEY_A,KEY_B}`, `\ref{fig:overview}`, `\eqref{eq:bound}` and `\label{eq:bound}` directly. Your author-directed writeback may add, change or remove them. Include the required bibliography and label definitions in the project; compilation can report missing or malformed dependencies. The model should preserve your intended references and scientific meaning rather than silently restoring older English.

## Edit inline TeX structures

Spacing, escaped symbols, formatting, custom macros and environments remain ordinary editable text:

```tex
Section~3.1 and \textbf{the main result}, with a literal 10\% value.
```

The default author route does not veto a candidate because a static parser cannot classify one of these objects. It still limits changes to the captured source ranges and runs the exact candidate in the existing isolated compiler. Saving or reading text does not execute TeX. Compiler isolation, input manifests, byte/version checks and write recovery remain in force.

Older protected/manual request modes remain available for compatible workflows. Their placeholder or formula/reference diagnostics describe that mode; they do not impose a permanent content restriction on a new author-click writeback.

## Default writing Skills and translation checks

Translation and explicit review requests ask the **same bound Desktop chat** to select applicable installed academic writing, translation and polishing Skills by default. The model must read each selected `SKILL.md` before applying it. It does not automatically invoke every installed Skill or activate unrelated memory, health or software-development workflows.

Use **Additional instructions** or the ordinary chat to state priorities, exclusions or a request to disable a Skill. For example, if installed:

> Prioritize `$fei-personal-write-skills` for academic wording. Preserve my theorem scope and argument order. Focus this review on terminology and transitions.

The workbench does not install Skills or change global Desktop settings. If the host catalog or a required Skill is unavailable, that limitation must be reported honestly. An older private model bridge without host Skill access asks you to use the bound Desktop route; it must not claim to have applied a Skill.

Before returning a translation, Codex performs a built-in check within the same requested turn: complete paragraph coverage, target language, terminology, conditions and quantifiers, negation, probability guarantees, numbers/units, sentence completeness, formula/reference placeholders and valid output structure. Protected English identifiers are not treated as missed translation. Correct retained TeX is not rewritten merely to work around a display limitation. The backend separately validates IDs, protected objects, versions and result scope.

Placeholder checks apply to requests that carry a protected inventory. The default author-click English task instead follows the complete saved inline TeX and its exact source scope; it must not restore content you deliberately changed or removed merely to satisfy an older inventory.

This check does not schedule an additional review conversation. It also does not replace the author's assessment of scientific correctness.

## Write an edited translation back to English

1. Edit the intended translation paragraphs. Review advice remains optional; incorporate only the changes you want.
2. Click **Write back English** in the PDF column. Current input is saved and the exact scope is sent once to the bound Desktop chat.
3. The controller receives the English replacements, compiles them in isolation and atomically writes the authorized source. **Latest English** updates from the verified applied version. No separate confirmation is required in this default route.

That click authorizes the captured text, revisions, source and alignment only. New typing or changed source stops an obsolete task. Confirmed split/merged paragraphs are processed as a complete known group; missing or ambiguous alignment is reported rather than guessed. A draft that was already stale before your new click can be adapted against the current captured source; an old receipt does not authorize it.

Successful compilation does not prove scientific correctness or semantic equivalence. Read the resulting English/PDF. The controller does not silently turn imported or generated opinions into author decisions, add another review conversation or delete material you did not ask to remove.

For a step-by-step workflow, use **Revisions** to inspect the source diff and pending PDF, compile, then confirm that exact manual candidate. Native model tools cannot invent an author-click grant or apply an unrelated candidate.

To undo a source change, choose **Create undo proposal** in **Revisions**. The inverse is separately compiled and confirmed; the latest PDF follows the restored source. This differs from Ctrl+Z in an uncommitted translation draft. Newer author input is preserved.

## Export the current source project or PDF

Under **Export**, choose **LaTeX project ZIP** or **Latest English PDF**.

The ZIP contains the current main `.tex` and every declared compilation input, including project-local classes/styles, bibliography and figures, with relative paths and `EXPORT_MANIFEST.json`. It is a complete source-input export, not just the main file. Installed TeX packages/fonts and private workbench drafts, review records, chats, credentials and transaction history are outside this export.

The PDF download must match the current English source version and verified build. Finish writeback or build the current English PDF if it is unavailable. Exports do not write source or start model work. Unsaved translation edits are not source changes: complete writeback first when you want them reflected in the exported project and PDF.

## Choose the PDF and feedback scope

Use **Original**, **Latest**, **Original & latest**, or the explicitly displayed verified artifact. The normal paper context uses the frozen original and latest confirmed English PDF. A candidate preview is not the latest adopted version.

Original-only and unconfirmed-candidate reviews can return opinions but cannot replace current formal-version translations. Request paragraph-specific or full-paper feedback in the chat as needed. The model may identify an uncertain/global concern without pretending to have located it precisely.

Current notes are shown by default. Open **History** in the notes controls to inspect retained older model suggestions. **Manage** controls future history retention and previews an explicit history cleanup. Current opinions, human comments and formal revision/undo records are separate from removable historical model notes.

In the review-import dialog, **Withdraw notes** hides an imported file's opinions and keeps them recoverable. **Delete** has a separate preview and confirmation. Removing the imported record does not delete your original uploaded review file.

## Continue editing after writeback

After a complete author-task or verified full raw-source writeback, the exact saved draft and current source receive a matching applied record and the paragraph stops counting as unwritten. Compatible older raw-source writes can be recognized from their exact retained transaction evidence without another source write. This reports physical application; retained semantic-review diagnostics are history, not a demand to generate the same candidate again.

An advanced protected partial adaptation can write its English candidate while retaining unfinished author changes. Its status distinguishes **source written** from **author changes still pending**; repair or adapt that remaining content before treating the draft as complete.

A new edit becomes pending immediately. Undo restores the appropriate earlier pending intent and invalidates the reverted applied record. Neither an old candidate nor a matching paragraph number can hide newer text. A failed or interrupted source commit is not reported as completed.

Review opinions have their own lifecycle. Only concerns explicitly adopted before a successful matching source write can become completed; pending/keep/revise opinions and unrelated paragraphs remain unchanged. Undo or explicit reopening returns the affected concern to review.

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

If source writeback is refused, the existing English source and previous successful PDF remain available. A read-only source and another editor's file lock are different conditions: restore the intended source access or release the external lock, then retry the same reviewed candidate if its source version is still current. Source drift requires a fresh candidate/compile. The workbench does not force file permissions or treat a refused write as applied. Content freedom does not bypass source identity, file locks or compiler isolation.

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
