import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { discoverMachineTarget } from '../src/machine-discovery.ts'
import { machineFetch, machineJson, publicAddress } from '../src/machine-http.ts'
import { MachineAuthenticationSession } from '../src/machine-auth.ts'
import { MachineConnectionStore } from '../src/machine-store.ts'
import type { MachineAuthentication } from '../src/machine-types.ts'

const inputUrl = (input: string | URL | Request) => input instanceof Request ? input.url : input.toString()
const endpoint = 'https://resource.example/mcp'
const issuer = 'https://auth.example/tenant'
const tokenEndpoint = issuer + '/oauth/token'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const prm = { resource: endpoint, authorization_servers: [issuer] }
const as = { issuer, token_endpoint: tokenEndpoint, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'], client_id_metadata_document_supported: true }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.useRealTimers() })
const root = async () => { const value = await mkdtemp(join(tmpdir(), 'mcp-machine-')); roots.push(value); return value }

async function fixture(overrides: {
  response?: () => Promise<Response>
  resource?: () => Promise<Response>
  metadata?: () => Record<string, unknown>
  cacheMs?: number
} = {}) {
  const stateRoot = await root()
  let revoked = false
  const targetRef = Object.freeze({})
  let assertionCount = 0
  const assertions = vi.fn(async (ref: object): Promise<string> => { expect(ref).toBe(targetRef); return `assertion-${++assertionCount}` })
  const lease = { targetRef, policyGeneration: 1, getOAuthClientIdentity: async () => ({ clientId: 'https://identity.example/client.json', keyId: 'did:web:identity.example#oauth', version: 1, algorithm: 'ES256', signerMode: 'local' }),
    assertActive: async () => { if (revoked) throw new Error('permission_revoked') }, signOAuthClientAssertion: assertions, dispose: vi.fn() }
  const key = randomBytes(32).toString('base64url')
  const ctx = { get: (name: string) => name === 'credentials' ? { resolve: async () => ({ value: key }) } : { bindProtocolConsumer: () => ({ registerValidatedTarget: async () => lease }) } } as unknown as Context
  const tokenRequests: Request[] = []
  const resourceRequests: Request[] = []
  const send: typeof machineFetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url === 'https://resource.example/.well-known/oauth-protected-resource/mcp') { expect(request.headers.has('authorization')).toBe(false); return json(prm) }
    if (request.url === 'https://auth.example/.well-known/oauth-authorization-server/tenant') { expect(request.headers.has('authorization')).toBe(false); return json(overrides.metadata?.() ?? as) }
    if (request.url === tokenEndpoint) { tokenRequests.push(request); return overrides.response ? overrides.response() : json({ access_token: 'secret-machine-token', token_type: 'Bearer', expires_in: 600, scope: 'agent.self.read' }) }
    if (request.url === endpoint) { resourceRequests.push(request); return overrides.resource ? overrides.resource() : json({ jsonrpc: '2.0', result: {} }) }
    throw new Error('unexpected_test_destination')
  }
  const config: MachineAuthentication = { mode: 'cimd-client-credentials', connectionId: 'machine-' + randomUUID(), identityRef: { did: 'did:web:identity.example', storeId: 'store', identityId: 'identity' }, policyRef: 'machine-policy', requestedScopes: ['agent.self.read'], stateRoot, encryptionKeyRef: 'MCP_STORE_KEY', ...(overrides.cacheMs === undefined ? {} : { discoveryCacheMs: overrides.cacheMs }), tokenRetry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 } }
  const session = new MachineAuthenticationSession(ctx, config, endpoint, send)
  return { stateRoot, config, send, ctx, session, tokenRequests, resourceRequests, assertions, revoke: () => { revoked = true } }
}

describe('public machine discovery', () => {
  it('requires exact resource, selected issuer, explicit grant/auth/algorithm and CIMD support', async () => {
    const send = vi.fn<typeof machineFetch>(async input => inputUrl(input).includes('oauth-protected-resource') ? json(prm) : json(as))
    const discovered = await discoverMachineTarget(endpoint, undefined, send)
    expect(discovered).toMatchObject({ resource: endpoint, issuer, tokenEndpoint, profile: 'mcp_machine' })
    expect(send.mock.calls.map(call => inputUrl(call[0]))).toEqual(['https://resource.example/.well-known/oauth-protected-resource/mcp', 'https://auth.example/.well-known/oauth-authorization-server/tenant'])
    for (const change of [{ issuer: 'https://other.example' }, { client_id_metadata_document_supported: false }, { grant_types_supported: ['authorization_code'] }, { token_endpoint_auth_methods_supported: ['none'] }, { token_endpoint_auth_signing_alg_values_supported: ['EdDSA'] }]) {
      await expect(discoverMachineTarget(endpoint, undefined, async input => inputUrl(input).includes('oauth-protected-resource') ? json(prm) : json({ ...as, ...change }))).rejects.toThrow()
    }
    await expect(discoverMachineTarget(endpoint, undefined, async () => json({ ...prm, authorization_servers: [issuer, 'https://second.example'] }))).rejects.toThrow('issuer_selection_required')
    await expect(discoverMachineTarget(endpoint, undefined, async () => json({ ...prm, resource: 'https://resource.example/other' }))).rejects.toThrow('incompatible_resource')
  })
  it('does not treat redirects or malformed JSON as discovery and blocks private numeric addresses', async () => {
    await expect(discoverMachineTarget(endpoint, undefined, async () => new Response(null, { status: 302 }))).rejects.toThrow('discovery_failed')
    await expect(discoverMachineTarget(endpoint, undefined, async () => new Response('not json', { headers: { 'content-type': 'application/json' } }))).rejects.toThrow('incompatible_metadata')
    for (const address of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) expect(publicAddress(address)).toBe(false)
    expect(publicAddress('8.8.8.8')).toBe(true)
    expect(publicAddress('2606:4700:4700::1111')).toBe(true)
    await expect(machineFetch('https://127.0.0.1/mcp')).rejects.toThrow('unsafe_target')
  })
})

describe('machine tokens and transport', () => {
  it('single-flights complete partitions, sends only CC fields, encrypts tokens and reauthenticates after restart', async () => {
    const f = await fixture()
    try {
      await Promise.all(Array.from({ length: 8 }, () => f.session.fetch(endpoint)))
      expect(f.tokenRequests).toHaveLength(1)
      const form = new URLSearchParams(await f.tokenRequests[0]!.text())
      expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'https://identity.example/client.json', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'assertion-1', resource: endpoint, scope: 'agent.self.read' })
      expect(f.resourceRequests.every(request => request.headers.get('authorization') === 'Bearer secret-machine-token')).toBe(true)
      const files = (await readdir(f.stateRoot)).filter(name => name.endsWith('.json'))
      expect(files).toHaveLength(1)
      expect(await readFile(join(f.stateRoot, files[0]!), 'utf8')).not.toContain('secret-machine-token')
      await f.session.dispose()
      const second = new MachineAuthenticationSession(f.ctx, f.config, endpoint, f.send)
      await second.fetch(endpoint)
      expect(f.tokenRequests).toHaveLength(2)
      await second.dispose()
    } finally { await f.session.dispose() }
  })
  it('rejects refresh tokens, invalid lifetimes, scope escalation and narrowed required scopes', async () => {
    for (const fields of [{ refresh_token: 'forbidden' }, { expires_in: 0 }, { expires_in: 90000 }, { token_type: 'DPoP' }, { scope: 'admin' }, { scope: '' }]) {
      const f = await fixture({ response: async () => json({ access_token: 'secret', token_type: 'Bearer', expires_in: 60, ...fields }) })
      await expect(f.session.fetch(endpoint)).rejects.toThrow()
      expect(f.resourceRequests).toHaveLength(0)
      await f.session.dispose()
    }
  })
  it('discards assertions and creates a fresh one after transient Token failure', async () => {
    let count = 0
    const f = await fixture({ response: async () => ++count === 1 ? new Response(null, { status: 503 }) : json({ access_token: 'second-token', token_type: 'Bearer', expires_in: 60 }) })
    try {
      await f.session.fetch(endpoint)
      expect(f.assertions).toHaveBeenCalledTimes(2)
      expect(new URLSearchParams(await f.tokenRequests[0]!.text()).get('client_assertion')).toBe('assertion-1')
      expect(new URLSearchParams(await f.tokenRequests[1]!.text()).get('client_assertion')).toBe('assertion-2')
    } finally { await f.session.dispose() }
  })
  it('never replays a side-effect request after 401, but renews for the next explicit operation', async () => {
    let count = 0
    const f = await fixture({ resource: async () => ++count === 1 ? new Response('secret-remote-body', { status: 401 }) : json({ ok: true }) })
    try {
      await expect(f.session.fetch(endpoint, { method: 'POST', body: JSON.stringify({ method: 'tools/call' }) })).rejects.toThrow('resource_unauthorized_result_unknown')
      expect(f.resourceRequests).toHaveLength(1)
      await f.session.fetch(endpoint)
      expect(f.resourceRequests).toHaveLength(2)
      expect(f.tokenRequests).toHaveLength(2)
    } finally { await f.session.dispose() }
  })
  it('withholds an in-flight Token after revocation and persistent disable fences late commits', async () => {
    let release!: (value: Response) => void
    const hold = new Promise<Response>((resolve) => { release = resolve })
    const f = await fixture({ response: () => hold })
    const pending = f.session.fetch(endpoint)
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => { expect(f.tokenRequests).toHaveLength(1) })
    f.revoke()
    release(json({ access_token: 'late-secret', token_type: 'Bearer', expires_in: 60 }))
    await rejected
    expect(f.resourceRequests).toHaveLength(0)
    await f.session.dispose(true)
    const store = new MachineConnectionStore(f.stateRoot, f.config.connectionId, async () => randomBytes(32))
    await expect(store.open('changed')).rejects.toThrow('connection_disabled')
  })
  it('rejects an old Token result after discovery replaces the target binding', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let version = 1; let count = 0; let release!: (response: Response) => void
    const held = new Promise<Response>((resolve) => { release = resolve })
    const f = await fixture({ cacheMs: 1000, metadata: () => ({ ...as, policy_version: version }),
      response: async () => ++count === 1 ? held : json({ access_token: 'new-binding-token', token_type: 'Bearer', expires_in: 60 }) })
    try {
      const old = f.session.fetch(endpoint)
      const rejected = expect(old).rejects.toThrow('connection_generation_changed')
      await vi.waitFor(() => { expect(f.tokenRequests).toHaveLength(1) })
      now += 1001; version = 2
      await f.session.fetch(endpoint)
      release(json({ access_token: 'old-binding-token', token_type: 'Bearer', expires_in: 60 }))
      await rejected
      expect(f.resourceRequests).toHaveLength(1)
      expect(f.resourceRequests[0]!.headers.get('authorization')).toBe('Bearer new-binding-token')
      await f.session.fetch(endpoint)
      expect(f.resourceRequests.at(-1)!.headers.get('authorization')).toBe('Bearer new-binding-token')
    } finally { await f.session.dispose(); vi.restoreAllMocks() }
  })
  it('rejects duplicate metadata and Token members, including escaped aliases', async () => {
    for (const text of ['{"issuer":"a","issuer":"b"}', '{"access_token":"a","access_\\u0074oken":"b"}', '{"keys":[{"kid":"a","kid":"b"}]}']) {
      await expect(machineJson(new Response(text, { headers: { 'content-type': 'application/json' } }))).rejects.toThrow('incompatible_metadata')
    }
  })
  it('releases a kernel credential-store lock when its owner is killed', async () => {
    const directory = await root()
    const storeUrl = pathToFileURL(join(process.cwd(), 'packages/mcp/mcp-client/src/machine-store.ts')).href
    const script = `import { MachineConnectionStore } from ${JSON.stringify(storeUrl)}; const store = new MachineConnectionStore(process.argv[1], 'crash', async () => { process.stdout.write('held'); await new Promise(() => {}); return Buffer.alloc(32) }); const gen=await store.open('partition'); await store.commit(gen,{token:'never-committed',partition:'partition',acquiredAt:Date.now(),expiresAt:Date.now()+60000,scopes:['read']});`
    const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script, directory], {
      env: { ...process.env, TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.base.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stderr.resume()
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    await Promise.race([new Promise<void>((resolve) => { child.stdout.once('data', () => { resolve() }) }), exited.then(() => { throw new Error('lock_fixture_failed') })])
    child.kill('SIGKILL'); await exited
    const store = new MachineConnectionStore(directory, 'crash', async () => Buffer.alloc(32))
    const gen = await store.open('partition')
    expect(await store.token(gen, 'partition')).toBeUndefined()
    await store.commit(gen, { token: 'recovered', partition: 'partition', acquiredAt: Date.now(), expiresAt: Date.now() + 60000, scopes: ['read'] })
    expect((await store.token(gen, 'partition'))?.token).toBe('recovered')
  })
  // This case identifies and kills the lock-holder child through Linux procfs.
  it.skipIf(process.platform !== 'linux')('cannot revive a disabled fence when the lock holder dies during key resolution', async () => {
    const directory = await root()
    let release!: () => void; let entered!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let blockKey = false; let keyHeld = false
    const old = new MachineConnectionStore(directory, 'holder-loss', async () => {
      if (blockKey && !keyHeld) { keyHeld = true; entered(); await hold }
      return Buffer.alloc(32, 1)
    })
    const generation = await old.open('partition')
    blockKey = true
    const pending = old.commit(generation, { token: 'old', partition: 'partition', acquiredAt: Date.now(), expiresAt: Date.now() + 60000, scopes: ['read'] })
    const rejected = expect(pending).rejects.toThrow('connection_store_locked')
    await started
    const children = (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/u).filter(Boolean)
    let locker: number | undefined
    for (const child of children) {
      const command = await readFile(`/proc/${child}/cmdline`, 'utf8').catch(() => '')
      if (command.includes(directory)) { locker = Number(child); break }
    }
    if (!locker) throw new Error('lock_owner_missing')
    const workers = (await readFile(`/proc/${locker}/task/${locker}/children`, 'utf8')).trim().split(/\s+/u).filter(Boolean)
    process.kill(workers.length ? Number(workers[0]) : locker, 'SIGKILL')
    const replacement = old
    await replacement.disable()
    release(); await rejected
    await expect(replacement.open('partition')).rejects.toThrow('connection_disabled')
  })
  it('stops admission before waiting for the durable disabled fence', async () => {
    const f = await fixture()
    await f.session.fetch(endpoint)
    const store = (f.session as unknown as { store: MachineConnectionStore }).store
    const original = store.disable.bind(store)
    let release!: () => void; let entered!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(store, 'disable').mockImplementation(async () => { entered(); await hold; await original() })
    const stopping = f.session.dispose(true)
    await started
    await expect(f.session.fetch(endpoint)).rejects.toThrow('connection_disabled')
    expect(f.tokenRequests).toHaveLength(1)
    expect(f.resourceRequests).toHaveLength(1)
    release(); await stopping
  })
  it('reserves connection ids across independently evaluated module copies and preserves the next owner on stale disposal', async () => {
    const f = await fixture()
    let next: InstanceType<typeof MachineAuthenticationSession> | undefined
    try {
      vi.resetModules()
      const other = await import('../src/machine-auth.ts')
      expect(other.MachineAuthenticationSession).not.toBe(MachineAuthenticationSession)
      const independentRoot = { get: f.ctx.get.bind(f.ctx) } as unknown as Context
      expect(() => new other.MachineAuthenticationSession(independentRoot, f.config, endpoint, f.send)).toThrow('machine_connection_id_conflict')
      expect(() => new other.MachineAuthenticationSession(independentRoot, { ...f.config, stateRoot: join(f.stateRoot, 'other-directory') }, endpoint, f.send)).toThrow('machine_connection_id_conflict')
      expect(f.tokenRequests).toHaveLength(0)
      expect(f.assertions).not.toHaveBeenCalled()
      await f.session.dispose()
      next = new other.MachineAuthenticationSession(independentRoot, f.config, endpoint, f.send)
      await next.fetch(endpoint)
      await f.session.dispose()
      expect(() => new MachineAuthenticationSession(f.ctx, f.config, endpoint, f.send)).toThrow('machine_connection_id_conflict')
    } finally { await next?.dispose(); await f.session.dispose() }
  })
  it('releases a failed initialization only after its owner is explicitly disposed', async () => {
    const f = await fixture({ metadata: () => ({ ...as, grant_types_supported: ['authorization_code'] }) })
    try {
      await expect(f.session.fetch(endpoint)).rejects.toThrow('unsupported_machine_profile')
      expect(() => new MachineAuthenticationSession(f.ctx, f.config, endpoint, f.send)).toThrow('machine_connection_id_conflict')
    } finally { await f.session.dispose() }
    const successor = new MachineAuthenticationSession(f.ctx, { ...f.config, connectionId: f.config.connectionId }, endpoint, f.send)
    await successor.dispose()
  })
  it('quiesces and releases its Host id when the durable disconnect write fails', async () => {
    const f = await fixture()
    await f.session.fetch(endpoint)
    const store = (f.session as unknown as { store: MachineConnectionStore }).store
    vi.spyOn(store, 'disable').mockRejectedValue(new Error('fixture_write_failure'))
    await expect(f.session.dispose(true)).rejects.toThrow('credential_store_unavailable')
    await expect(f.session.fetch(endpoint)).rejects.toThrow('connection_disabled')
    expect(f.session.status().remoteRevocation).toBe('remote_revocation_unconfirmed')
    const next = new MachineAuthenticationSession(f.ctx, f.config, endpoint, f.send)
    await next.dispose()
  })
  it('denies managed headers and cross-resource sends before acquiring any token', async () => {
    const f = await fixture()
    try {
      await expect(f.session.fetch(endpoint, { headers: { authorization: 'Bearer attacker' } })).rejects.toThrow('managed_authentication_header')
      await expect(f.session.fetch(endpoint, { headers: { Host: 'different.example' } })).rejects.toThrow('managed_authentication_header')
      expect(f.assertions).not.toHaveBeenCalled()
      await expect(f.session.fetch('https://resource.example/other')).rejects.toThrow('resource_mismatch')
      expect(f.tokenRequests).toHaveLength(0)
    } finally { await f.session.dispose() }
  })
})

it('rechecks a different process durable fence after the final history/lease await before a physical send', async () => {
  const f = await fixture(); await f.session.fetch(endpoint)
  const binding = (f.session as unknown as { binding: { lease: { assertActive(): Promise<void> } } }).binding
  const lease = binding.lease; const originalLease = lease.assertActive.bind(lease)
  const originalRemember = Object.getOwnPropertyDescriptor(MachineConnectionStore.prototype, 'rememberSent')?.value as MachineConnectionStore['rememberSent'] | undefined
  const remember = vi.spyOn(MachineConnectionStore.prototype, 'rememberSent')
  if (!originalRemember) throw new Error('Missing original sent-history method')
  let armed = false; let held = false; let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const pause = new Promise<void>((resolve) => { release = resolve })
  remember.mockImplementation(async function (this: MachineConnectionStore, ...args) {
    const result = await originalRemember.apply(this, args); armed = true; return result
  })
  const checking = vi.spyOn(lease, 'assertActive').mockImplementation(async () => {
    await originalLease()
    if (armed && !held) { held = true; entered(); await pause }
  })
  const before = f.resourceRequests.length
  const credentials = f.ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string }> }
  const other = new MachineConnectionStore(f.stateRoot, f.config.connectionId,
    async () => Buffer.from((await credentials.resolve(f.config.encryptionKeyRef)).value, 'base64url'))
  try {
    const sending = f.session.fetch(endpoint); await waiting
    await other.disable(); release()
    await expect(sending).rejects.toThrow('connection_generation_changed')
    expect(f.resourceRequests.length).toBe(before)
  } finally { release(); checking.mockRestore(); remember.mockRestore(); await f.session.dispose() }
})
