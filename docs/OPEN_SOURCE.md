# Open-source distribution

The project's first-party code, documentation and original icons are available under the [MIT License](../LICENSE), with Luofei as the public author. The application's `private: true` package flag prevents accidental npm publication; it does not override the MIT grant. Third-party material retains its own terms in [NOTICE](../NOTICE) and the generated runtime notices.

## Source and runtime packages

The installable runtime and the source release serve different purposes. The runtime contains built entry points and installation helpers. It is not a substitute for the editable `src/`, `ui/`, build scripts and tests.

Run `node scripts/package-source.mjs` from a source checkout to create the separate source ZIP. The packager reads only its fixed plugin root and finite allowlist, validates paths and content before writing, and records sorted relative file paths, sizes and SHA-256 hashes. ZIP metadata and entry order are deterministic for identical inputs. The command refuses a conflicting existing output unless replacement is explicitly requested.

The source archive includes:

- The license, notice, security/contribution guidance, English README/manual, package manifests and lockfile.
- First-party `src/`, `ui/`, `scripts/`, tests, documentation and icon/OFL notice assets.
- Only the declared synthetic sample-paper fixture and its generated sample PDF.

For a fresh checkout or extracted archive, use the ordered [Windows source installation instructions](../README.md#install-from-source-windows). Install the locked dependencies and build before invoking `install.ps1`, because the source package deliberately has no `dist/`. The documented compiler path starts with an existing compatible Windows TeX Live installation, prepares the private font bundle with `fonts-install.ps1`, then copies the isolated runtime with `compiler-prepare.ps1`. Plugin installation alone does not provision that runtime. The optional pinned `compiler-install64.ps1` downloader already assumes the private fonts exist, so it must not be advertised as a complete first-use bootstrap.

It excludes `work/`, `node_modules/`, `dist/`, Git metadata, host caches, installed configuration, credentials, papers, reviews, chat history, compiler outputs and private runtime/font installations. Symlinks, path escapes, unexpected file types, private configuration and sensitive-content findings fail closed. Do not replace the allowlist with a recursive copy of a working directory or an installed plugin. The source `mcp.json` is a portable template; an installed copy contains machine-specific paths and must not be published.

The privacy gate checks finite paths and known sensitive-content patterns. It cannot semantically prove that every comment, document or test string is free of unpublished material. Review the manifest and source changes before sharing an archive, and retain only synthetic test evidence.

## Third-party material

The runtime build uses esbuild metafiles to identify the dependencies actually bundled, including indirect dependencies. `dist/THIRD_PARTY_NOTICES.md` contains the first-party MIT grant and available dependency LICENSE/COPYING/NOTICE texts; missing license material stops the build. Keep legal comments and that generated notice when redistributing built artifacts. The dependency lockfile records versions and integrity values, not permission to relicense a dependency.

KaTeX's software license is MIT. Its embedded display fonts use SIL OFL 1.1 with retained copyrights and Reserved Font Names in `assets/katex-fonts-OFL.txt`. PDF.js uses Apache-2.0. These terms remain separate from this project's MIT license.

Compiler and font provisioning is download-only in this source release. The pinned scripts fetch or copy TeX components and fonts into a private local runtime; those binaries and fonts are not included in the source ZIP. TeX Live comprises separately licensed components. Noto CJK, AR PL UKai and Latin Modern retain their respective font licenses. A prepared compiler tree copies engines, DLLs, TeX files and fonts, so redistributing that tree requires its own complete component, notice and applicable source-obligation review. Do not assume the plugin's MIT license covers it.

Downloads are hash-checked. An upstream mirror replacing or removing a pinned asset can make provisioning unavailable; use a matching retained asset or review an explicit version/hash update instead of bypassing verification. A source build alone does not establish that compiler provisioning works on a fresh machine.

## Supported environment and evidence

The application currently targets Windows with Node.js 24, PowerShell 7, supported Codex Desktop/CLI native tooling and an isolated TeX runtime. Desktop's loaded paper chat owns inference. Queue delivery, host identity and plugin discovery depend on host schemas and available account features; this project does not provide an independent model service or guarantee every Codex build. Check the exact host versions and release scope in [Verification](verification.md), and rerun compatibility checks when the host changes.

Integration uses native methods such as `config/batchWrite`, `thread/read` and `thread/queue/add`/`thread/queue/list`, including host experimental capability negotiation where required. These are not a generic OpenAI-compatible API contract. Keep host-specific failures visible and do not substitute writer takeover or unrestricted model execution when a method is unavailable.

The Node and synthetic browser suites can be run from a clean source install as described in [CONTRIBUTING.md](../CONTRIBUTING.md). Native compiler/writer, real-model and installed-window evidence is separate. Historical receipts do not prove portability to a new OS, host version or account.

Source packaging is a local preparation step. Creating a repository, choosing its hosting/visibility, uploading an archive, publishing a release and distributing additional third-party binaries are separate actions.
