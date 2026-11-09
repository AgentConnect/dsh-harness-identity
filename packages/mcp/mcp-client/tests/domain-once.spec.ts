/** Real Loader and MCP SDK lifetimes; only the remote service and Host owners are fixtures. */
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import type { DomainOperationClient } from '../src/domain-consent.ts'
import type { MachineIdentityClient } from '../src/machine-types.ts'
import * as DomainConnector from '../src/domain.ts'
import { domainPolicyFixture } from './fixtures/domain-policy.ts'

const remote = vi.hoisted(() => ({
  resource: 'https://resource.example/mcp',
  advertisedScopes: ['agent.self.read', 'message.write'],
  tokens: [] as Array<{ value: string; scope: string }>,
  calls: [] as Array<{ token: string; method: string; params?: { name: string; arguments: Record<string, unknown> } }>,
  revoked: [] as string[],
  closed: [] as string[],
}))

vi.mock('../src/machine-http.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/machine-http.ts')>()
  return { ...original, machineFetch: async (input: string | URL | Request, init?: RequestInit, beforeSend?: () => Promise<void>) => {
    const request = new Request(input, init)
    // Exercise the physical-send assertion, not just the logical consent wrapper.
    await beforeSend?.()
    const json = (value: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } })
    if (request.url.includes('oauth-protected-resource')) return json({ resource: remote.resource, authorization_servers: ['https://issuer.example'], scopes_supported: remote.advertisedScopes })
    if (request.url.includes('oauth-authorization-server')) return json({ issuer: 'https://issuer.example', token_endpoint: 'https://issuer.example/token', revocation_endpoint: 'https://issuer.example/revoke', client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
    if (request.url === 'https://issuer.example/token') {
      const form = new URLSearchParams(await request.text())
      expect(form.get('grant_type')).toBe('client_credentials')
      expect(form.get('client_assertion')).toBe('private-owner-assertion')
      const token = { value: `private-once-token-${remote.tokens.length + 1}`, scope: form.get('scope') ?? '' }
      remote.tokens.push(token)
      return json({ access_token: token.value, token_type: 'Bearer', expires_in: 600, scope: token.scope })
    }
    if (request.url === 'https://issuer.example/revoke') {
      remote.revoked.push(new URLSearchParams(await request.text()).get('token') ?? '')
      return new Response(null, { status: 200 })
    }
    const token = remote.tokens.find(value => request.headers.get('authorization') === `Bearer ${value.value}`)
    if (request.url !== new URL(remote.resource).href || !token) throw new Error('Unexpected authenticated request')
    if (request.method === 'GET') return new Response(null, { status: 405 })
    if (request.method === 'DELETE') { remote.closed.push(token.value); return new Response(null, { status: 200 }) }
    const body = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } }
    remote.calls.push({ token: token.value, method: body.method, ...(body.params ? { params: body.params } : {}) })
    const result = (value: unknown) => json({ jsonrpc: '2.0', id: body.id, result: value })
    switch (body.method) {
      case 'server/discover': return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } })
      case 'initialize': return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'once-fixture', version: '1' } } }, { 'mcp-session-id': `session-${token.value}` })
      case 'notifications/initialized': return new Response(null, { status: 202 })
      case 'tools/list': return result({ tools: [
        { name: 'identity_get', description: 'Read identity.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: {} } },
        ...(token.scope.includes('message.write') ? [{ name: 'message_send', description: 'Send one message.', annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] : []),
      ] })
      case 'tools/call': return result({ content: [{ type: 'text', text: `done: ${remote.tokens.map(value => value.value).join(' ')} private-owner-assertion` }] })
      default: throw new Error('Unexpected MCP method')
    }
  } }
})

let context: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  remote.tokens.splice(0); remote.calls.splice(0); remote.revoked.splice(0); remote.closed.splice(0)
  remote.advertisedScopes = ['agent.self.read', 'message.write']
  remote.resource = 'https://resource.example/mcp'
})

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'mcp-domain-once-'))
  const stateRoot = join(directory, 'encrypted-state')
  const config = join(directory, 'cordis.yml')
  await writeFile(config, '- name: \'@fixture/domain-owner\'\n- name: \'@deepseek-ai/dsh-mcp-client/domain\'\n  config: { enabled: true, approvalWaitMs: 0 }\n')
  const records = new Map<CredentialKey, CredentialRecord>()
  const approvals: Array<{ requestId: string; purpose: string; body: string }> = []
  const grants = new Map<string, string>()
  const policy = domainPolicyFixture()
  const admittedScopes: string[][] = []
  let approve = true
  const signer: MachineIdentityClient = { async registerValidatedTarget(input) {
    admittedScopes.push([...input.requestedScopes])
    return { targetRef: Object.freeze({}), policyGeneration: 1, assertActive: async () => {},
      getOAuthClientIdentity: async () => ({ clientId: 'https://identity.example/client.json', keyId: 'identity#oauth', algorithm: 'ES256', version: 1, signerMode: 'local' }),
      signOAuthClientAssertion: async () => 'private-owner-assertion', dispose() {} }
  } }
  // This external owner fixture approves explicitly; the consumer gets no approval method.
  const owner: DomainOperationClient = {
    async executeAllowed(_request, _authorization, effect) { return effect(async () => {}, { machineIdentity: signer }) },
    async request(input) {
      const body = await input.request.text()
      approvals.push({ requestId: input.requestId, purpose: input.purpose, body })
      const id = `owner-${approvals.length}`
      if (!approve) return { id, version: 1, status: 'denied' }
      grants.set(id, body)
      return { id, version: 1, status: 'approved', grantId: id, mode: 'once' }
    },
    async status() { throw new Error('No pending owner dialog') },
    async cancel() { throw new Error('No pending owner dialog') },
    async execute(grantId, request, effect) {
      expect(await request.text()).toBe(grants.get(grantId))
      if (!grants.delete(grantId)) throw new Error('Grant already consumed')
      return effect(async () => {}, { machineIdentity: signer })
    },
  }
  let defaultEpoch = 'read-policy'
  const host = { name: 'domain-owner-fixture', apply(ctx: Context) {
    ctx.provide('credentials', { async modifyRecord(key: CredentialKey, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(records.get(key))
      if (next) records.set(key, next)
      return records.get(key)
    } })
    ctx.provide('anpIdentity', {
      bindProtocolPolicy: () => policy.client,
      bindDomainOperationConsumer: () => owner,
      bindProtocolConsumer: () => signer,
      resolveDomainAccess: async () => ({ identityRef: { storeId: 'store', identityId: 'identity', did: 'did:web:agent.example' }, policyRef: defaultEpoch, scopes: ['agent.self.read'], stateRoot }),
    })
  } }
  const ctx = context = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  const agent = await agents.create(SessionId('domain-once-agent'))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@fixture/domain-owner', host], ['@deepseek-ai/dsh-mcp-client/domain', DomainConnector]])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Missing Node module loader')
  ctx.loader.internal = { ...internal, import: async (name: string) => modules.get(name) }
  const load = async () => {
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
  }
  await load()
  const reload = async () => {
    const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-mcp-client/domain')
    if (!entry?.fiber) throw new Error('Missing domain connector fiber')
    await entry.fiber.dispose()
    await ctx.loader.create({ name: '@deepseek-ai/dsh-mcp-client/domain', config: { enabled: true, approvalWaitMs: 0 } })
    await ctx.loader.await()
  }
  let serial = 0
  const call = (name: string, args: Record<string, unknown>) => executeToolFixture(ctx, { agent, name, arguments: args, callId: ToolCallId(`once-${serial++}`), signal: new AbortController().signal })
  const connect = (scopes?: string[]) => call('mcp_connect', { domain: 'website.example', ...(scopes ? { scopes } : {}) })
  return { ctx, policy, records, approvals, admittedScopes, stateRoot, call, connect, reload, changeDefaultEpoch: () => { defaultEpoch += '-next' }, deny: () => { approve = false } }
}

function discoveredOperation(value: unknown): string {
  const result = value as { operations: Array<{ name: string; operationRef: string }> }
  const operation = result.operations.find(tool => tool.name === 'message_send')
  if (!operation) throw new Error('Missing discovered write operation')
  return operation.operationRef
}

it('uses separate metadata and exact-write approvals without widening the persistent read SDK session', async () => {
  const host = await fixture()
  const connected = await host.connect()
  expect(connected.value).toMatchObject({ ok: true, state: 'ready', readScopes: ['agent.self.read'] })
  const read = connected.value as { serverName: string }
  const persistent = remote.tokens[0]!
  const elevated = await host.connect(['message.write'])
  expect(elevated.value, JSON.stringify(elevated.value)).toMatchObject({ ok: true, mode: 'one-shot-discovery', persistentConnectionWidened: false })
  expect(host.approvals).toHaveLength(1)
  expect(JSON.parse(host.approvals[0]!.body)).toEqual({ protocol: 'mcp', resource: 'https://resource.example/mcp', issuer: 'https://issuer.example', tool: { name: '__mcp_tools_list__', arguments: {} }, scopes: ['message.write'] })
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(0)
  const args = { text: 'exact user-approved message' }
  const written = await host.call('mcp_call_once', { operationRef: discoveredOperation(elevated.value), arguments: args })
  expect(written.value).toMatchObject({ ok: true })
  expect(host.approvals).toHaveLength(2)
  expect(host.approvals[1]!.requestId).not.toBe(host.approvals[0]!.requestId)
  expect(JSON.parse(host.approvals[1]!.body)).toMatchObject({ tool: { name: 'message_send', arguments: args }, scopes: ['message.write'] })
  expect(remote.tokens.map(token => token.scope)).toEqual(['agent.self.read', 'message.write', 'message.write'])
  expect(remote.calls.filter(call => call.method === 'initialize').map(call => call.token)).toEqual(remote.tokens.map(token => token.value))
  expect(remote.calls.filter(call => call.method === 'tools/call')).toEqual([{ token: remote.tokens[2]!.value, method: 'tools/call', params: { name: 'message_send', arguments: args } }])
  expect(remote.revoked).toEqual(remote.tokens.slice(1).map(token => token.value))
  expect(host.admittedScopes).toEqual([['agent.self.read'], ['message.write'], ['message.write']])
  const readResult = await host.call(`mcp__${read.serverName}__identity_get`, {})
  expect(readResult.isError).not.toBe(true)
  expect(remote.calls.at(-1)).toMatchObject({ token: persistent.value, method: 'tools/call', params: { name: 'identity_get', arguments: {} } })
  expect(host.approvals).toHaveLength(2)
  expect(remote.tokens).toHaveLength(3)
  expect((await host.connect()).value).toMatchObject({ ok: true, readScopes: ['agent.self.read'] })
  for (const value of [connected, elevated, written, readResult]) {
    const visible = JSON.stringify(value)
    for (const token of remote.tokens) expect(visible).not.toContain(token.value)
    expect(visible).not.toContain('private-owner-assertion')
    expect(visible).not.toContain('client_assertion')
  }
  const inventory = [...host.records.values()].find(record => record.kind === 'grant')
  expect(inventory).toMatchObject({ kind: 'grant', payload: { version: 1, connections: [expect.stringMatching(/^once-/u), expect.stringMatching(/^once-/u)] } })
  expect([...host.records.values()].filter(record => record.kind === 'api-key')).toHaveLength(3)
  const ciphertext = await Promise.all((await readdir(host.stateRoot)).filter(file => file.endsWith('.json')).map(file => readFile(join(host.stateRoot, file), 'utf8')))
  expect(ciphertext.length).toBeGreaterThanOrEqual(3)
  for (const text of ciphertext) for (const token of remote.tokens) expect(text).not.toContain(token.value)
})

it('rejects fabricated operation references before requesting consent or acquiring a token', async () => {
  const host = await fixture()
  expect((await host.call('mcp_call_once', { operationRef: 'mcp-op-fabricated', arguments: { text: 'must not send' } })).value).toEqual({ ok: false, error: 'unknown_operation' })
  expect(host.approvals).toHaveLength(0)
  expect(remote.tokens).toHaveLength(0)
  expect(remote.calls).toHaveLength(0)
})
it('uses saved write permission without dialogs, then blocks revocation before acquiring another token', async () => {
  const host = await fixture(); host.policy.set('write', 'allow')
  const elevated = await host.connect(['message.write'])
  expect(elevated.value).toMatchObject({ ok: true, mode: 'one-shot-discovery' })
  const operationRef = discoveredOperation(elevated.value)
  expect((await host.call('mcp_call_once', { operationRef, arguments: { text: 'saved rule' } })).value).toMatchObject({ ok: true })
  expect(host.approvals).toHaveLength(0); expect(remote.tokens).toHaveLength(2)
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
  host.policy.set('write', 'deny')
  expect((await host.call('mcp_call_once', { operationRef, arguments: { text: 'not sent' } })).value).toEqual({ ok: false, error: 'protocol_permission_denied' })
  expect(remote.tokens).toHaveLength(2); expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
})
it('binds a write whitelist to the original discovery domain rather than a shared endpoint', async () => {
  const host = await fixture(); host.policy.whitelistWrite('website.example')
  expect((await host.connect(['message.write'])).value).toMatchObject({ ok: true })
  const before = remote.tokens.length
  expect((await host.call('mcp_connect', { domain: 'other.example', scopes: ['message.write'] })).value).toEqual({ ok: false, error: 'protocol_permission_denied' })
  expect(remote.tokens).toHaveLength(before); expect(host.approvals).toHaveLength(0)
})
it('automatically connects a service with intent:read instead of the legacy configured scope name', async () => {
  remote.advertisedScopes = ['intent:read', 'intent:write']
  const host = await fixture(), connected = await host.connect()
  expect(connected.value).toMatchObject({ ok: true, mode: 'one-shot-discovery', scopes: ['intent:read'] })
  const value = connected.value as { operations: { name: string; operationRef: string }[] }
  const operation = value.operations.find(item => item.name === 'identity_get')!
  expect((await host.call('mcp_call_once', { operationRef: operation.operationRef, arguments: {} })).value).toMatchObject({ ok: true })
  expect(host.approvals).toHaveLength(0); expect(remote.tokens.map(item => item.scope)).toEqual(['intent:read', 'intent:read'])
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
})
it('authenticates and invokes an MCP service whose protected resource is the bare HTTPS origin', async () => {
  remote.resource = 'https://resource.example'
  const host = await fixture(); host.policy.set('write', 'allow')
  const connected = await host.connect(['message.write'])
  expect(connected.value, JSON.stringify(connected.value)).toMatchObject({ ok: true, resource: remote.resource })
  expect((await host.call('mcp_call_once', { operationRef: discoveredOperation(connected.value), arguments: { text: 'bare-origin RPC' } })).value).toMatchObject({ ok: true })
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(1); expect(host.approvals).toHaveLength(0)
})
it('keeps authentication construction inside the admitted metadata context when read permission requires consent', async () => {
  const host = await fixture(); host.policy.set('read', 'ask')
  const connected = await host.connect()
  expect(connected.value, JSON.stringify(connected.value)).toMatchObject({ ok: true, state: 'ready' })
  expect(host.approvals).toHaveLength(1)
  const value = connected.value as { serverName: string }
  expect((await host.call(`mcp__${value.serverName}__identity_get`, {})).isError).not.toBe(true)
  expect(host.approvals).toHaveLength(2); expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
})

it('sends no elevated token or business request when the exact-write dialog is denied', async () => {
  const host = await fixture()
  const elevated = await host.connect(['message.write'])
  const operationRef = discoveredOperation(elevated.value)
  host.deny()
  expect((await host.call('mcp_call_once', { operationRef, arguments: { text: 'not approved' } })).value).toEqual({ ok: false, error: 'identity_authorization_denied' })
  expect(host.approvals).toHaveLength(2)
  expect(remote.tokens).toHaveLength(1)
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(0)
})

it('fails closed when the Host key for retained one-shot history disappears', async () => {
  const host = await fixture()
  const elevated = await host.connect(['message.write'])
  const inventory = [...host.records.values()].find(record => record.kind === 'grant')
  if (inventory?.kind !== 'grant') throw new Error('Missing retained history inventory')
  const payload = inventory.payload as { connections: string[] }
  const connectionId = payload.connections[0]!
  const key = credentialKey('mcp-domain', `key-${createHash('sha256').update(connectionId).digest('hex')}`)
  expect(host.records.delete(key)).toBe(true)
  const before = remote.calls.length
  expect((await host.call('mcp_call_once', { operationRef: discoveredOperation(elevated.value), arguments: { text: 'must not send' } })).value).toEqual({ ok: false, error: 'domain_history_unavailable' })
  expect(host.approvals).toHaveLength(1)
  expect(remote.tokens).toHaveLength(1)
  expect(remote.calls).toHaveLength(before)
  expect(host.records.has(key)).toBe(false)
})

it('restores old one-shot bearer redaction from protected history after connector reload', async () => {
  const host = await fixture()
  const elevated = await host.connect(['message.write'])
  expect(elevated.value).toMatchObject({ ok: true })
  const oldToken = remote.tokens[0]!.value
  expect(remote.revoked).toEqual([oldToken])
  await host.reload()
  const connected = await host.connect()
  expect(connected.value).toMatchObject({ ok: true, state: 'ready' })
  const read = connected.value as { serverName: string }
  const result = await host.call(`mcp__${read.serverName}__identity_get`, {})
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result)).toContain('done:')
  expect(JSON.stringify(result)).not.toContain(oldToken)
  expect(JSON.stringify(result)).not.toContain(remote.tokens[1]!.value)
  expect(remote.tokens.map(token => token.scope)).toEqual(['message.write', 'agent.self.read'])
  expect(host.approvals).toHaveLength(1)
})
it('redacts a retained bearer echoed by public discovery metadata, not only by business responses', async () => {
  const host = await fixture()
  expect((await host.connect(['message.write'])).value).toMatchObject({ ok: true })
  const oldToken = remote.tokens[0]!.value
  remote.advertisedScopes = ['agent.self.read', oldToken]
  const next = await host.connect()
  expect(next.value).toMatchObject({ ok: true })
  expect(JSON.stringify(next)).not.toContain(oldToken)
})

it('fresh explicit reconnect adopts a changed Host default epoch without reviving old SDK calls', async () => {
  const host = await fixture()
  const first = await host.connect()
  expect(first.value).toMatchObject({ ok: true, state: 'ready' })
  const connected = first.value as { serverName: string }
  const name = `mcp__${connected.serverName}__identity_get`
  expect((await host.call(name, {})).isError).not.toBe(true)
  const calls = remote.calls.filter(call => call.method === 'tools/call').length
  host.changeDefaultEpoch()
  expect((await host.call(name, {})).isError).toBe(true)
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(calls)
  expect((await host.connect()).value).toMatchObject({ ok: true, state: 'ready', serverName: connected.serverName })
  expect((await host.call(name, {})).isError).not.toBe(true)
  expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(calls + 1)
  expect(host.approvals).toHaveLength(0)
})
