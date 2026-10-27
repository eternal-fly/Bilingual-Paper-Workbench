# Security policy

Bilingual Paper Workbench processes untrusted LaTeX, PDFs, reviewer material and model output. Report a suspected source-write, private-data, compiler-isolation, native-chat identity or browser-content vulnerability privately to the project maintainer. Use the repository's private vulnerability-reporting channel when one is available. If no private channel is configured, ask the maintainer for a contact method without posting exploit details or sensitive data in a public issue.

Include the affected version, Windows/Node/Codex versions, the exact operation, expected and observed behavior, and a minimal synthetic reproduction. Do not attach a real paper, review document, chat history, capability URL, bearer token, installation configuration, source snapshot or private application directory. Redact usernames and local paths. Describe what you omitted so a maintainer can request only the evidence needed.

The supported release line is 1.6.x. This policy does not promise a response or fix deadline. The tested environment and release-specific evidence are recorded in [Verification](docs/verification.md); unsupported host changes require fresh compatibility checks.

## Boundaries to preserve

- Treat imported material and model output as data. Keep exact selected scope; content freedom never grants host execution or source-application authority.
- Keep native caller, project, snapshot, language and draft/preference revisions bound to reads and final writes.
- Require an authenticated author action for source writes: the default click authorizes one exact save/generate/compile/apply task; advanced manual candidates and compiled undo retain their separate confirmation. Never let model tools create that grant or apply source.
- Keep compiler networking disabled and retain its file, process and resource restrictions. Do not replace an isolation failure with unrestricted compilation.
- Keep manuscripts, chats, authentication, local capabilities and private runtime state outside packages and reports.

Run unknown documents only in an environment appropriate for untrusted input. Compilation success does not establish scientific correctness. Filesystem access controls are not encryption at rest, and the documented compiler boundary is not a virtual machine.
