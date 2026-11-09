import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
/** Actual Loader, SDK initialize/tools and registry. Only remote HTTPS and identity/credential providers are fixtures. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MachineConnectionStore } from '../src/machine-store.ts'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '../src/index.ts'
import * as DomainConnector from '../src/domain.ts'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'

const { requests, tokens } = vi.hoisted(() => ({ requests: [] as Array<{ url: string; method?: string }>, tokens: [] as string[] }))
vi.mock('../src/machine-http.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/machine-http.ts')>()
  return { ...original, machineFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, method: request.method })
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (request.url.includes('oauth-protected-resource')) return json({ resource: 'https://resource.example/mcp', authorization_servers: ['https://issuer.example'], scopes_supported: ['agent.self.read', 'message.write'] })
    if (request.url.includes('oauth-authorization-server')) return json({ issuer: 'https://issuer.example', token_endpoint: 'https://issuer.example/token', client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
    if (request.url === 'https://issuer.example/token') {
      const form = new URLSearchParams(await request.text())
      if (form.get('grant_type') !== 'client_credentials') throw new Error('unexpected_grant')
      const token = 'private-fixture-token-' + (tokens.length + 1)
      tokens.push(token)
      return json({ access_token: token, token_type: 'Bearer', expires_in: 60, scope: 'agent.self.read' })
    }
    if (request.url !== 'https://resource.example/mcp' || !tokens.some(token => request.headers.get('authorization') === 'Bearer ' + token)) throw new Error('unexpected_authenticated_request')
    if (request.method === 'GET') return new Response(null, { status: 405 })
    const body = await request.json() as { id?: number; method?: string }
    switch (body.method) {
      case 'server/discover': return json({ jsonrpc:'2.0',id:body.id,error:{ code:-32601,message:'Method not found' } })
      case 'initialize': return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })
      case 'notifications/initialized': return new Response(null, { status: 202 })
      case 'tools/list': return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'identity_get', annotations:{ readOnlyHint:true,destructiveHint:false }, description: 'Read the current machine identity.', inputSchema: { type: 'object', properties: {} } }] } })
      case 'tools/call': return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'did:web:agent.example' }] } })
      default: throw new Error('unexpected_mcp_method')
    }
  } }
})
let context: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await context?.fiber.dispose(); context = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined; requests.splice(0); tokens.splice(0)
})

it('loads explicit machine mode, discovers through the actual SDK, renders a safe result and removes tools on disposal', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-machine-loader-'))
  const config = join(directory, 'cordis.yml')
  await writeFile(config, `- name: '@deepseek-ai/dsh-system-prompt'\n- name: '@deepseek-ai/dsh-tools'\n- name: '@fixture/machine-host'\n- name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: machine\n    transport: streamable-http\n    url: https://resource.example/mcp\n    failOnStartupError: true\n    reconnect:\n      enabled: false\n    authentication:\n      mode: cimd-client-credentials\n      connectionId: stable-machine\n      identityRef: { storeId: store, identityId: identity, did: 'did:web:agent.example' }\n      policyRef: approved-policy\n      requestedScopes: [agent.self.read]\n      stateRoot: ${JSON.stringify(join(directory, 'secrets'))}\n      encryptionKeyRef: MCP_STORE_KEY\n`)
  const targetRef = Object.freeze({})
  const host = { name: 'machine-host-fixture', apply(ctx: Context) {
    ctx.provide('credentials', { resolve: async () => ({ value: Buffer.alloc(32, 51).toString('base64url') }) })
    ctx.provide('anpIdentity', { bindProtocolConsumer: () => ({ registerValidatedTarget: async () => ({ targetRef, policyGeneration: 1,
      assertActive: async () => {}, getOAuthClientIdentity: async () => ({ clientId: 'https://identity.example/client.json', algorithm: 'ES256', version: 1, keyId: 'did:web:agent.example#oauth', signerMode: 'local' }), signOAuthClientAssertion: async () => 'fixture-assertion', dispose() {} }) }) })
  } }
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools], ['@fixture/machine-host', host], ['@deepseek-ai/dsh-mcp-client', McpClient]])
  ctx.loader.internal = { version: 'v2', import: async (name: string) => { if (!modules.has(name)) throw new Error('unexpected_module'); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
  expect(ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__machine__identity_get')
  const result = await executeToolFixture(ctx, { name: 'mcp__machine__identity_get', arguments: {}, callId: ToolCallId('machine-call'), signal: new AbortController().signal })
  expect(JSON.stringify(result)).toContain('did:web:agent.example')
  expect(JSON.stringify(result)).not.toContain('private-fixture-token')
  expect(requests.slice(0, 3).map(request => request.url)).toEqual(['https://resource.example/.well-known/oauth-protected-resource/mcp', 'https://issuer.example/.well-known/oauth-authorization-server', 'https://issuer.example/token'])
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')?.fiber
  await fiber?.dispose()
  expect(ctx.tools.get('mcp__machine__identity_get')).toBeUndefined()
})


it('keeps real Loader scopes independent while enforcing Host-wide machine connection ids', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-machine-scopes-'))
  const stateRoot = join(directory, 'secrets')
  const files = ['scope-one', 'scope-two', 'scope-duplicate'].map(name => join(directory!, name + '.yml'))
  for (const [index, file] of files.entries()) await writeFile(file, `- name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: shared\n    transport: streamable-http\n    url: https://resource.example/mcp\n    failOnStartupError: true\n    reconnect: { enabled: false }\n    authentication:\n      mode: cimd-client-credentials\n      connectionId: ${index === 1 ? 'loader-scope-two' : 'loader-scope-one'}\n      identityRef: { storeId: store, identityId: identity, did: 'did:web:agent.example' }\n      policyRef: approved-policy\n      requestedScopes: [agent.self.read]\n      stateRoot: ${JSON.stringify(stateRoot)}\n      encryptionKeyRef: MCP_STORE_KEY\n`)
  const ctx = context = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Loader)
  const ref = Object.freeze({})
  ctx.provide('credentials', { resolve: async () => ({ value: Buffer.alloc(32, 51).toString('base64url') }) })
  ctx.provide('anpIdentity', { bindProtocolConsumer: () => ({ registerValidatedTarget: async () => ({ targetRef: ref, policyGeneration: 1,
    assertActive: async () => {}, getOAuthClientIdentity: async () => ({ clientId: 'https://identity.example/client.json', algorithm: 'ES256', version: 1, keyId: 'key', signerMode: 'local' }),
    signOAuthClientAssertion: async () => 'fixture-assertion', dispose() {} }) }) })
  ctx.loader.internal = { version: 'v2', import: async () => McpClient } as unknown as NonNullable<typeof ctx.loader.internal>
  const trees: Include[] = []
  class CapturedInclude extends Include {
    constructor(scope: Context, config: Include.Config) { super(scope, config); trees.push(this) }
  }
  const first = await agents.create(SessionId('machine-owner-one'))
  const second = await agents.create(SessionId('machine-owner-two'))
  const duplicate = await agents.create(SessionId('machine-owner-duplicate'))
  try {
    await first.ctx.plugin(CapturedInclude, { path: pathToFileURL(files[0]!).href }); await trees[0]!.await()
    await second.ctx.plugin(CapturedInclude, { path: pathToFileURL(files[1]!).href }); await trees[1]!.await()
    expect(ctx.tools.get('mcp__shared__identity_get', first)).toBeDefined()
    expect(ctx.tools.get('mcp__shared__identity_get', second)).toBeDefined()
    expect(tokens).toHaveLength(2)
    const before = requests.length
    await duplicate.ctx.plugin(CapturedInclude, { path: pathToFileURL(files[2]!).href })
    await trees[2]!.await()
    // Loader.await contains plugin failures; admission is observed on the owning Fiber.
    expect([...trees[2]!.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')?.fiber?.state).toBe(FiberState.FAILED)
    expect(ctx.tools.get('mcp__shared__identity_get', duplicate)).toBeUndefined()
    expect(requests).toHaveLength(before)
    const firstStore = new MachineConnectionStore(stateRoot, 'loader-scope-one', async () => Buffer.alloc(32, 51))
    await firstStore.disable()
    const denied = await executeToolFixture(ctx, { agent: first, name: 'mcp__shared__identity_get', arguments: {}, callId: ToolCallId('disabled'), signal: new AbortController().signal })
    expect(denied.isError).toBe(true)
    const result = await executeToolFixture(ctx, { agent: second, name: 'mcp__shared__identity_get', arguments: {}, callId: ToolCallId('isolated'), signal: new AbortController().signal })
    expect(JSON.stringify(result)).toContain('did:web:agent.example')
    expect(tokens).toHaveLength(2)
  } finally { await ctx.fiber.dispose() }
})


it('connects from only a domain through real Loader and SDK, reuses connections, preserves fences and unloads tools', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-domain-loader-'))
  const stateRoot = join(directory, 'domain-state')
  const file = join(directory, 'cordis.yml')
  await writeFile(file, '- name: \'@fixture/domain-host\'\n- name: \'@deepseek-ai/dsh-mcp-client/domain\'\n  config: { enabled: true }\n')
  const records = new Map<CredentialKey, CredentialRecord>()
  let domainEnabled = true, consentRequests = 0
  const host = { name: 'domain-host-fixture', apply(ctx: Context) {
    ctx.provide('credentials', { async modifyRecord(key: CredentialKey, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(records.get(key)); if (next) records.set(key, next); return records.get(key)
    } })
    ctx.provide('anpIdentity', {
      bindDomainOperationConsumer() {return { request:async()=>{consentRequests++;return { id:'denied-extra',status:'denied',version:1 }},status:async()=>{throw new Error('No pending consent')},cancel:async()=>{throw new Error('No pending consent')},execute:async()=>{throw new Error('Read must not execute a consent')} }},
      async resolveDomainAccess() {
        if (!domainEnabled) throw Object.assign(new Error('Disabled'), { code:'domain_access_disabled' })
        return { identityRef: { storeId:'store', identityId:'identity', did:'did:web:agent.example' }, policyRef:'domain-policy', scopes:['agent.self.read'], stateRoot }
      },
      bindProtocolConsumer() { return { registerValidatedTarget: async (input: { requestedScopes:string[] }) => {
        expect(input.requestedScopes).toEqual(['agent.self.read'])
        const targetRef = Object.freeze({})
        return { targetRef,policyGeneration:1,assertActive:async()=>{},getOAuthClientIdentity:async()=>({ clientId:'https://identity.example/client.json',algorithm:'ES256',version:1,keyId:'key',signerMode:'local' }),signOAuthClientAssertion:async()=> 'domain-fixture-assertion',dispose(){} }
      } } },
    })
  } }
  const ctx = context = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  const agent = await agents.create(SessionId('domain-agent'))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@fixture/domain-host',host],['@deepseek-ai/dsh-mcp-client/domain',DomainConnector]])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Node module loader is unavailable')
  ctx.loader.internal = { ...internal,import:async(name:string)=>modules.get(name) }
  await ctx.loader.create({ name:'cordis:include',config:{ path:pathToFileURL(file).href } }); await ctx.loader.await()
  let serial=0
  const connect = (domain='website.example', scopes?:string[]) => executeToolFixture(ctx,{ agent,name:'mcp_connect',arguments:{ domain,...(scopes?{ scopes }:{}) },callId:ToolCallId(`domain-${serial++}`),signal:new AbortController().signal })
  const connected = await connect()
  expect(connected.value).toMatchObject({ ok:true,state:'ready',resource:'https://resource.example/mcp' })
  const result = connected.value as { serverName:string;connectionId:string }
  const business = `mcp__${result.serverName}__identity_get`
  expect(ctx.tools.get(business)).toBeDefined()
  expect((await executeToolFixture(ctx,{ agent,name:business,arguments:{},callId:ToolCallId('domain-read'),signal:new AbortController().signal })).content).toEqual([{ type:'text',text:'did:web:agent.example' }])
  await Promise.all([connect(),connect('alias.example')])
  expect(tokens).toHaveLength(1)
  expect(records.size).toBe(1)
  expect((await connect('website.example',['message.write'])).value).toMatchObject({ ok:false,error:'identity_authorization_denied' })
  expect(consentRequests).toBe(1)
  expect(tokens).toHaveLength(1)
  domainEnabled=false
  expect((await connect()).value).toEqual({ ok:false,error:'domain_access_disabled' })
  domainEnabled=true
  const key = [...records.values()][0]!
  if(key.kind!=='api-key' || !key.key) throw new Error('Missing isolated test key')
  const store = new MachineConnectionStore(stateRoot,result.connectionId,async()=>Buffer.from(key.key!,'base64url'))
  await store.disable()
  expect((await connect()).value).toMatchObject({ ok:false,state:'disconnected',error:'connection_disabled' })
  expect(JSON.stringify(connected)).not.toContain('private-fixture-token')
  expect(JSON.stringify(connected)).not.toContain('domain-fixture-assertion')
  const entry=[...ctx.loader.entries()].find(entry=>entry.options.name==='@deepseek-ai/dsh-mcp-client/domain')!
  await entry.fiber!.dispose()
  expect(ctx.tools.get('mcp_connect')).toBeUndefined()
  expect(ctx.tools.get(business)).toBeUndefined()
})
