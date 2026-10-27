# Review anchor matching and bound chat implementation plan

**Goal:** Match the remaining external opinions to current source paragraphs with Codex, hold uncertain matches for human confirmation, and send window requests directly to the explicitly bound persistent Codex chat.

**Architecture:** Existing source ranges, original opinion identities, structured result validation and confirmation-only source writes remain authoritative. Anchor matching is an explicit, version-bound presentation operation. The primary window connection uses an authenticated companion MCP App card and the current host's message channel; its exact ticket returns the answer to the originating window. A secondary explicit app-server adapter can continue a verified existing ID after its desktop writer releases ownership. There is no new-chat fallback or recursively launched MCP server. The two transport modes retain distinct ownership and validation claims.

**Tech stack:** Existing Node, MCP Apps, safe Markdown/KaTeX and official Codex app-server JSON-RPC. Preserve the current cream/dark reading workspace and three-column geometry; use compact pending-match and binding dialogs.

## 1. Exact opinion-to-source matching

- [x] Add failing tests for exact imported-note scope, unique substantial literal evidence, ambiguous/global concerns, stale source/drafts/decisions, replay, binding and UI-only confirmation.
- [x] Implement prepare/context/submit/confirm and explicit structured model execution over selected currently unanchored external notes. Preserve bodies, decisions, organized suggestions and existing links.
- [x] Auto-associate only a single verified current source target with sufficient unique evidence; persist ambiguous candidates and reasons for review instead of guessing.
- [x] Add an accessible selection/preview workflow and per-opinion candidate context with explicit confirm controls. Preserve reading focus and existing paragraph opinion rendering.

## 2. Direct existing-chat window connection

- [x] Verify official exact-ID read/turn schemas and ownership conflicts; validate successful same-chat delivery through the supported host message path.
- [x] Implement an existing-ID-only bridge with exact-ID checks, model validation, owned cross-workspace lease, peer-turn busy checks, streaming, bounded structured outputs and owned-process cleanup.
- [x] Persist the explicit per-project binding; restore its identity without starting a model turn. Reject unverified/browser-claimed bindings and concurrent local controllers.
- [x] Enable direct window chat, selected translation and opinion requests only when the backend has the verified bound-chat transport. Preserve native host and independent dedicated-chat routes.
- [x] Verify same-ID stored history and real window return. Record any desktop live-event limitation separately; never use clipboard automation or an unrelated worker fallback.

## 3. Acceptance and local installation

- [x] Run focused transport/controller tests, full enabled Node/native regression, browser acceptance and package validation; obtain independent review.
- [x] Install/reload locally, verify all installed artifacts, then use GPT-6 Astra through the real window to match all 23 original opinions in bounded immediate submissions.
- [x] Verify unchanged author sources, drafts, raw review bodies/decisions and initial baselines; show concrete unresolved matches for confirmation.
- [x] Record private receipts and update user-facing documentation. No commits, public publication, arbitrary source writes or memory updates.
