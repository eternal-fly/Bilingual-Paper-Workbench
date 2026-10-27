# Bilingual Paper Workbench: Font Support

The translation and opinion reading views bundle Markdown/KaTeX styles and math fonts locally. They do not download fonts while reading. That display bundle is separate from the fonts required by a paper's actual LaTeX template. Selecting a language does not install every script's typography or rewrite the source font declarations.

The font installer keeps a deterministic local font bundle separate from manuscript sources. It does not change the document's font declarations or substitute a different CJK family silently.

The documented tested scope includes the supported bilingual XeLaTeX template and the original 18-page REVTeX/pdfLaTeX paper. The former requires its declared CJK and Latin faces; the latter retains its own template and distribution typography. A successful font smoke test or Markdown rendering is not evidence that a particular manuscript compiled successfully. See [Verification](verification.md) for the corresponding project/build scope.

`scripts/fonts-sources.json` pins the official source URLs, versions and SHA-256 values for Noto Serif CJK SC Regular/Bold, Noto Sans CJK SC Regular and the Debian-distributed AR PL UKai TTC. Noto is covered by the SIL Open Font License 1.1; UKai retains the ARPHIC PUBLIC LICENSE from the package's copyright member. The installer retains both license texts alongside the private bundle. Four Latin Modern OTF faces are copied from the existing TeX installation; their hashes are recorded in the local receipt, and their use remains subject to the GUST Font License.

Run `scripts/fonts-install.ps1` with an explicit `-FontRoot` and `-TexBin`, or use the user-level defaults. `-RegisterUserFonts` installs only the CJK resources in the current user's font directory and HKCU font registry. It preserves conflicting existing bytes or registrations and fails visibly. `-Offline` verifies and uses already retained artifacts without network access.

The resulting `setup-receipt.json` records exact font files/hashes, user registration and font lookup results. `fonts.conf` searches only the explicit bundle and Latin Modern directory and uses an explicit cache directory. An isolated compiler must copy or mount the fonts into its own permitted runtime and generate a new configuration for those sandbox-visible paths:

```js
import { buildFontconfig } from '../scripts/fonts-config.mjs';
const xml = buildFontconfig({ bundleDir, latinDir, cacheDir });
```

Pass `FONTCONFIG_FILE` and `FONTCONFIG_PATH` only to that compiler process. Do not rely on global TeX fontconfig files or implicit Windows font discovery. A machine can have `Noto Serif SC` and `Noto Sans SC` installed while the distinct `Noto Serif CJK SC` and `Noto Sans CJK SC` names still fail.

`scripts/fonts-smoke.ps1` compiles a small, self-authored fixture with all required faces. It is a font availability test; it does not claim an isolated compiler and must never be adapted to compile arbitrary imported manuscript text outside the secure worker.

Official sources: [Noto Serif CJK 2.003](https://github.com/notofonts/noto-cjk/releases/tag/Serif2.003), [Noto Sans CJK 2.004](https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004), [Debian UKai source and licenses](https://sources.debian.org/src/fonts-arphic-ukai/0.2.20080216.2-5/debian/copyright/).
