/** Run the built candidate in a separate Cordis Host and preserve the old state directory. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { registerHooks } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, stateRoot, state] = process.argv.slice(2)
const app = path => pathToFileURL(resolve(root, path)).href
const endpoint = 'https://resource.example/mcp'
const issuer = 'https://auth.example'
const entry = 'packages/mcp/mcp-client/lib/types/'
const target = app(entry + 'machine-http.js')
const hook = registerHooks({
  load(url, context, next) {
    if (url !== target) return next(url, context)
    return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(target + '?original')};
      export const machineFetch = globalThis.cimdRollbackFixture;
    ` }
  },
})
let requests = 0
let tokens = 0
globalThis.cimdRollbackFixture = async (input, init, beforeSend) => {
  await beforeSend?.()
  requests++
  const request = new Request(input, init)
  if (request.url === 'https://resource.example/prm') return Response.json({ resource: endpoint, authorization_servers: [issuer] })
  if (request.url === `${issuer}/.well-known/oauth-authorization-server`) return Response.json({
    issuer, token_endpoint: `${issuer}/token`, client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'],
  })
  if (request.url === `${issuer}/token`) {
    tokens++
    return Response.json({ access_token: 'candidate-fixture-token', token_type: 'Bearer', expires_in: 300 })
  }
  assert.equal(request.url, endpoint)
  if (!request.headers.has('authorization')) return new Response(null, { status: 401,
    headers: { 'www-authenticate': 'Bearer resource_metadata="https://resource.example/prm"' } })
  if (request.method === 'GET') return new Response(null, { status: 405 })
  const rpc = await request.json()
  const reply = value => Response.json({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...value } })
  switch (rpc.method) {
    case 'server/discover': return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } })
    case 'tools/list': return reply({ tools: [{ name: 'identity_get', inputSchema: { type: 'object' } }] })
    case 'tools/call': return reply({ content: [{ type: 'text', text: 'migrated profile' }] })
    default: throw new Error(`Unexpected fixture method ${rpc.method}`)
  }
}

const { Context } = await import(app('vendor/cordis/lib/index.js'))
const { default: Loader } = await import(app('vendor/loader/lib/index.js'))
const { default: Include } = await import(app('vendor/include/lib/index.js'))
const { default: Tools } = await import(app('packages/core/tools/lib/index.js'))
const { default: SystemPrompt } = await import(app('packages/core/system-prompt/lib/index.js'))
const Executor = await import(app('packages/core/tool-executor-native/lib/index.js'))
const { executeToolFixture } = await import(app('packages/test-support/tool-testkit/lib/index.js'))
const McpClient = await import(app(entry + 'index.js'))
const context = new Context()
const temp = await mkdtemp(join(tmpdir(), 'cimd-migrated-host-'))
try {
  await context.plugin(SystemPrompt)
  await context.plugin(Tools)
  await context.plugin(Executor)
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  context.provide('credentials', { async resolve(ref) { return { value: ref === 'SIGNING' ? key : Buffer.alloc(32, 29).toString('base64url') } } })
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = { version: 'v2', import: async () => McpClient }
  const config = { serverName: 'managed', url: endpoint, transport: 'streamable-http', failOnStartupError: true, reconnect: { enabled: false },
    authentication: { mode: 'cimd-client-credentials', connectionId: 'managed', provider: 'credentials', credentialRef: 'SIGNING',
      credential: { clientId: 'https://identity.example/client.json', keyId: 'fixture', issuer, resource: endpoint },
      requestedScopes: ['agent.self.read'], stateRoot, encryptionKeyRef: 'MCP_KEY' } }
  const file = join(temp, 'cordis.yml')
  await writeFile(file, `- name: '@deepseek-ai/dsh-mcp-client'\n  config: ${JSON.stringify(config)}\n`)
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await context.loader.await()
  const fiber = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client').fiber
  if (state === 'ready') {
    await fiber.await()
    const output = await executeToolFixture(context, { name: 'mcp__managed__identity_get', arguments: {}, callId: 'rollback-fixture', signal: new AbortController().signal })
    assert.equal(output.isError, false)
    assert.match(JSON.stringify(output), /migrated profile/u)
    assert.equal(tokens, 1)
  } else {
    await assert.rejects(fiber.await(), error => error.cause?.code === 'MCP_MACHINE_STATE_UNAVAILABLE')
    assert.equal(requests, 0)
  }
  process.stdout.write('candidate-host-verified\n')
} finally {
  await context.fiber.dispose()
  hook.deregister()
  delete globalThis.cimdRollbackFixture
  await rm(temp, { recursive: true, force: true })
}
