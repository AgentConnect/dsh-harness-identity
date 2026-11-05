/** Actual Loader, SDK initialize/tools and registry. Only remote HTTPS and identity/credential providers are fixtures. */
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
import { CallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '../src/index.ts'

const { requests } = vi.hoisted(() => ({ requests: [] as Array<{ url: string; method?: string }> }))
vi.mock('../src/machine-http.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/machine-http.ts')>()
  return { ...original, machineFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, method: request.method })
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (request.url.includes('oauth-protected-resource')) return json({ resource: 'https://resource.example/mcp', authorization_servers: ['https://issuer.example'] })
    if (request.url.includes('oauth-authorization-server')) return json({ issuer: 'https://issuer.example', token_endpoint: 'https://issuer.example/token', client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
    if (request.url === 'https://issuer.example/token') {
      const form = new URLSearchParams(await request.text())
      if (form.get('grant_type') !== 'client_credentials') throw new Error('unexpected_grant')
      return json({ access_token: 'private-fixture-token', token_type: 'Bearer', expires_in: 60, scope: 'agent.self.read' })
    }
    if (request.url !== 'https://resource.example/mcp' || request.headers.get('authorization') !== 'Bearer private-fixture-token') throw new Error('unexpected_authenticated_request')
    if (request.method === 'GET') return new Response(null, { status: 405 })
    const body = await request.json() as { id?: number; method?: string }
    switch (body.method) {
      case 'initialize': return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })
      case 'notifications/initialized': return new Response(null, { status: 202 })
      case 'tools/list': return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'identity_get', description: 'Read the current machine identity.', inputSchema: { type: 'object', properties: {} } }] } })
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
  directory = undefined; requests.splice(0)
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
  const result = await ctx.tools.execute({ name: 'mcp__machine__identity_get', arguments: {}, callId: CallId('machine-call'), signal: new AbortController().signal })
  expect(JSON.stringify(result)).toContain('did:web:agent.example')
  expect(JSON.stringify(result)).not.toContain('private-fixture-token')
  expect(requests.slice(0, 3).map(request => request.url)).toEqual(['https://resource.example/.well-known/oauth-protected-resource/mcp', 'https://issuer.example/.well-known/oauth-authorization-server', 'https://issuer.example/token'])
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')?.fiber
  await fiber?.dispose()
  expect(ctx.tools.get('mcp__machine__identity_get')).toBeUndefined()
})
