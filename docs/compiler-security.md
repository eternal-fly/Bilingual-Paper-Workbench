# Bilingual Paper Workbench: Compiler Security

The compiler uses an operating-system AppContainer, not merely a temporary directory or `-no-shell-escape`.

The versioned verification record covers the original 18-page REVTeX document under isolated pdfLaTeX with both figures, BibTeX and SyncTeX, and the supported bilingual XeLaTeX template. Template/package/font compatibility is checked per project. This is not a claim that every LaTeX project, arbitrary TeX program or Unicode template can use either engine interchangeably. See [Verification](verification.md) for retained evidence and the 1.0 release receipt.

## Fixed PDF and bibliography policy

pdfLaTeX uses the fixed trusted `pdftex-no-object-streams-v1` startup policy: PDF object-stream storage is disabled while original source bytes, template, engine and SyncTeX remain intact. This avoids a reproduced native pdfTeX object-writing failure with a complete figure-containing document. The relative main filename is rejected before probing if it contains TeX metacharacters; no model/document can provide a compiler prelude. The policy is included in compiled input identity and recorded in the immutable build manifest. XeLaTeX keeps its previous input-identity payload for saved-build compatibility. An earlier pdfLaTeX candidate must be recompiled under the new identity before source promotion.

When the first auxiliary file declares bibliography data, the bounded sequence is TeX, BibTeX, TeX, TeX. Bibliography search includes only the current isolated output and immutable input; style search includes immutable input and public distribution styles. Existing project-local `.bst` files enter the hashed source read set. Generated REVTeX notes stay in the isolated output. No shell, network or general filesystem path is added. Official REVTeX resources are pinned to their TeX Live package revision and publisher-database SHA-512 in the installer.

## Deployed boundary

Each native invocation creates a new application identity with no capability SIDs. Before the suspended process starts, the broker verifies its actual AppContainer token and expected identity, installs a restricted child-process policy, and attaches it to a kill-on-close Job Object with an active-process limit of one, a process/job memory limit and CPU time limit. A trusted broker enforces the wall-clock deadline and monitors output file count/size. Only a null stdin and the specific worker log handle are inherited.

The project is copied into a private immutable input snapshot. That invocation's unique identity receives read/execute access to this copy and modify access to its separate output directory. It receives no grant on the original project, user home, other project, credentials or parent directories. The complete environment is built from a small allowlist; login credentials and the parent's environment are not inherited.

Kpathsea needs to canonicalize ancestor paths on Windows. Three temporary user-session DOS drive aliases expose only the approved runtime, input and output roots. This avoids giving the AppContainer metadata/listing rights on user parent directories. Exact aliases are removed after the process terminates. Native invocations are serialized by an application-specific mutex; later passes require their earlier drive identities, so an unavailable alias fails rather than silently remapping a build. These aliases are path mappings, not substitutes for the AppContainer ACL boundary.

After the Job is terminated, the broker removes its unique input/output access rules and deletes its own temporary application profile. The Node adapter rejects a successful-looking result when ACL, profile or alias cleanup fails. An interrupted broker may leave its temporary profile/aliases behind; no unrelated state is guessed or deleted automatically. The Job's last handle closing terminates the worker.

## Public runtime decision

The controller approved a permanent **read/execute-only** `ALL APPLICATION PACKAGES` rule on the application-owned runtime asset directory. This directory contains only verified distribution binaries, packages, public fonts, compiled broker/probe and inventory receipts. Private project inputs, drafts, logs, caches, configuration secrets and output never live beneath it. Preparation inventories the allowed source assets and refuses unexpected files before granting access. It explicitly checks that the added application-package rule contains no write/delete rights.

This is the normal public application-code pattern and prevents repeated ACL traversal of thousands of public package files. The original TeX installation, Windows directories and user parents are not modified. Private input/output permissions remain unique to each invocation. The worker constructor rejects overlapping private-data/public-runtime roots.

## Engine pipeline and artifacts

The allowlist is XeLaTeX, pdfLaTeX, BibTeX, xdvipdfmx and SyncTeX. XeLaTeX runs with `-no-pdf`; xdvipdfmx is launched separately under the same restrictions, since an internally spawned converter would violate the child-process policy. No `latexmkrc`, Makefile, project installer or package downloader executes. Missing packages fail visibly. Required dependencies are prepared outside the compiler from pinned official archives.

The trusted environment sets `TEXINPUTS` explicitly to the output directory, immutable project snapshot and public distribution styles. This is necessary because upstream program-specific values such as `TEXINPUTS.xelatex` take precedence over a generic configuration-file value. Relative project graphics and generated auxiliary files therefore resolve without changing project sources or granting access to the original directory.

`inputHash` is SHA-256 of this exact JSON serialization:

```js
JSON.stringify({
  engine,
  mainFile,
  files: files.map(({path, bytes}) => ({path, hash: sha256(bytes)}))
    .sort((a,b) => a.path.localeCompare(b.path))
})
```

A successful build binds its project/snapshot/candidate identity, input hash, exact PDF hash, isolation evidence, private artifacts and manifest. The coordinator verifies original snapshot bytes after compilation and checks the engine recorder's inputs remain in the mounted input, runtime or output. Artifact reads reject reparse paths, hard-link aliases and oversized files after the worker is gone. Compilation success says nothing about scientific correctness.

SyncTeX queries copy the pinned PDF, SyncTeX artifact and requested compiled source into a new read-only query snapshot, then run the allowlisted query executable under another fresh AppContainer. Returned coordinates remain bound to that exact PDF hash and build. Multiple matches remain multiple matches; they are not silently resolved to a guessed sentence.

Forward results contain `page,x,y,h,v,width,height` in PDF points (72 per inch), with a top reference; a rectangle uses left `h` and top `v-height`. Inverse results contain the exact compiled `sourcePath,line,column`; column `-1` is the native unspecified-column value. Source paths outside the pinned compiled input identities are not returned as editable source anchors.

## Resource and threat-model limits

Current translation/opinion reading uses an offline Markdown + KaTeX renderer. Raw HTML, active links/images and trusted KaTeX extensions are disabled. Expressions and macro expansion are bounded; macros are copied per expression, and safe custom macros are derived from the authorized current source snapshot. Unresolved references retain labels rather than guessed numbers. This display path does not invoke the TeX worker, model chat, source writer or transaction confirmation. The older isolated opinion-PDF API remains compatibility-only. Formal paper/candidate builds continue through the unchanged AppContainer boundary.

Numeric reference display may read bounded scalar `.aux` metadata beside a verified current confirmed PDF. The source snapshot, exact projected/raw input identity, manifest and PDF identities must agree; unpromoted candidates, stale builds, aliased paths and malformed metadata cannot supply current numbers. The first observed auxiliary hash is pinned for the process lifetime and changes cause a label fallback. Legacy builds did not attest this auxiliary hash at compilation, which is explicitly recorded in display provenance; this read-only metadata never authorizes source promotion.

The compatibility opinion-PDF API is a separate derived-display path, not the default Markdown reading view. Its authenticated UI action accepts only a current note ID and revision, captures authorized source bytes on the server, and rechecks identity before returning. Only balanced, allowlisted mathematical syntax and bounded pure macro dependencies enter a fixed standalone XeLaTeX wrapper. The original preamble and auxiliary files are not executed. Unsupported input stays visible as source. The verified worker, artifact hashes and output limits still apply; these renders never enter official paper builds, PDF-version selection, source transactions or confirmation state.

CPU, memory and process count are Job Object limits. Wall-clock cancellation is handled by the trusted broker. Cancellation uses a parent-to-broker control pipe which is not inherited by the worker, rather than a cancellable flag the worker could delete. The output budget is sampled every 50 ms and independently checked on final artifact reads. It is **not an NTFS/VHD hard disk quota**; a pathological allocation can overshoot that monitoring interval. Strict volume quotas, kernel vulnerabilities and arbitrary operating-system compromise are outside this tested boundary. No VM-level isolation claim is made.

The output sampler tolerates a child directory disappearing between discovery and enumeration, as Fontconfig does with temporary `.LCK` directories. Losing the required output root, permission failures and other I/O errors remain fatal. Reparse-point rejection and entry/byte limits remain in the existing monitor. A .NET Framework regression reproduces the original vanished-directory error and checks that the narrow correction preserves these boundaries.

AppContainers can read the standard public system resources that Windows grants to application packages. They are not virtual machines with an empty system filesystem. The tested privacy guarantee concerns unauthorized user/project inputs, writes outside the worker output, network access and child-process creation. Ordinary user/admin processes can still change their own files; output hashes and the separate formal source-write protocol must reject changed artifacts rather than assuming they stay immutable forever.

## Setup and live checks

`scripts/compiler-install64.ps1` downloads the pinned TinyTeX 2026.10 Windows archive and the small required package archives, checks publisher SHA-256/SHA-512 values, rejects archive traversal names, and prepares an application-private copy. The existing 32-bit TeX Live 2022 installation is preserved; its executables fail AppContainer startup on this host with Win32 error 623, so the verified 64-bit runtime is required. No downloaded installer runs and no system PATH changes.

```powershell
./scripts/compiler-install64.ps1
$env:PAPER_EDITOR_LIVE_COMPILER = '1'
node --test test/compiler.test.mjs
```

Live tests use synthetic files to establish a reachable host endpoint, then verify the worker cannot connect to it, read an outside private file, modify a read-only input, write outside its output or create a child. Other tests cover a real Chinese/English PDF, exact byte/artifact hashes, malicious TeX, cancellation, earlier-job isolation and a hard wall deadline. A normal test run without the explicit live flag marks native tests skipped; such a skip is not a pass.

An earlier development-host live run passed **9 tests, 0 failures, 0 skips** after adding a relative-PDF-graphics regression and native forward/inverse SyncTeX checks. This is historical engine evidence, not the final 1.0 test total. The graphics regression first reproduced the missing-file failure and then passed the separate-engine/converter pipeline after the environment correction. Its standalone elapsed time was about 8.5 seconds (first/second TeX passes about 2.7/1.7 seconds in a representative run). A mixed Chinese/English build recorded engine times of 8.7/15.7 seconds and converter time of 1.5 seconds during a concurrent real-project run. These are host observations, not a latency guarantee or clean cold/hot benchmark; queueing and filesystem/font caches affect elapsed time.

Primary references: [Microsoft AppContainer implementation](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [process security attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [TeX Live Windows architecture](https://tug.org/texlive/windows.html), and [TinyTeX 2026.10 release](https://github.com/rstudio/tinytex-releases/releases/tag/v2026.10).
