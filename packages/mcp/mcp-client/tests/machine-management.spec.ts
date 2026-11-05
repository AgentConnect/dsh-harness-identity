/** Real Loader, authenticated user carrier, Typert and SDK lifecycle; remote identity/AS are fixtures. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
const f = vi.hoisted(() => ({ tokens: 0, requests: 0, revocations: 0, leases: 0, permitted: true,
  holdIdentity: undefined as (() => Promise<void>) | undefined, holdToken: undefined as (() => Promise<void>) | undefined }))
vi.mock('../src/machine-http.ts', async (original) => {
  const value = await original<typeof import('../src/machine-http.ts')>()
  return { ...value, machineFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
    if (req.url.includes('oauth-protected-resource')) return json({ resource: 'https://resource.example/mcp', authorization_servers: ['https://auth.example'] })
    if (req.url.includes('oauth-authorization-server')) return json({ issuer: 'https://auth.example', token_endpoint: 'https://auth.example/token', revocation_endpoint: 'https://auth.example/revoke', client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
    if (req.url === 'https://auth.example/token') {
      expect(new URLSearchParams(await req.text()).get('grant_type')).toBe('client_credentials')
      const token = `private-token-${++f.tokens}`; await f.holdToken?.()
      return json({ access_token: token, token_type: 'Bearer', expires_in: 300, scope: 'agent.self.read' })
    }
    if (req.url === 'https://auth.example/revoke') { f.revocations++; return new Response(null, { status: 200 }) }
    if (req.url !== 'https://resource.example/mcp') throw new Error('unexpected_fixture_origin')
    f.requests++
    if (req.method === 'GET' || req.method === 'DELETE') return new Response(null, { status: 405 })
    const body = await req.json() as { id?: number; method: string }
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'identity_get', description: 'Read machine identity.', inputSchema: { type: 'object' } }] } })
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
  Object.assign(f, { tokens: 0, requests: 0, revocations: 0, leases: 0, permitted: true, holdIdentity: undefined, holdToken: undefined })
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
      return { targetRef, policyGeneration: f.leases, assertActive: async () => { if (!f.permitted) throw new Error('fixture_permission_denied') },
        getOAuthClientIdentity: async () => { await f.holdIdentity?.(); return { clientId: 'https://identity.example/client.json', algorithm: 'ES256', signerMode: 'local', keyId: 'key', version: 1 } },
        signOAuthClientAssertion: async () => 'fixture-assertion', dispose() {} }
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

it.skipIf(process.platform !== 'linux')('uses protected user Remote to stop SDK/tools, retains disabled across Loader restart, and explicitly reauthorizes enablement', async () => {
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

it.skipIf(process.platform !== 'linux')('refuses an unapproved manager even when loaded by the real Loader', async () => {
  await expect(boot(false)).rejects.toThrow('manager_forbidden')
})

it.skipIf(process.platform !== 'linux')('rechecks the manager after a signer await and preserves the disabled fence', async () => {
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

it.skipIf(process.platform !== 'linux')('CAS enablement cannot overwrite a newer disabled fence or admit an old writer', async () => {
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

it.skipIf(process.platform !== 'linux')('rolls back its own activation when management is revoked while the Token response is pending', async () => {
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

it.skipIf(process.platform !== 'linux')('disconnects during an enable flight without reviving its token or tools', async () => {
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

it.skipIf(process.platform !== 'linux')('does not let failed enable rollback disable another process activation with the same generation', async () => {
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

it.skipIf(process.platform !== 'linux')('reports blocked and unconfirmed when durable disconnect fails while still closing SDK and tools', async () => {
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
