import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'work/ui-native-bootstrap-qa');
await mkdir(output, { recursive: true });
const source = `import {api,getHostState,subscribe} from './ui/bridge.mjs';window.__bridge={api,getHostState,subscribe};window.__received=[];subscribe(state=>{if(state)window.__received.push(state)});window.__pending=[api('state'),api('state')];window.__settled=Promise.allSettled(window.__pending).then(values=>{window.__results=values.map(value=>value.status==='fulfilled'?{status:value.status,state:value.value}:{status:value.status,error:value.reason.message,code:value.reason.code})});`;
const bundle = await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'native-bootstrap-fixture.mjs' }, bundle: true, platform: 'browser', format: 'iife', write: false });
const frameHtml = `<html><body><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), checks = [];
const check = value => { checks.push(value); console.log(value); };
async function fixture({ initial = 'missing', bootstrap = 'success', delay = 350 } = {}) {
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:9148/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic MCP Apps host</title><iframe id="view"></iframe>' }));
  await page.goto('http://127.0.0.1:9148/');
  await page.evaluate(({ frameHtml, initial, bootstrap, delay }) => {
    window.__calls = []; const frame = document.querySelector('#view');
    const state = { project: { id: 'synthetic-native-project' }, segments: [], capabilities: {} };
    const uiMeta = { paperState: state, paperResult: null, paperUiToken: 'synthetic-ui-only-capability', instanceId: 'synthetic-server-instance' };
    const result = () => ({ content: [{ type: 'text', text: 'Synthetic editor ready.' }], structuredContent: { projectLoaded: true }, _meta: uiMeta });
    const notify = () => frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result() }, '*');
    addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
      const request = event.data;
      if (request.method === 'ui/initialize') frame.contentWindow.postMessage({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, hostInfo: { name: 'Synthetic host', version: '1.0.0' }, hostCapabilities: { serverTools: {}, message: { text: {} } }, hostContext: { theme: 'light' } } }, '*');
      if (request.method === 'ui/notifications/initialized') { if (initial === 'normal') notify(); else if (initial === 'delayed') setTimeout(notify, delay); }
      if (request.method !== 'tools/call') return;
      window.__calls.push({ name: request.params.name, action: request.params.arguments.action || null, hasToken: typeof request.params.arguments.uiToken === 'string' });
      if (request.params.name === 'bilingual_paper_panel') {
        const respond = () => frame.contentWindow.postMessage(bootstrap === 'failure' ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Synthetic bootstrap transport failure.' } } : { jsonrpc: '2.0', id: request.id, result: bootstrap === 'missing-meta' ? { content: [{ type: 'text', text: 'No private UI metadata supplied.' }], structuredContent: { paperUiToken: 'model-visible-data-is-not-authority' } } : result() }, '*');
        if (initial === 'delayed') setTimeout(respond, delay + 200); else respond();
      } else if (request.params.name === 'bilingual_paper_ui') {
        if (request.params.arguments.uiToken !== uiMeta.paperUiToken) frame.contentWindow.postMessage({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid synthetic private capability.' } }, '*');
        else frame.contentWindow.postMessage({ jsonrpc: '2.0', id: request.id, result: result() }, '*');
      }
    });
    frame.srcdoc = frameHtml;
  }, { frameHtml, initial, bootstrap, delay });
  const frame = page.frameLocator('#view');
  return { page, frame, result: async () => { await frame.locator('body').evaluate(() => window.__settled); return frame.locator('body').evaluate(() => ({ results: window.__results, host: window.__bridge.getHostState() })); } };
}
try {
  let current = await fixture({ initial: 'normal' }); let value = await current.result(); assert.ok(value.results.every(result => result.status === 'fulfilled')); assert.equal((await current.page.evaluate(() => window.__calls.filter(call => call.name === 'bilingual_paper_panel').length)), 0); await current.page.close(); check('real MCP Apps SDK preserves initial UI-only metadata and authenticated state calls without an extra opener');
  current = await fixture(); value = await current.result(); assert.ok(value.results.every(result => result.status === 'fulfilled'), JSON.stringify(value.results)); assert.equal(await current.page.evaluate(() => window.__calls.filter(call => call.name === 'bilingual_paper_panel').length), 1); assert.ok((await current.page.evaluate(() => window.__calls.filter(call => call.name === 'bilingual_paper_ui'))).every(call => call.hasToken)); await current.page.close(); check('missing initial notification uses one UI-RPC opener shared by concurrent calls, then authenticates state through private metadata');
  current = await fixture({ initial: 'delayed' }); value = await current.result(); assert.ok(value.results.every(result => result.status === 'fulfilled')); assert.equal(await current.page.evaluate(() => window.__calls.filter(call => call.name === 'bilingual_paper_panel').length), 1); assert.equal(value.host.connected, true); await current.page.close(); check('a delayed initial notification races safely with one bootstrap and still establishes a usable private session');
  current = await fixture({ bootstrap: 'failure' }); value = await current.result(); assert.ok(value.results.every(result => result.status === 'rejected')); assert.equal(await current.page.evaluate(() => window.__calls.filter(call => call.name === 'bilingual_paper_panel').length), 1); await current.page.close(); check('bootstrap transport failure remains bounded and visible with no automatic retry or worker call');
  current = await fixture({ bootstrap: 'missing-meta' }); value = await current.result(); assert.ok(value.results.every(result => result.status === 'rejected')); assert.equal(await current.page.evaluate(() => window.__calls.filter(call => call.name === 'bilingual_paper_ui').length), 0); assert.ok(!JSON.stringify(value.host).includes('synthetic-ui-only-capability')); assert.ok(!JSON.stringify(value.host).includes('model-visible-data-is-not-authority')); await current.page.close(); check('model-visible structured content cannot become a UI capability, and diagnostics expose no credential values');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticOnly: true, realMcpAppsSdk: true, realPostMessageWire: true, noWorkerOrModelCalls: true, passed: checks.length, checks }, null, 2));
} finally { await browser.close(); }
