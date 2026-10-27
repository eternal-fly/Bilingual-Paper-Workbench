import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MODEL_TOOL_BYTES } from './request-budgets.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url)), MAX_INPUT = MODEL_TOOL_BYTES, MAX_OUTPUT = MODEL_TOOL_BYTES;
const tools = { get: 'bilingual_paper_get_request', submit: 'bilingual_paper_submit_translation_result', revision: 'bilingual_paper_propose_revision', reply: 'bilingual_paper_submit_chat_reply' };
const fail = (code, message = 'The Desktop callback could not be completed.') => { throw Object.assign(new Error(message), { code }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const strict = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;
const stageKeys = ['batchOffset','resultCount','finalize'];
const validStage = input => !stageKeys.some(key=>Object.hasOwn(input,key)) || stageKeys.every(key=>Object.hasOwn(input,key)) && Number.isSafeInteger(input.batchOffset) && input.batchOffset>=0 && Number.isSafeInteger(input.resultCount) && input.resultCount>0 && typeof input.finalize==='boolean';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const safeCode = value => /^[A-Z][A-Z0-9_]{1,63}$/u.test(value || '') ? value : 'CALLBACK_FAILED';

/** Only the current Desktop turn provides the chat identity. There is no CLI
 * chat, workspace, endpoint, model, tool-name or private UI capability option. */
export function parseDesktopCallback(argv, stdin = Buffer.alloc(0)) {
  if (!Array.isArray(argv) || !Object.hasOwn(tools, argv[0]) || (argv[0] === 'get' ? ![2,3].includes(argv.length) || !id(argv[1]) || argv.length===3 && (!/^(?:0|[1-9][0-9]*)$/u.test(argv[2]) || !Number.isSafeInteger(Number(argv[2]))) : argv.length !== 1)) fail('INVALID_INPUT', 'Use get <requestId> [offset], or submit, revision or reply with bounded JSON on stdin.');
  if (Buffer.byteLength(stdin) > MAX_INPUT) fail('INPUT_TOO_LARGE');
  const action = argv[0]; let input;
  if (action === 'get') input = { requestId: argv[1],...(argv.length===3?{offset:Number(argv[2])}:{}) };
  else { try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdin)); } catch { fail('INVALID_INPUT'); } }
  const valid = action === 'get' && strict(input, ['requestId','offset']) && id(input.requestId) && (input.offset===undefined || Number.isSafeInteger(input.offset)&&input.offset>=0)
    || action === 'submit' && strict(input, ['requestId', 'translations',...stageKeys]) && validStage(input) && id(input.requestId) && Array.isArray(input.translations) && input.translations.length >= 1 && input.translations.every(row => strict(row, ['segmentId', 'text']) && id(row.segmentId) && text(row.text, MODEL_TOOL_BYTES))
    || action === 'revision' && strict(input, ['requestId', 'edits', 'reason',...stageKeys]) && validStage(input) && id(input.requestId) && text(input.reason, 8000) && input.reason.length > 0 && Array.isArray(input.edits) && input.edits.length >= 1 && input.edits.every(row => strict(row, ['segmentId', 'beforeHash', 'replacement']) && id(row.segmentId) && typeof row.beforeHash === 'string' && row.beforeHash.length >= 1 && row.beforeHash.length <= 128 && text(row.replacement, MODEL_TOOL_BYTES))
    || action === 'reply' && strict(input, ['messageId', 'text']) && id(input.messageId) && text(input.text, 65536) && input.text.length > 0;
  if (!valid || Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT) fail('INVALID_INPUT');
  return { action, input };
}
async function regular(filename, maximum) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || !samePath(await realpath(filename), filename)) fail('CALLBACK_INSTALLATION_INVALID');
  const bytes = await readFile(filename); if (bytes.length > maximum) fail('CALLBACK_INSTALLATION_INVALID'); return bytes;
}
async function installedConfiguration(pluginRoot) {
  try {
    if (typeof pluginRoot !== 'string' || !path.isAbsolute(pluginRoot)) fail('CALLBACK_INSTALLATION_INVALID');
    const info = await lstat(pluginRoot); if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(pluginRoot), pluginRoot)) fail('CALLBACK_INSTALLATION_INVALID');
    const json = async file => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await regular(path.join(pluginRoot, file), 1024 * 1024)));
    const [plugin, pkg, manifest, metadata] = await Promise.all(['plugin.json', 'package.json', 'dist/build-manifest.json', 'mcp.json'].map(json));
    if (plugin.name !== 'bilingual-paper-editor' || pkg.name !== plugin.name || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(plugin.version || '') || pkg.version !== plugin.version || manifest.version !== plugin.version) fail('CALLBACK_INSTALLATION_INVALID');
    const config = metadata.mcpServers?.['bilingual-paper-editor'], serverPath = path.join(pluginRoot, 'dist/server.mjs');
    if (!plain(config) || config.type !== 'stdio' || typeof config.command !== 'string' || !path.isAbsolute(config.command) || !/^node(?:\.exe)?$/iu.test(path.basename(config.command)) || !Array.isArray(config.args) || config.args.length !== 1 || typeof config.args[0] !== 'string' || !path.isAbsolute(config.args[0]) || !samePath(config.args[0], serverPath) || !plain(config.env) || config.env.PAPER_EDITOR_FULL_RUNTIME !== '1' || config.env.PAPER_EDITOR_INSTALL_VERSION !== plugin.version) fail('CALLBACK_INSTALLATION_INVALID');
    const node = await lstat(config.command); if (!node.isFile() || node.isSymbolicLink() || !samePath(await realpath(config.command), config.command)) fail('CALLBACK_INSTALLATION_INVALID');
    const server = await regular(serverPath, 32 * 1024 * 1024), expected = manifest.files?.['server.mjs'];
    if (!expected || !/^[a-f0-9]{64}$/u.test(expected.sha256 || '') || hash(server) !== expected.sha256 || expected.size !== server.length) fail('CALLBACK_INSTALLATION_INVALID');
    for (const [key, value] of Object.entries(config.env)) if (typeof value !== 'string' || value.length > 16384 || value.includes('\0') || !/^PAPER_EDITOR_[A-Z0-9_]+$/u.test(key) && !/^CODEX_(?:THREAD_ID|PROJECT_ID|HOME|APP_TOOLS_PIPE_PATH)$/iu.test(key)) fail('CALLBACK_INSTALLATION_INVALID');
    return config;
  } catch { fail('CALLBACK_INSTALLATION_INVALID', 'The installed callback configuration could not be verified. Reinstall the current workbench package.'); }
}
/** This is only a thin MCP transport. Desktop's already running turn performs
 * inference; the child exposes no independent model worker or source authority. */
export async function callDesktopCallback(parsed, { env = process.env, cwd = process.cwd(), pluginRoot = ROOT, ClientClass = Client, TransportClass = StdioClientTransport } = {}) {
  const origin = env.CODEX_THREAD_ID; if (!id(origin)) fail('HOST_CHAT_UNAVAILABLE', 'Run this callback only inside the originating Desktop chat.');
  if (!strict(parsed, ['action', 'input']) || !Object.hasOwn(tools, parsed.action) || !plain(parsed.input) || parsed.action === 'get' && !strict(parsed.input, ['requestId','offset'])) fail('INVALID_INPUT');
  // Re-run the same exact action schema for programmatic callers.
  const verified = parsed.action === 'get' ? parseDesktopCallback(['get', parsed.input?.requestId,...(parsed.input.offset===undefined?[]:[String(parsed.input.offset)])]) : parseDesktopCallback([parsed.action], Buffer.from(JSON.stringify(parsed.input)));
  const config = await installedConfiguration(pluginRoot), currentEnv = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string' && !/^CODEX_THREAD_ID$/iu.test(key)) currentEnv[key] = value;
  for (const [key, value] of Object.entries(config.env)) if (/^PAPER_EDITOR_/u.test(key)) currentEnv[key] = value;
  currentEnv.CODEX_THREAD_ID = origin;
  const transport = new TransportClass({ command: config.command, args: config.args, env: currentEnv, cwd, stderr: 'ignore', maxBufferSize: MODEL_TOOL_BYTES * 3 });
  const client = new ClientClass({ name: 'bilingual-desktop-callback', version: config.env.PAPER_EDITOR_INSTALL_VERSION });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tools[verified.action], arguments: verified.input }, undefined, { timeout: 180000 });
    if (result?.isError) fail(safeCode(result.structuredContent?.error?.code));
    if (!plain(result?.structuredContent) || Buffer.byteLength(JSON.stringify(result.structuredContent)) > MAX_OUTPUT) fail('CALLBACK_RESPONSE_INVALID');
    return structuredClone(result.structuredContent);
  } catch (error) { fail(safeCode(error?.code)); }
  finally { await client.close().catch(() => {}); }
}
async function stdinBytes() {
  const parts = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX_INPUT) fail('INPUT_TOO_LARGE'); parts.push(chunk); }
  return Buffer.concat(parts);
}
async function main() {
  try {
    if (!id(process.env.CODEX_THREAD_ID)) fail('HOST_CHAT_UNAVAILABLE');
    const argv = process.argv.slice(2), body = argv[0] === 'get' ? Buffer.alloc(0) : await stdinBytes(), parsed = parseDesktopCallback(argv, body);
    process.stdout.write(JSON.stringify(await callDesktopCallback(parsed)) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ error: { code: safeCode(error?.code) } }) + '\n'); process.exitCode = 2; }
}
// Bundle imports must never execute the CLI merely because a build constant is
// present. Only direct invocation of this exact module starts a callback.
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) void main();
