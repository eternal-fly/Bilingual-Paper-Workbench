import readline from 'node:readline';
let thread = 'synthetic-paper-thread', model = '', effort = '', turn = 0;
const globalMcp = process.argv.includes('--global-mcp');
const unreadableMcp = process.argv.includes('--unreadable-mcp');
const malformedMcp = process.argv.includes('--malformed-mcp');
const malformedCursorIndex = process.argv.indexOf('--malformed-mcp-cursor');
const malformedMcpCursor = malformedCursorIndex < 0 ? null : JSON.parse(process.argv[malformedCursorIndex + 1]);
let configReads = 0, activeMcpServers = [], dynamicTools = [], forwardedCredential = false, transientThread = false;
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => output({ jsonrpc: '2.0', method, params });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) return;
  const p = message.params || {};
  const reply = result => output({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ userAgent: 'synthetic' });
  if (message.method === 'initialized') return;
  if (message.method === 'config/read') {
    configReads++;
    if (unreadableMcp) return output({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Synthetic unsupported config inventory' } });
    if (malformedMcp) return reply({ config: { mcp_servers: ['not-a-server-map'] } });
    const mcp_servers = globalMcp ? { 'bilingual-paper-editor': { command: 'synthetic-native-mcp', env: { SYNTHETIC_TOKEN: 'synthetic-private-token' } }, 'research.notes': { url: 'https://synthetic.invalid/mcp' }, ...(configReads > 1 ? { 'newly-added-server': { command: 'synthetic-added-later' } } : {}) } : {};
    return reply({ config: { mcp_servers, unrelated_private_option: 'synthetic-private-token' }, origins: {} });
  }
  if (message.method === 'model/list') return reply({ data: [{ id: 'model-a', model: 'model-a', displayName: 'Model A', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.method === 'thread/start') transientThread = Boolean(p.ephemeral);
    if (message.method === 'thread/resume' && transientThread && process.argv.includes('--ephemeral-cannot-resume')) return output({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'no rollout found for ephemeral thread' } });
    if (p.environments?.length || p.permissions !== ':read-only' || p.sandbox || p.approvalPolicy !== 'never') throw new Error('unsafe thread settings');
    model = p.model; effort = p.config?.model_reasoning_effort; thread = p.threadId || thread;
    const known = globalMcp ? ['bilingual-paper-editor', 'research.notes', ...(configReads > 1 ? ['newly-added-server'] : [])] : [];
    activeMcpServers = known.filter(name => process.argv.includes('--ignore-mcp-disable') || p.config?.mcp_servers?.[name]?.enabled !== false);
    if (p.dynamicTools) dynamicTools = p.dynamicTools.map(tool => tool.name);
    forwardedCredential = JSON.stringify(p.config).includes('synthetic-private-token');
    return reply({ thread: { id: thread, name: 'Synthetic paper chat', cwd: p.cwd }, model: process.env.CODEX_FAKE_MODEL_MISMATCH ? 'wrong-model' : model, modelProvider: 'synthetic', reasoningEffort: effort, approvalPolicy: 'never', activePermissionProfile: { id: ':read-only' }, sandbox: { type: 'readOnly' } });
  }
  if (message.method === 'thread/name/set') return reply({});
  if (message.method === 'mcpServerStatus/list') return reply({ data: activeMcpServers.map(name => ({ name, authStatus: 'unsupported', tools: { native_tool: { name: 'native_tool', inputSchema: { type: 'object' } } }, runtimeStatus: 'connected', resources: [], resourceTemplates: [] })), nextCursor: malformedMcpCursor });
  if (message.method === 'turn/interrupt') { notify('turn/completed', { threadId: thread, turn: { id: p.turnId, status: 'interrupted' } }); return reply({}); }
  if (message.method === 'turn/start') {
    if (p.environments?.length || p.permissions !== ':read-only' || p.sandboxPolicy || p.approvalPolicy !== 'never') throw new Error('unsafe turn settings');
    const id = `turn-${++turn}`; reply({ turn: { id, status: 'inProgress' } });
    const prompt = p.input[0].text;
    setTimeout(() => {
      if (prompt === 'exit') { process.exit(2); return; }
      if (prompt === 'wait') return;
      if (prompt === 'unicode') {
        const text = '中文🙂逐字流式回包';
        const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: thread, turnId: id, itemId: `answer-${id}`, delta: text } }) + '\n');
        const split = bytes.indexOf(Buffer.from('中')) + 1;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => {
          process.stdout.write(bytes.subarray(split));
          notify('item/completed', { threadId: thread, turnId: id, item: { id: `answer-${id}`, type: 'agentMessage', text } });
          notify('turn/completed', { threadId: thread, turn: { id, status: 'completed' } });
        }, 15);
        return;
      }
      notify('item/agentMessage/delta', { threadId: 'foreign-thread', turnId: id, itemId: 'foreign', delta: 'must-not-appear' });
      if (prompt === 'tool') output({ jsonrpc: '2.0', id: 'dynamic-1', method: 'item/tool/call', params: { threadId: thread, turnId: id, callId: 'call-1', tool: 'paper_compile', arguments: { reason: 'selected preview' } } });
      const text = prompt === 'inspect-mcp-context' ? JSON.stringify({ activeMcpServers, dynamicTools, configReads, forwardedCredential }) : prompt === 'review-output' ? '中'.repeat(100000) : p.outputSchema ? '{"requestId":"req-one","ok":true}' : 'Synthetic response';
      notify('item/agentMessage/delta', { threadId: thread, turnId: id, itemId: `answer-${id}`, delta: text.slice(0, 9) });
      notify('item/agentMessage/delta', { threadId: thread, turnId: id, itemId: `answer-${id}`, delta: text.slice(9) });
      notify('item/completed', { threadId: thread, turnId: id, item: { id: `answer-${id}`, type: 'agentMessage', text } });
      notify('turn/completed', { threadId: thread, turn: { id, status: prompt === 'fail' ? 'failed' : 'completed', error: prompt === 'fail' ? { message: 'synthetic failure' } : null } });
    }, 10);
    return;
  }
  output({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported synthetic method' } });
});
