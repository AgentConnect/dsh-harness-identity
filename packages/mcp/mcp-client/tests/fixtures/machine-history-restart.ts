import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
/** Actual fresh Node Host/SDK/store worker with a private external AS/RS fixture. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { MachineAuthenticationSession } from '../../src/machine-auth.ts'
import { syncTools } from '../../src/tools.ts'
import { Client } from '@modelcontextprotocol/client'
import type { Transport } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
const phase = Number(process.argv[2]); const root = process.argv[3]!
const config = JSON.parse(await readFile(join(root, 'host-credential.json'), 'utf8')) as { key: string }
const state = JSON.parse(await readFile(join(root, 'external-fixture.json'), 'utf8')) as { issued: Array<{ value: string; expiresAt: number }>; observed: string[] }
const save = () => writeFile(join(root, 'external-fixture.json'), JSON.stringify(state), { mode: 0o600 })
const ctx = new Context(); const targetRef = Object.freeze({})
ctx.provide('credentials', { resolve: async () => ({ value: config.key }) } as never)
ctx.provide('anpIdentity', { bindProtocolConsumer: () => ({ registerValidatedTarget: async () => ({ targetRef, policyGeneration: 1,
  assertActive: async () => {}, getOAuthClientIdentity: async () => ({ clientId: 'https://identity.example/client.json', keyId: 'kid', version: 1, algorithm: 'ES256', signerMode: 'local' }),
  signOAuthClientAssertion: async () => 'fixture-client-assertion', dispose() {},
}) }) } as never)
const resource = 'https://resource.example/mcp'; const issuer = 'https://issuer.example'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
let force401 = false
const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  if (request.url.includes('oauth-protected-resource')) return json({ resource, authorization_servers: [issuer] })
  if (request.url.includes('oauth-authorization-server')) return json({ issuer, token_endpoint: issuer + '/token', client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
  if (request.url === issuer + '/token') {
    assert.equal(new URLSearchParams(await request.text()).get('grant_type'), 'client_credentials')
    const value = randomBytes(32).toString('base64url'); state.issued.push({ value, expiresAt: Date.now() + 300000 }); await save()
    return json({ access_token: value, token_type: 'Bearer', expires_in: 300, scope: 'agent.self.read' })
  }
  assert.equal(request.url, resource)
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /u, '')
  assert.ok(state.issued.some(token => token.value === bearer && token.expiresAt > Date.now()))
  if (bearer && !state.observed.includes(bearer)) { state.observed.push(bearer); await save() }
  if (force401) { force401 = false; return new Response(null, { status: 401 }) }
  if (request.method === 'GET' || request.method === 'DELETE') return new Response(null, { status: 405 })
  const body = await request.json() as { id?: number; method: string }
  if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'restart-resource', version: '1' } } })
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
  if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', description: 'Read controlled data.', inputSchema: { type: 'object' } }] } })
  return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `ordinary ${state.observed[0]}` }], structuredContent: { arbitrary: state.observed[0], [state.observed[0]!]: true } } })
}
const session = new MachineAuthenticationSession(ctx, { mode: 'cimd-client-credentials', connectionId: 'restarted', identityRef: { storeId: 'store', identityId: 'id', did: 'did:web:identity.example' }, policyRef: 'policy', requestedScopes: ['agent.self.read'], stateRoot: join(root, 'machine-state'), encryptionKeyRef: 'MCP_KEY' }, resource, send)
const client = new Client({ name: 'restart-probe', version: '1' }, { capabilities: {} })
let disposers = new Map<string, () => void>()
try {
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
  // The SDK transport optional sessionId is wider under exactOptionalPropertyTypes, as in the production factory.
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), { fetch: session.fetch }) as Transport)
  disposers = await syncTools(client, ctx, { serverName: 'restart', toolCallTimeoutMs: 10000, signal: new AbortController().signal, protection: session.outputProtection() }, disposers)
  const execute = () => executeToolFixture(ctx, { name: 'mcp__restart__echo', arguments: {}, callId: ToolCallId('restart'), signal: new AbortController().signal })
  let result = await execute()
  if (phase === 1) { force401 = true; assert.equal((await execute()).isError, true); result = await execute() }
  const oldest = state.observed[0]!
  const record = { phase, pid: process.pid,
    oldStillValid: state.issued.some(token => token.value === oldest && token.expiresAt > Date.now()),
    oldInModelText: JSON.stringify(result.content).includes(oldest),
    oldInCanonicalStructuredValue: JSON.stringify((result as { value?: unknown }).value).includes(oldest),
    issued: state.issued.length, freshContext: true }
  process.stdout.write(JSON.stringify(record) + '\n')
} finally {
  for (const dispose of disposers.values()) dispose()
  await client.close(); await session.dispose(); await ctx.fiber.dispose()
}
