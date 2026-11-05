/** Local identity and external wire fixtures; the shipped profile, MCP plugin and SDK stay real. */
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { EventEmitter } from 'node:events'
import dns from 'node:dns/promises'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import { mock } from 'node:test'

const CLIENT = 'https://identity.example/client.json'
const ISSUER = 'https://issuer.example'
const RESOURCE = 'https://resource.example/mcp'
const CIPHER_REF = 'SNAPSHOT_MCP_CIPHER'

export const name = 'mcp-machine-fixture'
export const inject = ['credentials']

/**
 * Provide explicit local fixture capabilities and intercept external Node DNS/HTTPS only.
 * @param {import('@deepseek-ai/cordis').Context} ctx - shipped profile context.
 */
export async function apply(ctx) {
  const identity = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const targetRef = Object.freeze({})
  const tokens = new Set()
  let tokenExchanges = 0
  let assertions = 0
  let toolCalls = 0
  // Keep the real credential provider, its protected file and authorization behavior.
  await ctx.credentials.set(CIPHER_REF, Buffer.alloc(32, 51).toString('base64url'))
  const identityService = {
    bindProtocolConsumer: () => ({
      registerValidatedTarget: async () => ({
        targetRef, policyGeneration: 1,
        getOAuthClientIdentity: async () => ({ clientId: CLIENT, algorithm: 'ES256', version: 1, keyId: 'did:web:agent.example#oauth', signerMode: 'local' }),
        assertActive: async () => {},
        signOAuthClientAssertion: async (target) => {
          if (target !== targetRef) throw new Error('unexpected_machine_target')
          assertions++
          const now = Math.floor(Date.now() / 1000)
          const body = [
            { typ: 'JWT', alg: 'ES256', kid: 'did:web:agent.example#oauth' },
            { iss: CLIENT, sub: CLIENT, aud: ISSUER, iat: now, exp: now + 60, jti: randomUUID() },
          ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
          return `${body}.${sign('sha256', Buffer.from(body), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
        },
        dispose() {},
      }),
    }),
  }

  const json = (value, status = 200, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
    statusCode: status, headers: { 'content-type': 'application/json', ...headers },
  })
  const reply = (url, options, bytes) => {
    const headers = new Headers(options.headers)
    if (url.href.includes('/.well-known/')) {
      if (headers.has('authorization')) throw new Error('credential_on_discovery')
      if (url.href === 'https://resource.example/.well-known/oauth-protected-resource/mcp') return json({ resource: RESOURCE, authorization_servers: [ISSUER] })
      if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) return json({ issuer: ISSUER, token_endpoint: `${ISSUER}/token`, client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
      throw new Error('unexpected_discovery')
    }
    if (url.href === `${ISSUER}/token`) {
      const form = new URLSearchParams(Buffer.from(bytes ?? []).toString())
      const compact = form.get('client_assertion') ?? ''
      const [header, payload, signature] = compact.split('.')
      const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())
      if (!header || !payload || !signature || !verify('sha256', Buffer.from(`${header}.${payload}`), { key: identity.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
        || claims.iss !== CLIENT || claims.sub !== CLIENT || claims.aud !== ISSUER
        || form.get('client_id') !== CLIENT || form.get('grant_type') !== 'client_credentials' || form.get('resource') !== RESOURCE
        || form.get('scope') !== 'agent.self.read' || form.has('refresh_token') || form.has('code')) throw new Error('unexpected_machine_grant')
      tokenExchanges++
      const token = `private-machine-fixture-token-${tokenExchanges}`
      tokens.add(token)
      return json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'agent.self.read' })
    }
    const raw = (headers.get('authorization') ?? '').replace(/^Bearer /u, '')
    if (url.href !== RESOURCE || !tokens.has(raw) || headers.has('poppy-session') || headers.has('dpop')) throw new Error('unexpected_resource_credentials')
    if (options.method === 'GET') return json({}, 405)
    const body = JSON.parse(Buffer.from(bytes ?? []).toString())
    switch (body.method) {
      case 'initialize': return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'machine-fixture', version: '1' } } })
      case 'notifications/initialized': return json({}, 202)
      case 'tools/list': return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'identity_get', description: 'Read the current machine identity.', inputSchema: { type: 'object', properties: {} } }] } })
      case 'tools/call': {
        toolCalls++
        if (toolCalls === 2) return json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer error="invalid_token"' })
        if (toolCalls === 3 && (tokenExchanges !== 2 || assertions !== 2 || raw !== 'private-machine-fixture-token-2')) throw new Error('machine_reacquisition_not_observed')
        if (toolCalls > 3) throw new Error('unexpected_business_replay')
        return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'did:web:agent.example' }] } })
      }
      default: throw new Error('unexpected_mcp_method')
    }
  }

  await ctx.effect(() => {
    mock.method(dns, 'lookup', async (host) => {
      if (!['resource.example', 'issuer.example'].includes(host)) throw new Error('unexpected_fixture_host')
      return [{ address: '1.1.1.1', family: 4 }]
    })
    mock.method(https, 'request', (url, options, callback) => {
      const request = new EventEmitter()
      request.end = (bytes) => {
        queueMicrotask(() => {
          try { callback(reply(url, options, bytes)) }
          catch { request.emit('error', new Error('machine_fixture_rejected_request')) }
        })
        return request
      }
      return request
    })
    syncBuiltinESMExports()
    return () => {
      mock.restoreAll()
      syncBuiltinESMExports()
      if (toolCalls > 0 && (toolCalls !== 3 || tokenExchanges !== 2)) throw new Error('incomplete_machine_wire_scenario')
    }
  }, 'mcp-machine.external-wire-fixture')
  ctx.provide('anpIdentity', identityService)
}
