import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeAppControl } from './native-app-control.mjs';

const NAME = 'bilingual-paper-editor';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? '<undefined>').digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
function others(config) { const copy = structuredClone(config); if (object(copy.mcp_servers)) { delete copy.mcp_servers[NAME]; if (!Object.keys(copy.mcp_servers).length) delete copy.mcp_servers; } return copy; }
function userLayer(result) {
  const layers = result?.layers?.filter(layer => layer.name?.type === 'user' && !layer.name.profile && !layer.disabledReason);
  if (layers?.length !== 1 || !object(layers[0].config) || typeof layers[0].version !== 'string' || !path.isAbsolute(layers[0].name.file || '')) fail('NATIVE_CONFIG_LAYER_UNAVAILABLE', 'Cannot resolve one versioned base user configuration; no settings were changed.');
  return layers[0];
}
export function nativeServerConfiguration(config) {
  if (!object(config) || config.type !== 'stdio' || typeof config.command !== 'string' || !path.isAbsolute(config.command) || !Array.isArray(config.args) || config.args.length !== 1 || typeof config.args[0] !== 'string' || !path.isAbsolute(config.args[0]) || !/[\\/]dist[\\/]server\.mjs$/i.test(config.args[0]) || !object(config.env)) fail('INVALID_NATIVE_MCP_CONFIG', 'Use the exact installed STDIO paper server configuration.');
  if (Object.entries(config.env).some(([key, value]) => !/^PAPER_EDITOR_[A-Z0-9_]+$/.test(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) || config.env.PAPER_EDITOR_FULL_RUNTIME !== '1') fail('INVALID_NATIVE_MCP_CONFIG', 'The installed paper server needs its bounded full-runtime environment.');
  return { command: config.command, args: [...config.args], env: { ...config.env }, enabled: true, startup_timeout_sec: 120, tool_timeout_sec: 600 };
}

/** Configuration only: no thread start/resume, model call, source read or MCP
 * server tool call. Configuration bodies remain in memory and are never logged.
 */
export async function configureNativeMcp({ client, serverConfig, dryRun = false }) {
  if (!client || typeof client.request !== 'function' || typeof dryRun !== 'boolean') throw new TypeError('A native configuration client and boolean dryRun are required.');
  const desired = nativeServerConfiguration(serverConfig);
  const before = await client.request('config/read', { includeLayers: true });
  const layer = userLayer(before), existing = layer.config.mcp_servers?.[NAME];
  if (existing !== undefined && (!object(existing) || !samePath(existing.command, desired.command) || !Array.isArray(existing.args) || existing.args.length !== desired.args.length || existing.args.some((arg, i) => !samePath(arg, desired.args[i])))) fail('NATIVE_MCP_NAME_CONFLICT', 'A different server already uses bilingual-paper-editor; no configuration was overwritten.');
  const replacement = { ...(existing || {}), ...desired, env: { ...(existing?.env || {}), ...desired.env } };
  const otherBeforeHash = hash(others(layer.config));
  const summary = { serverName: NAME, configurationOnly: true, desktopClosureVerified: false, dryRun, existingServer: existing !== undefined, startupTimeoutSeconds: 120, toolTimeoutSeconds: 600, otherConfigurationHash: otherBeforeHash, sourceWriteback: 'human_ui_only', reloadOrRestartRequired: true };
  if (dryRun) return { ...summary, changed: existing === undefined || hash(existing) !== hash(replacement), otherConfigurationPreserved: true };
  if (existing !== undefined && hash(existing) === hash(replacement)) return { ...summary, changed: false, otherConfigurationPreserved: true, configured: true };
  const written = await client.request('config/batchWrite', { filePath: layer.name.file, expectedVersion: layer.version, reloadUserConfig: true, edits: [{ keyPath: `mcp_servers.${NAME}`, mergeStrategy: 'replace', value: replacement }] });
  if (!samePath(written?.filePath, layer.name.file) || typeof written.version !== 'string') fail('NATIVE_CONFIG_WRITE_UNVERIFIED', 'The native configuration write did not return its exact target revision.');
  const after = await client.request('config/read', { includeLayers: true }), updated = userLayer(after);
  if (!samePath(updated.name.file, layer.name.file) || hash(others(updated.config)) !== otherBeforeHash) fail('NATIVE_CONFIG_PRESERVATION_FAILED', 'Unrelated user configuration changed during registration; inspect the current configuration before retrying.');
  if (hash(updated.config.mcp_servers?.[NAME]) !== hash(replacement)) fail('NATIVE_CONFIG_WRITE_UNVERIFIED', 'The saved paper MCP section differs from the requested exact configuration.');
  const effective = after.config?.mcp_servers?.[NAME];
  if (effective && (!samePath(effective.command, desired.command) || effective.enabled === false)) fail('NATIVE_CONFIG_OVERRIDDEN', 'The paper MCP configuration is saved but overridden by another configuration layer.');
  return { ...summary, changed: true, configured: true, otherConfigurationPreserved: true, version: written.version };
}

async function main() {
  const args = process.argv.slice(2), dryRun = args.includes('--dry-run'), flag = args.indexOf('--installed-root');
  if (flag < 0 || !args[flag + 1] || args.some((arg, i) => arg !== '--dry-run' && i !== flag && i !== flag + 1)) fail('INVALID_INPUT', 'Use --installed-root <absolute installed plugin directory> [--dry-run].');
  const root = args[flag + 1]; if (!path.isAbsolute(root)) fail('INVALID_INPUT', 'Use an absolute installed plugin directory.');
  const filename = path.join(root, 'mcp.json'), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) fail('INVALID_NATIVE_MCP_CONFIG', 'Installed MCP metadata is aliased or oversized.');
  const metadata = JSON.parse(await readFile(filename, 'utf8')), config = metadata?.mcpServers?.[NAME];
  nativeServerConfiguration(config);
  const command = config.env.PAPER_EDITOR_CODEX_COMMAND;
  if (typeof command !== 'string' || !path.isAbsolute(command)) fail('INVALID_NATIVE_MCP_CONFIG', 'The installed native Codex executable is unavailable.');
  const client = new NativeAppControl({ command, transportMode: 'configuration', requestTimeoutMs: 45000, clientInfo: { name: 'bilingual_paper_mcp_configuration', title: 'Paper MCP Configuration', version: '1.5.2' } });
  try { await client.open(); const report = await configureNativeMcp({ client, serverConfig: config, dryRun }); process.stdout.write(JSON.stringify(report) + '\n'); }
  finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'NATIVE_MCP_CONFIGURATION_FAILED', rpcCode: error.rpcCode ?? null, rpcMethod: error.rpcMethod ?? null, processExitCode: error.exitCode ?? null, signal: error.signal ?? null, message: error.code && error.code !== 'NATIVE_RPC_ERROR' ? error.message : 'Native MCP configuration failed; no private protocol body was logged.' }) + '\n'); process.exitCode = 1; });
