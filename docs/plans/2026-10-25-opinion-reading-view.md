# Compiled paragraph-opinion reading view

The existing bilingual recommendation cards keep their four selectable text fields. Reading mode typesets their inline/display mathematics using the already verified local XeLaTeX worker; source mode preserves the exact display text. No model request is needed for presentation.

1. Add a bounded, isolated math renderer. Resolve protected objects from the server snapshot, accept only conservative mathematical syntax and pure macro dependencies, and compile one tightly cropped PDF page per unique formula. Unknown macros and references retain explicit source fallbacks. Do not execute paper preambles or auxiliary files.
2. Expose one authenticated UI-only action accepting a note ID and exact revision. Capture immutable server content, compile outside project transaction state, and recheck project/note identity before returning. It cannot promote a build, edit notes, or write source files.
3. Add lazy reading/source controls to opinion cards, sharp local PDF.js math canvases, accessible source text, theme support, request race guards and bounded disposal. Preserve the outward notes column and avoid compiling the entire review collection eagerly.
4. Verify parser/security and freshness regressions, real AppContainer formula compilation, source/reading UI behavior and the existing plugin suites. Build and checksum-install locally. Read-only acceptance on the author's paper must preserve all sources, notes, drafts and official PDF identities.

Private manuscript payloads and screenshots remain outside the repository. This change does not broaden the supported mathematical language to arbitrary TeX execution.
