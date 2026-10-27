# Complete MVP and independent panel plan

User authorization (2026-10-24): complete remaining MVP, install needed fonts, test on the selected paper, implement safe compile, reviewed source promotion and undo. Add an independent panel with a persistent paper-specific Codex chat. Models must be selectable. No publication or unrelated memory/health access is involved.

## Workstreams and owned boundaries

- Compiler: real Windows AppContainer with no network capabilities, owned private runtime/input/output ACLs, child-process restriction and JobObject limits. Immutable project snapshots only. Actual isolation and adversarial probes are release gates.
- Fonts: official fixed-source CJK/UKai assets in private runtime, verified fontconfig mapping, optional authorized user font registration. Do not rewrite the paper to hide missing fonts.
- Codex: supported app-server, existing sign-in managed by Codex, explicit live model/effort selector, persistent dedicated paper chat, streamed turns/cancel. Bounded paper tools may compile, translate and propose; source promotion is excluded from model tools.
- Root integration: immutable compiler/build metadata, Windows exclusive file broker, prepared/committing/applied recovery journals, single-use UI acceptance, inverse proposals, live independent UI and installer updates.

## Interfaces

`CompilerWorker({dataRoot,runtimeRoot?,fontsRoot?}).probe()` and `.build({projectId,snapshotId,mainFile,files:[{path,bytes}],engine,candidateHash?,jobId?,signal?})` return exact input hashes, build identity, PDF/SyncTeX paths and isolation evidence.

`CodexBridge({dataRoot,cwd,command?,transportMode,toolSpecs?,handleTool?})` exposes connect/listModels/startChat/resumeChat/sendMessage/waitForTurn/interrupt/getState/close and change/delta/turnCompleted events. Model choice is per paper chat, never a global Desktop setting.

`PaperApplication` composes the existing read/review core without granting model tools source-write authority. Authenticated UI operations cover baseline/candidate compilation, exact acceptance, apply, inverse undo, recovery, chat/models, comments, candidate editing, explicit alignment, logs and cancellation.

`WindowsSourceWriter` opens every project read-set file with FileShare.None, verifies final handle paths and hashes while held, and writes only pinned changed files through the held handles. It does not claim that read-hash-rename is CAS. Durable before/new content and journals precede mutation. A third content during recovery freezes the project.

## Acceptance ledger

- [x] Font name resolution and real paper build.
- [x] AppContainer host read/write, network, child process and resource-limit probes.
- [x] Exact baseline/candidate PDF identity and stale-build handling.
- [x] File replacement/in-place external-write injection while broker holds locks.
- [x] Authenticated exact candidate acceptance, repeat/replay rejection and rejection leaves source unchanged.
- [x] Formal single-file apply and inverse transaction restore exact original bytes.
- [x] Multi-file interrupted write recovery or visible frozen conflict; no blind rollback.
- [x] Persistent dedicated Codex chat, live model selection, streaming, translation/proposal return.
- [x] Native visibility of the dedicated conversation and completed tool call established through the exact thread API; no unrelated Desktop-chat control claimed.
- [x] Independent Node backend and Edge app-mode launcher verified without Desktop UI/API dependency; physical closure of the active Desktop app was not performed during this automated task.
- [x] Protected editor, build-specific PDF/source navigation, keyboard/mobile behavior and immutable four-layer references.
- [x] Tests, adversarial failure paths, package/install readback and actual-paper evidence; see verification.md and private acceptance reports.

Routine choices follow this plan without repeated approval. Scientific content remains a review decision; real-paper mutation tests must be minimal, reversible and restore the original byte hash. If an external capability cannot be proven, its gate remains failed rather than renamed as complete.
