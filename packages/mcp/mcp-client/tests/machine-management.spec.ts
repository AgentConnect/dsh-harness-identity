import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
/** Real Loader, authenticated user carrier, Typert and SDK lifecycle; remote identity/AS are fixtures. */
import { createServer } from 'node:http'
import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '../src/index.ts'
import Management from '../src/management.ts'
import ManagementRemote from '../src/management-remote.ts'
import type { MachineConnectionStatus } from '../src/management-types.ts'
import { MachineConnectionStore } from '../src/machine-store.ts'

const remoteName = '@deepseek-ai/dsh-mcp-client/management-remote'
const f = vi.hoisted(() => ({ tokens: 0, requests: 0, revocations: 0, leases: 0,
  permitted: true, echo: false, echoName: false, echoError: false, failInit: false,
  history: [] as string[], assertions: [] as string[], echoProof: false,
  proofSigner: undefined as (() => string) | undefined, proofVerifier: undefined as ((value: string) => boolean) | undefined,
  leaseHook: undefined as (() => Promise<void>) | undefined, toolReturned: false, failList: false, foreignError: '',
  holdSdkError: undefined as (() => Promise<void>) | undefined,
  holdTool: undefined as (() => Promise<void>) | undefined,
  holdIdentity: undefined as (() => Promise<void>) | undefined, holdToken: undefined as (() => Promise<void>) | undefined }))
vi.mock('../src/machine-http.ts', async (original) => {
  const value = await original<typeof import('../src/machine-http.ts')>()
  return { ...value, machineFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
    if (req.url.includes('oauth-protected-resource')) return json({ resource: 'https://resource.example/mcp', authorization_servers: ['https://auth.example'] })
    if (req.url.includes('oauth-authorization-server')) return json({ issuer: 'https://auth.example', token_endpoint: 'https://auth.example/token', revocation_endpoint: 'https://auth.example/revoke', client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
    if (req.url === 'https://auth.example/token') {
      const form = new URLSearchParams(await req.text())
      expect(form.get('grant_type')).toBe('client_credentials')
      const assertion = form.get('client_assertion') ?? ''
      f.assertions.push(assertion)
      if (f.proofVerifier) expect(f.proofVerifier(assertion)).toBe(true)
      const token = `private-token-${++f.tokens}`; await f.holdToken?.()
      return json({ access_token: token, token_type: 'Bearer', expires_in: 300, scope: 'agent.self.read' })
    }
    if (req.url === 'https://auth.example/revoke') { f.revocations++; return new Response(null, { status: 200 }) }
    if (req.url !== 'https://resource.example/mcp') throw new Error('unexpected_fixture_origin')
    f.requests++
    const bearer = req.headers.get('authorization')?.replace(/^Bearer /u, '') ?? ''
    if (bearer && !f.history.includes(bearer)) f.history.push(bearer)
    if (req.method === 'GET' || req.method === 'DELETE') return new Response(null, { status: 405 })
    const body = await req.json() as { id?: number; method: string }
    if (body.method === 'initialize' && f.failInit || body.method === 'tools/list' && f.failList) {
      await f.holdSdkError?.()
      const echo = f.foreignError || bearer
      return json({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: `untrusted ${echo}`, data: { [echo]: echo } } })
    }
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: f.echo ? bearer : 'fixture', version: '1' } } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: f.echoName ? `identity_${bearer}` : 'identity_get', description: f.echo ? `business ${bearer}` : 'Read machine identity.', inputSchema: { type: 'object', ...(f.echo ? { description: bearer, properties: { [bearer]: { type: 'string', description: bearer } } } : {}) } }] } })
    if (f.echoName && body.method === 'tools/call') expect((body as { params?: { name?: string } }).params?.name).toBe(`identity_${f.history[0]}`)
    await f.holdTool?.()
    f.toolReturned = true
    if (f.echoProof) return json({ jsonrpc: '2.0', id: body.id, result: {
      content: [{ type: 'text', text: `ordinary proof=${f.assertions[0]}` }],
      structuredContent: { unrelated: f.assertions[0], [f.assertions[0]!]: true }, ...(f.echoError ? { isError: true } : {}),
    } })
    if (f.echo) return json({ jsonrpc: '2.0', id: body.id, result: {
      content: [{ type: 'text', text: `business current=${bearer} historical=${f.history[0]}` }],
      structuredContent: { unrelated_property: bearer, [bearer]: 'private-key-value', previous: f.history[0], '■■■': 'ordinary-collision' },
      ...(f.echoError ? { isError: true } : {}),
    } })
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'machine' }] } })
  } }
})
const roots: string[] = []
const contexts: Context[] = []
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  Object.assign(f, { tokens: 0, requests: 0, revocations: 0, leases: 0, permitted: true,
    echo: false, echoName: false, echoError: false, failInit: false, history: [],
    holdTool: undefined, holdIdentity: undefined, holdToken: undefined, assertions: [], echoProof: false,
    proofSigner: undefined, proofVerifier: undefined, leaseHook: undefined, toolReturned: false,
    failList: false, foreignError: '', holdSdkError: undefined })
})
async function boot(allowed = true) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-managed-host-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  const routes: WebRoute[] = []
  ctx.provide('webServer', { port: 0, tapIndex: () => () => {}, register(route: WebRoute) {
    routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) }
  } } as unknown as WebServer)
  const host = { name: 'identity-and-AS-fixture', apply(scope: Context) {
    const records = new Map<unknown, unknown>()
    scope.provide('credentials', { resolve: async () => ({ value: Buffer.alloc(32, 29).toString('base64url') }),
      async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>) {
        const current = records.get(key); const next = await mutate(current)
        if (next !== undefined) records.set(key, next)
        return next ?? current
      },
    } as never)
    scope.provide('anpIdentity', { bindProtocolConsumer: () => ({ registerValidatedTarget: async () => {
      f.leases++
      if (!f.permitted) throw new Error('fixture_permission_denied')
      const targetRef = Object.freeze({})
      return { targetRef, policyGeneration: f.leases, assertActive: async () => { if (!f.permitted) throw new Error('fixture_permission_denied'); await f.leaseHook?.() },
        getOAuthClientIdentity: async () => { await f.holdIdentity?.(); return { clientId: 'https://identity.example/client.json', algorithm: 'ES256', signerMode: 'local', keyId: 'key', version: 1 } },
        signOAuthClientAssertion: async () => f.proofSigner?.() ?? 'fixture-assertion', dispose() {} }
    } }) } as never)
  } }
  const config = join(root, 'cordis.yml')
  await writeFile(config, `- name: '@fixture/host'\n- name: '@deepseek-ai/dsh-system-prompt'\n- name: '@deepseek-ai/dsh-tools'\n- name: '@deepseek-ai/dsh-typert-registry'\n- name: '@deepseek-ai/dsh-client-connection'\n- name: '@deepseek-ai/dsh-api-gateway'\n- name: '@deepseek-ai/dsh-mcp-client/management'\n  config:\n    managerConsumers: ${allowed ? `[${JSON.stringify(remoteName)}]` : '[]'}\n- id: manager\n  name: '${remoteName}'\n- id: machine\n  name: '@deepseek-ai/dsh-mcp-client'\n  inject: [mcpConnections, anpIdentity, credentials]\n  config:\n    serverName: managed\n    transport: streamable-http\n    url: https://resource.example/mcp\n    failOnStartupError: true\n    reconnect: { enabled: false }\n    authentication:\n      mode: cimd-client-credentials\n      connectionId: managed\n      identityRef: { storeId: store, identityId: identity, did: 'did:web:identity.example' }\n      policyRef: approved\n      requestedScopes: [agent.self.read]\n      stateRoot: ${JSON.stringify(join(root, 'state'))}\n      encryptionKeyRef: MCP_KEY\n`)
  const modules = new Map<string, unknown>([['@fixture/host', host], ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-typert-registry', TypertRegistry], ['@deepseek-ai/dsh-client-connection', Connection], ['@deepseek-ai/dsh-api-gateway', Gateway], ['@deepseek-ai/dsh-mcp-client/management', Management], [remoteName, ManagementRemote], ['@deepseek-ai/dsh-mcp-client', McpClient]])
  ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', import: async (name: string) => { if (!modules.has(name)) throw new Error('unknown_fixture_module'); return modules.get(name) } } as never
  const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const route = routes.find(route => route.path === '/api')!
  const server = createServer((req, res) => { void route.handler(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const connection = ctx.get('connection')!
  const launch = new URL(connection.authenticatedUrl(origin))
  let cookie = ''
  connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host: launch.host } }, {
    writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] ?? '' }, end() {},
  })
  const call = async (method: string, authenticated = true, args: unknown = { connectionId: 'managed' }) => {
    const result = await fetch(`${origin}/api/mcpConnections/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId: 'management', method: `mcpConnections/${method}`, payload: { args } }) })
    if (result.status !== 200) return { status: result.status }
    return (await result.json() as { result: { ok: boolean; value?: MachineConnectionStatus; error?: unknown } }).result
  }
  return { ctx, call, entry, store: new MachineConnectionStore(join(root, 'state'), 'managed', async () => Buffer.alloc(32, 29)),
    machine: [...ctx.loader.entries()].find(value => value.options.id === 'machine')!, manager: [...ctx.loader.entries()].find(value => value.options.id === 'manager')! }
}

it.each([true, false])('revalidates expired discovery before a tool call while retaining permission checks (%s)', async (permitted) => {
  const b = await boot()
  const execute = () => executeToolFixture(b.ctx, { name: 'mcp__managed__identity_get', arguments: {}, callId: ToolCallId('expired-target'), signal: new AbortController().signal })
  expect((await execute()).isError).toBe(false)
  const requests = f.requests
  const leases = f.leases
  const now = Date.now() + 300001
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    f.permitted = permitted
    expect((await execute()).isError).toBe(!permitted)
    expect(f.tokens).toBe(permitted ? 2 : 1)
    if (permitted) expect(f.leases).toBeGreaterThan(leases)
    else expect(f.requests).toBe(requests)
  } finally { clock.mockRestore() }
})

it('withholds a result when discovery expires during the tool operation without replay', async () => {
  const b = await boot()
  let release!: () => void
  let entered = false
  const held = new Promise<void>((resolve) => { release = resolve })
  f.holdTool = async () => { entered = true; await held }
  const pending = executeToolFixture(b.ctx, { name: 'mcp__managed__identity_get', arguments: {}, callId: ToolCallId('expiring-result'), signal: new AbortController().signal })
  try {
    await vi.waitFor(() => { expect(entered).toBe(true) })
    const requests = f.requests
    const leases = f.leases
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001)
    try {
      release()
      expect((await pending).isError).toBe(true)
      expect(f.requests).toBe(requests)
      expect(f.tokens).toBe(1)
      expect(f.leases).toBe(leases)
    } finally { clock.mockRestore() }
  } finally {
    release()
    await pending
  }
})

it('uses protected user Remote to stop SDK/tools, retains disabled across Loader restart, and explicitly reauthorizes enablement', async () => {
  const b = await boot()
  expect(await b.call('status', false)).toEqual({ status: 401 })
  expect(await b.call('status')).toMatchObject({ ok: true, value: { state: 'ready', authentication: 'token_ready' } })
  expect(await b.call('status')).toMatchSnapshot('authenticated machine status')
  expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeDefined()
  expect(await b.call('disconnect')).toMatchObject({ ok: true, value: { state: 'disconnected', authentication: 'stopped', remoteRevocation: 'confirmed' } })
  expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeUndefined()
  expect(f.revocations).toBe(1)
  const disabled = await b.store.state()
  await b.machine.update({ disabled: true }); await b.machine.update({ disabled: false })
  expect(f.tokens).toBe(1)
  expect(f.leases).toBe(1)
  expect(await b.call('status')).toMatchObject({ ok: true, value: { state: 'disconnected' } })
  f.permitted = false
  expect(await b.call('enable')).toMatchObject({ ok: false })
  expect(await b.store.state()).toEqual(disabled)
  f.permitted = true
  expect(await b.call('enable')).toMatchObject({ ok: true, value: { state: 'ready', authentication: 'token_ready' } })
  expect(f.tokens).toBe(2); expect(f.leases).toBe(3)
  expect((await b.store.state())!.generation).toBeGreaterThan(disabled!.generation)
  expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeDefined()
  const beforeUnload = await b.store.state()
  await b.machine.update({ disabled: true })
  expect(await b.store.state()).toEqual(beforeUnload)
  expect(f.revocations).toBe(1)
  await b.machine.update({ disabled: false })
  expect(f.tokens).toBe(3)
  const result = JSON.stringify(await b.call('status'))
  for (const secret of ['private-token', 'assertion', 'MCP_KEY', 'https://', 'policyRef', 'identityRef']) expect(result).not.toContain(secret)
})

it('refuses an unapproved manager even when loaded by the real Loader', async () => {
  await expect(boot(false)).rejects.toThrow('manager_forbidden')
})

it('rechecks the manager after a signer await and preserves the disabled fence', async () => {
  const b = await boot(); await b.call('disconnect')
  const disabled = await b.store.state()
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  f.holdIdentity = async () => { entered(); await held }
  const enabling = b.call('enable')
  await waiting
  await b.manager.update({ disabled: true })
  release()
  expect(await enabling).toMatchObject({ ok: false })
  expect(await b.store.state()).toEqual(disabled)
  expect(f.tokens).toBe(1)
  expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeUndefined()
})

it('CAS enablement cannot overwrite a newer disabled fence or admit an old writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-enable-cas-')); roots.push(root)
  const store = new MachineConnectionStore(root, 'cas', async () => Buffer.alloc(32, 9))
  const old = await store.open('old'); await store.disable()
  const fence = (await store.state())!.generation
  await expect(store.enable(fence, 'new', async () => { throw new Error('revoked') })).rejects.toThrow('revoked')
  expect(await store.state()).toEqual({ generation: fence, active: false })
  const enabled = await store.enable(fence, 'new', async () => {})
  await expect(store.commit(old, { partition: 'old', token: 'stale', acquiredAt: Date.now(), expiresAt: Date.now() + 60000, scopes: [] })).rejects.toThrow('connection_generation_changed')
  await expect(store.enable(fence, 'stale', async () => {})).rejects.toThrow('connection_generation_changed')
  await store.disable(enabled); await store.disable(enabled)
  expect(await store.state()).toEqual({ generation: enabled + 1, active: false })
})

it('loads omitted and explicit none HTTP authentication through the actual Loader while rejecting partial machine configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-anonymous-schema-')); roots.push(root)
  let businessRequests = 0
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405); res.end(); return }
    let raw = ''; for await (const chunk of req) raw += String(chunk)
    const message = JSON.parse(raw) as { id?: number; method: string }
    businessRequests++
    expect(req.headers.authorization).toBe('Bearer fixture-static')
    res.setHeader('content-type', 'application/json')
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'anonymous-fixture', version: '1' } }
      : { tools: [{ name: 'identity_get', description: 'Fixture.', inputSchema: { type: 'object' } }] }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  async function load(authentication: string, id: number) {
    const ctx = new Context(); contexts.push(ctx); ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-mcp-client', McpClient]])
    ctx.loader.internal = { version: 'v2', import: async (name: string) => modules.get(name) } as never
    const config = join(root, `anonymous-${id}.yml`)
    await writeFile(config, `- name: '@deepseek-ai/dsh-system-prompt'\n- name: '@deepseek-ai/dsh-tools'\n- id: scoped-mcp\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    transport: streamable-http\n    serverName: scoped\n    url: ${endpoint}\n    headers: { Authorization: 'Bearer fixture-static' }\n    failOnStartupError: true\n    reconnect: { enabled: false }\n${authentication}`)
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
    return ctx
  }
  for (const [i, value] of ['', '    authentication: { mode: none }\n'].entries()) {
    const ctx = await load(value, i)
    expect(ctx.tools.get('mcp__scoped__identity_get')).toBeDefined()
    await ctx.fiber.dispose()
  }
  const before = businessRequests
  for (const [i, value] of ['{ mode: cimd-client-credentials }', '{ mode: unsupported }', '{}', 'null'].entries()) {
    await expect(load(`    authentication: ${value}\n`, i + 10)).rejects.toThrow()
  }
  expect(businessRequests).toBe(before)
})

it('rolls back its own activation when management is revoked while the Token response is pending', async () => {
  const b = await boot(); await b.call('disconnect')
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  f.holdToken = async () => { entered(); await held }
  const enabling = b.call('enable'); await waiting
  expect((await b.store.state())!.active).toBe(true)
  await b.manager.update({ disabled: true }); release()
  expect(await enabling).toMatchObject({ ok: false, error: { code: 'mcp/management-refused' } })
  expect((await b.store.state())!.active).toBe(false)
  expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeUndefined()
})

it('disconnects during an enable flight without reviving its token or tools', async () => {
  const b = await boot(); await b.call('disconnect')
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  f.holdToken = async () => { entered(); await held }
  const enabling = b.call('enable'); await waiting
  const stopping = b.call('disconnect')
  await expect.poll(async () => (await b.store.state())!.active).toBe(false)
  release()
  expect(await enabling).toMatchObject({ ok: false })
  expect(await stopping).toMatchObject({ ok: true, value: { state: 'disconnected', remoteRevocation: 'remote_revocation_unconfirmed' } })
  expect((await b.store.state())!.active).toBe(false)
  expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeUndefined()
})

it('does not let failed enable rollback disable another process activation with the same generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-enable-owner-')); roots.push(root)
  const store = new MachineConnectionStore(root, 'owner', async () => Buffer.alloc(32, 9))
  await store.open('old'); await store.disable(); const disabled = (await store.state())!.generation
  const winner = await store.enable(disabled, 'winner', async () => {}, 'winner-activation-123')
  await expect(store.enable(disabled, 'loser', async () => {}, 'loser-activation-123')).rejects.toThrow('connection_generation_changed')
  await store.disable(undefined, 'loser-activation-123')
  expect(await store.state()).toEqual({ generation: winner, active: true })
  await store.clear(winner, 'winner')
  await store.disable(undefined, 'winner-activation-123')
  expect(await store.state()).toEqual({ generation: winner + 1, active: false })
})

it('reports blocked and unconfirmed when durable disconnect fails while still closing SDK and tools', async () => {
  const b = await boot()
  const failing = vi.spyOn(MachineConnectionStore.prototype, 'disable').mockRejectedValueOnce(new Error('private-provider-error'))
  try {
    expect(await b.call('disconnect')).toMatchObject({ ok: false, error: { code: 'mcp/management-refused' } })
    expect(await b.call('status')).toMatchObject({ ok: true, value: { state: 'blocked', authentication: 'stopped', remoteRevocation: 'remote_revocation_unconfirmed' } })
    expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeUndefined()
    expect((await b.store.state())!.active).toBe(true)
    expect(await b.call('disconnect')).toMatchObject({ ok: true, value: { state: 'disconnected' } })
  } finally { failing.mockRestore() }
})

it('protects actual Loader SDK tool schemas, arbitrary result keys/values and historical bearer echoes', async () => {
  f.echo = true
  const b = await boot()
  const execute = () => executeToolFixture(b.ctx, { name: 'mcp__managed__identity_get', arguments: {}, callId: ToolCallId('echo'), signal: new AbortController().signal })
  const first = await execute()
  expect(first.isError).toBe(false)
  expect(JSON.stringify(first).includes('business')).toBe(true)
  expect(JSON.stringify(b.ctx.tools.schemas()).includes(f.history[0]!)).toBe(false)
  expect(JSON.stringify(first).includes(f.history[0]!)).toBe(false)
  const structured = (first as { value?: { structuredContent?: Record<string, unknown> } }).value?.structuredContent
  expect(Object.values(structured ?? {}).includes('ordinary-collision')).toBe(true)
  await b.call('disconnect'); await b.call('enable')
  expect(f.tokens).toBe(2)
  const second = await execute()
  for (const token of f.history) expect(JSON.stringify(second).includes(token)).toBe(false)
  f.echoError = true
  const error = await execute()
  expect(error.isError).toBe(true)
  for (const token of f.history) {
    expect(JSON.stringify(error).includes(token)).toBe(false)
    expect(JSON.stringify(b.ctx.logger.buffer).includes(token)).toBe(false)
  }
})

it('contains SDK initialize error echoes in both startup causes and Host logs', async () => {
  f.failInit = true
  let failure: unknown
  try { await boot() } catch (error) { failure = error }
  expect(failure).toBeDefined()
  const ctx = contexts.at(-1)!
  const observed = JSON.stringify(ctx.logger.buffer) + String(failure) + String((failure as Error)?.cause)
  for (const token of f.history) expect(observed.includes(token)).toBe(false)
  expect(f.history.length).toBeGreaterThan(0)
})

it('rejects a late SDK result after current C permission is revoked', async () => {
  f.echo = true
  const b = await boot()
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  f.holdTool = async () => { entered(); await held }
  const result = executeToolFixture(b.ctx, { name: 'mcp__managed__identity_get', arguments: {}, callId: ToolCallId('late-revocation'), signal: new AbortController().signal })
  await waiting; f.permitted = false; release()
  const received = await result
  expect(received.isError).toBe(true)
  expect(JSON.stringify(received).includes('business current=')).toBe(false)
  for (const token of f.history) expect(JSON.stringify(received).includes(token)).toBe(false)
})

it('rejects a late SDK result after explicit connection disablement', async () => {
  f.echo = true
  const b = await boot()
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  f.holdTool = async () => { entered(); await held }
  const result = executeToolFixture(b.ctx, { name: 'mcp__managed__identity_get', arguments: {}, callId: ToolCallId('late-disable'), signal: new AbortController().signal })
  await waiting
  const disconnecting = b.call('disconnect')
  await expect.poll(async () => (await b.store.state())!.active).toBe(false)
  release()
  expect((await result).isError).toBe(true)
  expect(await disconnecting).toMatchObject({ ok: true, value: { state: 'disconnected' } })
  for (const token of f.history) expect(JSON.stringify(await result).includes(token)).toBe(false)
})

it('keeps an echoed bearer out of model-facing tool names without changing the raw SDK name', async () => {
  f.echo = true; f.echoName = true
  const b = await boot()
  const schema = b.ctx.tools.schemas().find(tool => tool.name.startsWith('mcp__managed__'))!
  for (const token of f.history) expect(JSON.stringify(schema).includes(token)).toBe(false)
  const received = await executeToolFixture(b.ctx, { name: schema.name, arguments: {}, callId: ToolCallId('safe-name'), signal: new AbortController().signal })
  expect(received.isError).toBe(false)
  for (const token of f.history) expect(JSON.stringify(received).includes(token)).toBe(false)
})

it('keeps a legacy connection visible but blocks SDK/tools and ignores user-submitted recovery claims', async () => {
  const b = await boot()
  await b.machine.update({ disabled: true })
  const { readdir, readFile } = await import('node:fs/promises')
  const entries = await readdir((b.store as unknown as { root: string }).root)
  const file = join((b.store as unknown as { root: string }).root, entries.find(name => name.endsWith('.json'))!)
  const row = JSON.parse(await readFile(file, 'utf8'))
  row.schema = 1; delete row.historyVersion; delete row.history
  await writeFile(file, JSON.stringify(row), { mode: 0o600 })
  const before = f.tokens
  await b.machine.update({ disabled: false })
  const status = await b.call('status')
  expect(status).toMatchObject({ ok: true, value: { state: 'blocked', authentication: 'stopped', historyState: 'migration_required' } })
  expect(f.tokens).toBe(before)
  expect(b.ctx.tools.get('mcp__managed__identity_get')).toBeUndefined()
  expect(await b.call('enable', true, { connectionId: 'managed', validated: true, priorBearersInvalidated: true })).toMatchObject({ ok: false })
  expect((await b.store.state())!.active).toBe(true)
  expect(f.tokens).toBe(before)
})

it('protects actual signed client assertions echoed by the AS/RS after the machine plugin is reconstructed', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  f.echoProof = true
  f.proofSigner = () => {
    const now = Math.floor(Date.now() / 1000)
    const input = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'key' })).toString('base64url') + '.'
      + Buffer.from(JSON.stringify({ iss: 'https://identity.example/client.json', sub: 'https://identity.example/client.json',
        aud: 'https://auth.example', iat: now, exp: now + 60, jti: randomBytes(18).toString('base64url') })).toString('base64url')
    return input + '.' + sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  }
  f.proofVerifier = (assertion) => {
    const parts = assertion.split('.')
    return verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2] ?? '', 'base64url'))
  }
  const b = await boot()
  const execute = () => executeToolFixture(b.ctx, { name: 'mcp__managed__identity_get', arguments: {}, callId: ToolCallId('proof'), signal: new AbortController().signal })
  expect(JSON.stringify(await execute()).includes(f.assertions[0]!)).toBe(false)
  await b.machine.update({ disabled: true }); await b.machine.update({ disabled: false })
  expect(f.assertions.length).toBe(2)
  const afterReload = await execute()
  expect(afterReload.isError).toBe(false)
  expect(JSON.stringify(afterReload).includes(f.assertions[0]!)).toBe(false)
  f.echoError = true
  const failure = await execute()
  expect(failure.isError).toBe(true)
  expect(JSON.stringify(failure).includes(f.assertions[0]!)).toBe(false)
  for (const proof of f.assertions) expect(JSON.stringify(b.ctx.logger.buffer).includes(proof)).toBe(false)
})

it('returns no late SDK business value after another Store disables during the final lease await', async () => {
  const b = await boot()
  const original = MachineConnectionStore.prototype.sentHistory
  let armed = false; let held = false; let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const pause = new Promise<void>((resolve) => { release = resolve })
  const loading = vi.spyOn(MachineConnectionStore.prototype, 'sentHistory').mockImplementation(async function (this: MachineConnectionStore) {
    const records = await original.call(this); if (f.toolReturned) armed = true; return records
  })
  f.leaseHook = async () => { if (armed && !held) { held = true; entered(); await pause } }
  const other = new MachineConnectionStore((b.store as unknown as { root: string }).root, 'managed', async () => Buffer.alloc(32, 29))
  try {
    const execution = executeToolFixture(b.ctx, { name: 'mcp__managed__identity_get', arguments: {}, callId: ToolCallId('durable-output-fence'), signal: new AbortController().signal })
    await waiting; await other.disable(); release()
    const result = await execution
    expect(result.isError).toBe(true)
    expect('value' in result).toBe(false)
    expect(result.content.some(block => block.type === 'text' && block.text === 'machine')).toBe(false)
  } finally { release(); loading.mockRestore(); f.leaseHook = undefined }
})

for (const stage of ['initialize', 'tools/list'] as const) {
  it(`reloads cross-process bearer history before ${stage} SDK error logging`, async () => {
    const original = MachineConnectionStore.prototype.open
    let owner: { root: string; partition: string; generation: number } | undefined
    const opening = vi.spyOn(MachineConnectionStore.prototype, 'open').mockImplementation(async function (this: MachineConnectionStore, partition) {
      const generation = await original.call(this, partition)
      owner = { root: (this as unknown as { root: string }).root, partition, generation }; return generation
    })
    let entered!: () => void; let release!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const pause = new Promise<void>((resolve) => { release = resolve })
    f.failInit = stage === 'initialize'; f.failList = stage === 'tools/list'
    f.holdSdkError = async () => { entered(); await pause }
    const starting = boot(); void starting.catch(() => {})
    try {
      await waiting
      expect(Boolean(owner)).toBe(true)
      const location = owner!
      const other = new MachineConnectionStore(location.root, 'managed', async () => Buffer.alloc(32, 29))
      const secret = randomBytes(32).toString('base64url'); const now = Date.now()
      await other.rememberSent(location.generation, location.partition, { token: secret, issueId: 'another-process-issue', acquiredAt: now,
        expiresAt: now + 300000, partition: location.partition, scopes: ['agent.self.read'] }, async () => {})
      f.foreignError = secret; release()
      let failure: unknown
      try { await starting } catch (error) { failure = error }
      expect(Boolean(failure)).toBe(true)
      const messages: string[] = []; const pending: unknown[] = [failure]
      while (pending.length) {
        const value = pending.pop()
        if (value instanceof Error) {
          messages.push(value.message, value.stack ?? '')
          if (value.cause) pending.push(value.cause)
          if (value instanceof AggregateError) pending.push(...value.errors)
        }
      }
      expect(messages.join('\n').includes(secret)).toBe(false)
      expect(JSON.stringify(contexts.at(-1)!.logger.buffer).includes(secret)).toBe(false)
    } finally { release(); opening.mockRestore() }
  })
}
