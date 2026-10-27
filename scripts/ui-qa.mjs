import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'work/ui-acceptance-summary.json');
const suites = [
  ['writeback-availability','ui-qa-writeback-availability.mjs','work/ui-writeback-availability-qa/report.json',7],
  ['source-review-draft','ui-qa-source-review-draft.mjs','work/ui-source-review-draft-qa/report.json',6],
  ['pdf-zoom','ui-qa-pdf-zoom.mjs','work/ui-pdf-zoom-qa/report.json',13],
  ['inline-structures','ui-qa-inline-structures.mjs','work/ui-inline-structures-report.json',7],
  ['pdf-controls','ui-qa-pdf-controls.mjs','work/ui-pdf-controls-qa/report.json',8],
  ['typing-latency','ui-qa-typing-latency.mjs','work/ui-typing-latency-qa/report.json',7],
  ['native-editor-save','ui-qa-native-editor-save.mjs','work/ui-native-editor-save-qa/report.json',6],
  ['updates','ui-qa-updates.mjs','work/ui-updates-qa/report.json',8],
  ['editor-performance','ui-qa-editor-performance.mjs','work/ui-editor-performance-qa/report.json',13],
  ['submission-model-refresh','ui-qa-submission-model-refresh.mjs','work/ui-submission-model-refresh-qa/report.json',8],
  ['english-writeback','ui-qa-english-writeback.mjs','work/ui-english-writeback-qa/report.json',17],
  ['review-revalidation','ui-qa-review-revalidation.mjs','work/ui-review-revalidation-qa/report.json',16],
  ['project-switcher','ui-qa-project-switcher.mjs','work/ui-project-switcher-qa/report.json',11],
  ['project-handoff','ui-qa-project-handoff.mjs','work/ui-project-handoff-qa/report.json',7],
  ['paragraph-math-intent','ui-qa-paragraph-math-intent.mjs','work/ui-paragraph-math-intent-qa/report.json',5],
  ['pdf-promotion','ui-qa-pdf-promotion.mjs','work/ui-pdf-promotion-qa/report.json',16],
  ['translation-typography','ui-qa-translation-typography.mjs','work/ui-translation-typography-qa/report.json',16],
  ['formula-editing','ui-qa-formula-editing.mjs','work/ui-formula-editing-qa/report.json',10],
  ['formula-runtime','ui-qa-formula-runtime.mjs','work/ui-formula-runtime-qa/report.json',10],
  ['reference-editing','ui-qa-reference-editing.mjs','work/ui-reference-editing-qa/report.json',16],
  ['background-connection','ui-qa-background-connection.mjs','work/ui-background-connection-qa/report.json',17],
  ['origin-chat','ui-qa-origin-chat.mjs','work/ui-origin-chat-qa/report.json',11],
  ['desktop-translation','ui-qa-desktop-translation.mjs','work/ui-desktop-translation-qa/report.json',15],
  ['window-relay','ui-qa-window-relay.mjs','work/ui-window-relay-qa/report.json',8],
  ['review-anchor','ui-qa-review-anchor.mjs','work/ui-review-anchor-qa/report.json',18],
  ['existing-chat-binding','ui-qa-existing-chat-binding.mjs','work/ui-existing-chat-binding-qa/report.json',7],
  ['source-workflow', 'ui-qa-source-workflow.mjs', 'work/ui-source-workflow-qa/report.json', 12],
  ['review-import-delete', 'ui-qa-review-import-delete.mjs', 'work/ui-review-import-delete-qa/report.json', 8],
  ['review-history', 'ui-qa-review-history.mjs', 'work/ui-review-history-qa/report.json', 10],
  ['markdown-reader', 'ui-qa-markdown-reader.mjs', 'work/ui-markdown-reader-qa/report.json', 6],
  ['paragraph-opinion', 'ui-qa-paragraph-opinion.mjs', 'work/ui-paragraph-opinion-qa/report.json', 6],
  ['translation-reading', 'ui-qa-translation-reading.mjs', 'work/ui-translation-reading-qa/report.json', 12],
  ['opinion-reader', 'ui-qa-opinion-reader.mjs', 'work/ui-opinion-reader-qa/report.json', 8],
  ['empty-onboarding', 'ui-qa-empty-onboarding.mjs', 'work/ui-empty-onboarding-qa/report.json', 8],
  ['review-cards', 'ui-qa-review-cards.mjs', 'work/ui-review-cards-qa/report.json', 10],
  ['native-bootstrap', 'ui-qa-native-bootstrap.mjs', 'work/ui-native-bootstrap-qa/report.json', 5],
  ['native-window', 'ui-qa-native-window.mjs', 'work/ui-native-window-qa/report.json', 6],
  ['native-host-routing', 'ui-qa-native-host-routing.mjs', 'work/ui-native-host-routing-qa/report.json', 27],
  ['workspaces-languages', 'ui-qa-workspaces-languages.mjs', 'work/ui-workspaces-languages-qa/report.json', 18],
  ['three-column', 'ui-qa-three-column.mjs', 'work/ui-three-column-qa/report.json', 26],
  ['review-cycle', 'ui-qa-review-cycle.mjs', 'work/ui-review-cycle-qa/report.json', 11],
  ['sync', 'ui-qa-sync.mjs', 'work/ui-sync-qa/report.json', 8],
  ['core', 'ui-qa-core.mjs', 'work/ui-mvp-qa/report.json', 17],
  ['full-review-chat', 'ui-qa-full-review-chat.mjs', 'work/ui-full-review-chat-qa/report.json', 27],
  ['protected', 'ui-qa-protected.mjs', 'work/ui-protected-editor-qa-report.json', 19],
  ['alignment', 'ui-qa-alignment.mjs', 'work/ui-alignment-qa/report.json', 8],
  ['review', 'ui-qa-review.mjs', 'work/ui-review-qa/report.json', 10],
  ['four-layer', 'ui-qa-four-layer.mjs', 'work/ui-four-layer-qa/report.json', 8],
  ['synctex-ui', 'ui-qa-synctex.mjs', 'work/ui-synctex-qa/report.json', 8],
  ['paper-flow', 'ui-qa-paper-flow.mjs', 'work/ui-paper-flow-qa/report.json', 15],
];
const summary = { schemaVersion: 1, startedAt: new Date().toISOString(), syntheticOnly: true, passed: 0, expected: suites.reduce((count, suite) => count + suite[3], 0), suites: [], limitations: ['Compiler and source writer dependencies are synthetic in the UI controller suites.', 'SyncTeX coordinates in the UI suite are mocked; native compiler/query validation is separate.', 'Live Codex account, actual manuscript behavior, installed runtime and manual screen-reader review require separate evidence.'] };
await mkdir(path.dirname(output), { recursive: true });
for (const [name, script, report, expected] of suites) {
  const began = Date.now(); console.log(`UI suite: ${name}`);
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, stdio: 'inherit', env: process.env, timeout: 120000 });
  const record = { name, script, report, expected, exitCode: run.status, passed: 0, success: false };
  try {
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`Suite exited with ${run.status}.`);
    const metadata = await stat(path.join(root, report));
    if (metadata.mtimeMs < began - 1000) throw new Error('Suite did not generate a fresh report.');
    const result = JSON.parse(await readFile(path.join(root, report), 'utf8'));
    if (result.passed !== expected || result.syntheticOnly !== true) throw new Error('The report does not match the declared synthetic acceptance checks.');
    record.passed = result.passed; record.success = true; summary.passed += result.passed;
  } catch (error) { record.error = error.message; }
  summary.suites.push(record); summary.success = summary.suites.length === suites.length && summary.suites.every(suite => suite.success); summary.updatedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(summary, null, 2));
  if (!record.success) { console.error(JSON.stringify({ success: false, failedSuite: name, report: output })); process.exitCode = 1; break; }
}
if (summary.success) console.log(JSON.stringify({ success: true, passed: summary.passed, suites: summary.suites.length, report: output }));
