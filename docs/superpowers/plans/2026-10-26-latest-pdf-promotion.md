# Latest PDF after confirmed revision

The author expects the reading window and later reviews to use the modified PDF
after applying a compiled revision. The uploaded baseline remains frozen for
comparison, in accordance with the two-version workflow.

## Behavior

1. A successful current candidate build opens as an explicitly unconfirmed preview.
2. Human confirmation promotes the exact verified build to latest English when
   its compiled inputs equal the current English projection. A bilingual source
   whose English projection differs requires a new isolated English build.
3. The same project's window automatically replaces its active PDF with the new
   verified latest after confirmation, including after a confirmed undo.
4. Later PDF review contexts use the updated original/latest pair. Failed or stale
   builds cannot replace the last successful PDF, and the original stays frozen.
5. Draft saves and successful compilation alone never authorize a source write.

## Implementation and verification

- Reproduce the backend publication gap and same-project viewer refresh gap with
  regression tests before changing their respective implementation.
- Reuse existing artifact verification, source hashes and human confirmation.
- Cover English and bilingual projects, asynchronous pair publication, undo,
  failed/stale compilation and project changes.
- Run relevant backend and browser suites, rebuild and validate the runtime,
  install the patch while preserving private records, then verify installed hashes.
- Update the English manual and locally prepared MIT packages. No publication or
  extra model conversation is authorized by this maintenance work.
