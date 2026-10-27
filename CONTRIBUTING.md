# Contributing

Contributions to this project are provided under the [MIT License](LICENSE). Preserve existing third-party notices. Use synthetic papers, identities and credentials in tests; never submit a manuscript, real chat record, private installation config or generated runtime directory.

## Local development

Use Node.js 24 and the package manager version pinned in `package.json`. From this directory:

If Corepack is not available in your Node installation, install the pinned pnpm version (`npm install --global pnpm@11.25.0`) and use `pnpm` in place of `corepack pnpm` below.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm validate
corepack pnpm test
```

The workspace explicitly approves the pinned esbuild install script. Do not broadly approve dependency scripts. The source includes committed SVG/PNG/ICO icon assets; normal builds do not need an icon-rendering native library. Icon regeneration is optional maintenance and currently uses `@napi-rs/canvas@1.0.13` separately from the normal build.

Browser QA uses the pinned local Playwright development dependency. Install its Chromium browser and select it explicitly when Edge is unavailable:

```powershell
corepack pnpm exec playwright install chromium
$env:PAPER_EDITOR_BROWSER_CHANNEL = 'chromium'
node scripts/ui-qa.mjs
```

`PAPER_EDITOR_PLAYWRIGHT_MODULE` can explicitly select another Playwright installation; the host-runtime fallback is compatibility support, not a prerequisite for a clean checkout. Browser tests use synthetic backend/compiler dependencies. Native compiler and writer tests require Windows, the prepared isolated compiler and the explicit flags documented in [Verification](docs/verification.md). Report skipped or unavailable checks as such.

## Reviewable changes

Keep fixes narrow and add a regression for a real failure or permission boundary. Check source/draft/PDF identity, stale-result handling, protected math and references, project switching, cancellation, duplicate delivery and failed persistence when relevant. UI changes should retain keyboard access, reading/editing buffers and usable narrow layouts.

Do not weaken a validator or confirmation gate to make a test pass. Changes to compiler isolation, native permissions, source promotion or private-data handling need an explicit explanation and appropriate tests. Installation, real-paper/model runs and publication are separate authorized actions; a local build does not perform them.

## Source release

After the relevant checks pass, run `node scripts/package-source.mjs`. It creates an allowlisted source archive and a SHA-256 manifest under ignored `work/`. Its privacy and path checks must pass before any output is written. See [Open-source distribution](docs/OPEN_SOURCE.md) for included files, exclusions and third-party obligations. Packaging does not initialize Git, commit, push, publish or install anything.

Send security reports through the process in [SECURITY.md](SECURITY.md), rather than a public issue containing sensitive evidence.
