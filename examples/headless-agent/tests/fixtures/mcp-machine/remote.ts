/** External AS/resource and identity fixtures; production MCP authentication stays real. @module */
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { EventEmitter } from 'node:events'
import dns from 'node:dns/promises'
import https from 'node:https'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import { mock } from 'node:test'

const identity = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const clientId = 'https://identity.example/client.json'
const issuer = 'https://issuer.example'
const resource = 'https://resource.example/mcp'
const tokens = new Set<string>()
let tokenExchanges = 0
let assertions = 0
let toolCalls = 0
const methods: string[] = []
const targetRef = Object.freeze({})

function assertion(): string {
  assertions++
  const now = Math.floor(Date.now() / 1000)
  const parts = [
    { typ: 'JWT', alg: 'ES256', kid: 'did:web:agent.example#oauth' },
    { iss: clientId, sub: clientId, aud: issuer, iat: now, exp: now + 60, jti: randomUUID() },
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url'))
  const input = parts.join('.')
  return `${input}.${sign('sha256', Buffer.from(input), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

/** Explicit local test identity capability; never a production custody implementation. */
export const identityService = {
  bindProtocolConsumer: () => ({
    registerValidatedTarget: async () => ({
      targetRef, policyGeneration: 1,
      getOAuthClientIdentity: async () => ({ clientId, algorithm: 'ES256' as const, version: 1, keyId: 'did:web:agent.example#oauth', signerMode: 'local' as const }),
      assertActive: async () => {},
      signOAuthClientAssertion: async (target: object) => {
        if (target !== targetRef) throw new Error('unexpected_machine_target')
        return assertion()
      },
      dispose() {},
    }),
  }),
}

/** Fixed keyless credential provider; the encrypted store still executes its real writes. */
export const credentials = { resolve: async () => ({ value: Buffer.alloc(32, 51).toString('base64url') }) }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): IncomingMessage {
  // Only the remote Node HTTP response is synthetic; production body limits,
  // strict JSON, authentication, MCP transport and SDK parsing remain active.
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    statusCode: status, headers: { 'content-type': 'application/json', ...headers },
  }) as IncomingMessage
}

function reply(url: URL, options: RequestOptions, bytes?: Uint8Array): IncomingMessage {
  const headers = new Headers(options.headers as Record<string, string>)
  if (url.href.includes('/.well-known/')) {
    if (headers.has('authorization')) throw new Error('credential_on_discovery')
    if (url.href === 'https://resource.example/.well-known/oauth-protected-resource/mcp') return json({ resource, authorization_servers: [issuer] })
    if (url.href === `${issuer}/.well-known/oauth-authorization-server`) return json({ issuer, token_endpoint: `${issuer}/token`, client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
    throw new Error('unexpected_discovery')
  }
  if (url.href === `${issuer}/token`) {
    const form = new URLSearchParams(Buffer.from(bytes ?? []).toString())
    const compact = form.get('client_assertion') ?? ''
    const [header, payload, signature] = compact.split('.')
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<string, unknown>
    if (!header || !payload || !signature || !verify('sha256', Buffer.from(`${header}.${payload}`), { key: identity.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
      || claims.iss !== clientId || claims.sub !== clientId || claims.aud !== issuer
      || form.get('grant_type') !== 'client_credentials' || form.get('resource') !== resource
      || form.get('scope') !== 'agent.self.read' || form.has('refresh_token') || form.has('code')) throw new Error('unexpected_machine_grant')
    tokenExchanges++
    const token = `private-machine-fixture-token-${tokenExchanges}`
    tokens.add(token)
    return json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'agent.self.read' })
  }
  if (url.href !== resource || !tokens.has((headers.get('authorization') ?? '').replace(/^Bearer /u, ''))
    || headers.has('poppy-session') || headers.has('dpop')) throw new Error('unexpected_resource_credentials')
  if (options.method === 'GET') return json({}, 405)
  const body = JSON.parse(Buffer.from(bytes ?? []).toString()) as { id?: number; method: string }
  methods.push(body.method)
  switch (body.method) {
    case 'initialize': return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'machine-keyless-fixture', version: '1' } } })
    case 'notifications/initialized': return json({}, 202)
    case 'tools/list': return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'identity_get', description: 'Read the current machine identity.', inputSchema: { type: 'object', properties: {} } }] } })
    case 'tools/call': {
      toolCalls++
      if (toolCalls === 2) return json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer error="invalid_token"' })
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'did:web:agent.example' }] } })
    }
    default: throw new Error('unexpected_mcp_method')
  }
}

/** Install the external network fixture before the application imports production modules.
 * @returns A disposer restoring Node's original network functions.
 */
export function installMachineWireFixture(): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('machine_fixture_requires_test_mode')
  // The real transport requests all DNS answers and pins its connection to one.
  mock.method(dns, 'lookup', (async (host: string) => {
    if (!['resource.example', 'issuer.example'].includes(host)) throw new Error('unexpected_fixture_host')
    return [{ address: '1.1.1.1', family: 4 }]
  }) as unknown as typeof dns.lookup)
  mock.method(https, 'request', ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as ClientRequest
    request.end = ((bytes?: Uint8Array) => {
      queueMicrotask(() => {
        try { callback(reply(url, options, bytes)) }
        catch { request.emit('error', new Error('machine_fixture_rejected_request')) }
      })
      return request
    }) as ClientRequest['end']
    return request
  }) as typeof https.request)
  syncBuiltinESMExports()
  return () => { mock.restoreAll(); syncBuiltinESMExports() }
}

/** Safe wire facts, excluding access tokens and signed assertions.
 * @returns The observed machine grant and actual SDK method counts.
 */
export function machineWireSummary(): object {
  return { type: 'machine_wire_summary', tokenExchanges, assertions, toolCalls, methods,
    custody: 'explicit-test-fixture', authorizationServer: 'external-wire-fixture' }
}
