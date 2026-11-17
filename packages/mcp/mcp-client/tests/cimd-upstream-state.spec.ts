/** Compatibility between persisted AgentConnect state and the built upstream client. */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { MachineConnectionStore, type MachineToken } from '../src/machine-store.ts'

const upstream = process.env.DSH_CIMD_UPSTREAM_SOURCE

it.skipIf(!upstream)('opens active state, preserves closed old states, and rolls back through the old reader', async () => {
  const built = (file: string) => pathToFileURL(join(upstream!, 'packages/mcp/mcp-client/lib/types', file)).href
  const { MachineAuthenticationSession } = await import(/* @vite-ignore */ built('machine-auth.js')) as {
    MachineAuthenticationSession: new (ctx: Context, config: object, endpoint: string, signal: AbortSignal,
      send: typeof fetch) => { fetch: typeof fetch }
  }
  const root = await mkdtemp(join(tmpdir(), 'mcp-old-state-'))
  const context = new Context()
  const abort = new AbortController()
  const issuer = 'https://issuer.example'
  const resource = 'https://resource.example/mcp'
  const clientId = 'https://identity.example/client.json'
  const storageKey = () => Buffer.alloc(32, 135)
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  context.provide('credentials', {
    async resolve(ref: string) {
      return { value: ref === 'MCP_SIGNER' ? pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        : storageKey().toString('base64url') }
    },
  })
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init)
    if (request.url === resource && !request.headers.has('authorization')) {
      return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://resource.example/prm"' } })
    }
    if (request.url === 'https://resource.example/prm') return Response.json({ resource, authorization_servers: [issuer] })
    if (request.url === `${issuer}/.well-known/oauth-authorization-server`) return Response.json({ issuer,
      token_endpoint: `${issuer}/token`, client_id_metadata_document_supported: true, grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] })
    if (request.url === `${issuer}/token`) return Response.json({ token_type: 'Bearer', expires_in: 60, access_token: 'current-fixture-token' })
    expect(request.url).toBe(resource)
    expect(request.headers.get('authorization')).toBe('Bearer current-fixture-token')
    return Response.json({ ok: true })
  })
  const session = (connectionId: string, stateRoot: string, signal = abort.signal) => new MachineAuthenticationSession(context, {
    mode: 'cimd-client-credentials', connectionId, provider: 'credentials', credentialRef: 'MCP_SIGNER',
    credential: { issuer, resource, clientId, keyId: 'fixture' }, stateRoot, encryptionKeyRef: 'MCP_KEY', requestedScopes: ['catalog.read'],
  }, resource, signal, send)
  const seed = async (id: string, dir: string) => {
    const store = new MachineConnectionStore(dir, id, async () => storageKey())
    const generation = await store.open('old-partition')
    const acquiredAt = Date.now() - 1000
    const token: MachineToken = { token: 'old-fixture-token', partition: 'old-partition', issueId: 'old-fixture',
      acquiredAt, expiresAt: acquiredAt + 60_000, scopes: ['catalog.read'] }
    await store.commit(generation, token)
    await store.rememberSent(generation, token.partition, token, () => Promise.resolve())
    return store
  }
  try {
    const activeDir = join(root, 'active')
    const active = await seed('same-connection', activeDir)
    const activeAbort = new AbortController()
    try {
      expect(await (await session('same-connection', activeDir, activeAbort.signal).fetch(resource)).json()).toEqual({ ok: true })
    } finally { activeAbort.abort() }
    expect((await active.sentHistory()).map(record => record.value)).toEqual(['old-fixture-token', 'current-fixture-token'])
    const returned = await active.open('old-partition')
    expect(await active.token(returned, 'old-partition')).toBeUndefined()
    expect((await active.sentHistory()).map(record => record.value)).toEqual(['old-fixture-token', 'current-fixture-token'])

    const disabledDir = join(root, 'disabled')
    const disabled = await seed('disabled-connection', disabledDir)
    await disabled.disable()
    const before = send.mock.calls.length
    await expect(session('disabled-connection', disabledDir).fetch(resource)).rejects.toThrow(/disabled or requires recovery/u)
    expect(send).toHaveBeenCalledTimes(before)
    expect(await disabled.state()).toMatchObject({ active: false })

    const pendingDir = join(root, 'pending')
    const pending = await seed('pending-connection', pendingDir)
    const name = (await readdir(pendingDir)).find(file => file.endsWith('.json'))!
    const file = join(pendingDir, name)
    const row = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    delete row.history
    delete row.historyVersion
    await writeFile(file, JSON.stringify({ ...row, schema: 1 }), { mode: 0o600 })
    const previous = await pending.inspectHistory()
    expect(previous?.migrationId).toBeTypeOf('string')
    await expect(session('pending-connection', pendingDir).fetch(resource)).rejects.toThrow(/disabled or requires recovery/u)
    expect(send).toHaveBeenCalledTimes(before)
    expect(await pending.state()).toEqual(previous)
  } finally {
    abort.abort()
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
