# Paper-scoped background connection

Keep the plugin and its existing paper chat. A detached plugin process owns the
workbench HTTP lifetime. The Desktop window and connection card are optional.
No global Desktop setting, other chat or backend process may be changed.

1. Persist a read-only verified reference to the exact existing chat per paper.
2. Prepare a source-version-bound handoff; activate only that chat, fail closed
   while another client owns it, and release only this process's idle writer.
3. Start/reuse a signed, private background process from the native opener.
4. Retain model choice and paginated visible history without creating a chat.
5. Verify isolation, source/review preservation, UI, process lifetime and real
   same-ID interaction before reporting success. Report any host ownership
   limitation separately from passing automated checks.
