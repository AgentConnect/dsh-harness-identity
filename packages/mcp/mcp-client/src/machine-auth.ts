/** One machine connection: public discovery, local identity lease, encrypted tokens and request authentication. @module */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { discoverMachineTarget } from './machine-discovery.ts'
import { machineFetch, machineJson, assertMachineDirectRoute } from './machine-http.ts'
import { MachineConnectionStore } from './machine-store.ts'
import type { MachineToken } from './machine-store.ts'
import type { MachineAuthentication, MachineIdentityService, MachineIdentityClient, MachineSignerLease, MachineTarget } from './machine-types.ts'
import { MachineBearerRedactor } from './machine-output.ts'
import type { MachineOutputProtection } from './machine-output.ts'

interface Binding {
  readonly target: MachineTarget
  readonly lease: MachineSignerLease
  readonly generation: number
  readonly partition: string
}
interface Credentials { resolve(ref: string): Promise<{ value: string } | undefined> }
interface AuthenticationStatus {
  connectionId: string
  state: string
  tokenReady: boolean
  generation: number
  remoteRevocation: string
  issuer?: string
  resource?: string
}
class RetryableTokenError extends Error { constructor(code: string, readonly retryAfterMs = 0) { super(code) } }
const flights = new Map<string, Promise<MachineToken>>()
const ownerRegistryKey = Symbol.for('@deepseek-ai/dsh-mcp-client/connection-owners/1')
const processRegistry = globalThis as typeof globalThis & Record<symbol, unknown>
const connectionOwners = (processRegistry[ownerRegistryKey] ??= new Map<string, symbol>()) as Map<string, symbol>

/** Host-only connection authentication manager. SDK OAuth providers are deliberately absent. */
export class MachineAuthenticationSession {
  private readonly connectionOwner = Symbol('mcp-machine-connection')
  private disposed = false
  private closing = false
  private disposal: Promise<void> | undefined
  private readonly controller = new AbortController()
  private binding: Binding | undefined
  private readonly store!: MachineConnectionStore
  private readonly initialized: Promise<void>
  private readonly refreshTarget: () => Promise<void>
  private refreshing: Promise<void> | undefined
  private blocked = false
  private tokenReady = false
  private managementAuthorization: (() => void) | undefined
  private readonly enableOperationId: string | undefined
  private tokenExpiresAt = 0
  private tokenAttempts = 0
  private priorTokenMayRemain = false
  private issuedSource: string | undefined
  private revocation: 'not_requested' | 'confirmed' | 'remote_revocation_unconfirmed' = 'not_requested'
  private monotonic?: { wall: number; tick: number }
  private readonly startedAt = Date.now()
  private readonly pending = new Set<Promise<unknown>>()
  constructor(ctx: Context, private readonly config: MachineAuthentication, endpoint: string,
    private readonly send: typeof machineFetch = machineFetch,
    explicitEnable?: { generation: number; authorize: () => void },
    private readonly redactor = new MachineBearerRedactor(), readEncryptionKey?: () => Promise<Buffer>,
    private readonly assertRoute: (url: string) => void = assertMachineDirectRoute, identityClient?: MachineIdentityClient) {
    config = structuredClone(config)
    this.config = config
    this.managementAuthorization = explicitEnable?.authorize
    this.enableOperationId = explicitEnable ? randomUUID() : undefined
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(config.connectionId)) throw new Error('invalid_connection_id')
    if (connectionOwners.has(config.connectionId)) throw new Error('machine_connection_id_conflict')
    connectionOwners.set(config.connectionId, this.connectionOwner)
    try {
      const identity = ctx.get('anpIdentity') as MachineIdentityService | undefined
      const credentials = ctx.get('credentials') as Credentials | undefined
      if (!identity && !identityClient || !credentials && !readEncryptionKey) throw new Error('machine_auth_provider_unavailable')
      this.store = new MachineConnectionStore(config.stateRoot, config.connectionId, readEncryptionKey ?? (async () => {
        const resolved = await credentials?.resolve(config.encryptionKeyRef)
        if (!resolved || !/^[A-Za-z0-9_-]{43}$/u.test(resolved.value)) throw new Error('credential_store_unavailable')
        return Buffer.from(resolved.value, 'base64url')
      }))
      this.refreshTarget = async () => {
        const publicSend: typeof machineFetch = (url, init) => { if (this.closing) return Promise.reject(new Error('connection_disabled')); return send(url, { ...init, signal: AbortSignal.any([this.controller.signal, ...(init?.signal ? [init.signal] : [])]) }) }
        const target = await discoverMachineTarget(endpoint, config.issuer, publicSend, config.discoveryCacheMs)
        this.assertOpen()
        this.assertRoute(target.resource)
        this.assertRoute(target.tokenEndpoint)
        const protocolIdentity = identityClient ?? identity?.bindProtocolConsumer(ctx)
        if (!protocolIdentity) throw new Error('machine_auth_provider_unavailable')
        const lease = await protocolIdentity.registerValidatedTarget({ identityRef: config.identityRef,
          policyRef: config.policyRef, discovery: target, requestedScopes: config.requestedScopes })
        try {
          await lease.assertActive()
          const client = await lease.getOAuthClientIdentity()
          this.redactor.registerIdentity(client.clientId)
          assertLocalMachineProfile(client)
          const partition = createHash('sha256').update(JSON.stringify([config.identityRef, client.clientId, client.keyId, client.version,
            target.issuer, target.resource, target.metadataDigest, [...new Set(config.requestedScopes)].sort(), config.mode, config.connectionId, lease.policyGeneration])).digest('hex')
          const requestedEnable = explicitEnable
          await this.store.inspectHistory()
          await this.syncHistory()
          const generation = requestedEnable
            ? await this.store.enable(requestedEnable.generation, partition, async () => {
              requestedEnable.authorize()
              this.assertOpen()
              await lease.assertActive()
              requestedEnable.authorize()
              this.assertOpen()
            }, this.enableOperationId)
            : await this.store.open(partition)
          explicitEnable = undefined
          this.assertOpen()
          await this.syncHistory()
          await lease.assertActive()
          this.assertOpen()
          const previous = this.binding
          this.tokenReady = false
          this.binding = Object.freeze({ target, lease, partition, generation })
          previous?.lease.dispose()
        } catch (error) { lease.dispose(); throw error }
      }
      this.initialized = this.refreshTarget()
      void this.initialized.catch(() => {})
    } catch (error) { this.releaseConnectionOwner(); throw error }
  }
  private releaseConnectionOwner(): void {
    if (connectionOwners.get(this.config.connectionId) === this.connectionOwner) connectionOwners.delete(this.config.connectionId)
  }
  /** SDK fetch hook; one physical send, with no business-call replay.
   * @param input - SDK request URL.
   * @param init - SDK request fields.
   * @returns Authorized response, or a sanitized protocol error.
   */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    this.assertOpen()
    const operation = this.dispatch(input, init)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }
  private assertOpen(): void { if (this.disposed || this.closing) throw new Error('connection_disabled') }
  private bindingSnapshot(): Binding | undefined { return this.binding }
  private async currentBinding(): Promise<Binding> {
    await this.initialized
    await this.syncHistory()
    if (!this.binding) throw new Error('connection_disabled')
    if (Date.now() >= this.binding.target.expiresAt) {
      this.refreshing ??= this.refreshTarget().finally(() => { this.refreshing = undefined })
      await this.refreshing
    }
    const binding = this.bindingSnapshot()
    if (!binding) throw new Error('connection_disabled')
    return binding
  }
  private async dispatch(input: string | URL | Request, init: RequestInit): Promise<Response> {
    const binding = await this.currentBinding()
    const request = new Request(input, init)
    if (request.url !== new URL(binding.target.resource).href) throw new Error('resource_mismatch')
    if (request.headers.has('host') || request.headers.has('authorization') || request.headers.has('poppy-session') || request.headers.has('dpop')) throw new Error('managed_authentication_header')
    this.assertRoute(binding.target.resource)
    const token = await this.acquire(binding)
    await this.assertBinding(binding)
    this.assertOpen()
    await this.store.assertCurrent(binding.generation, binding.partition)
    request.headers.set('authorization', `Bearer ${token.token}`)
    this.redactor.remember(token.token, token.acquiredAt, token.expiresAt - token.acquiredAt)
    try {
      const records = await this.store.rememberSent(binding.generation, binding.partition, token, () => this.assertBinding(binding))
      if (records.some(record => record.source !== this.issuedSource)) this.priorTokenMayRemain = true
      this.redactor.observe(records)
    }
    catch (error) { this.blocked = true; throw error }
    await this.assertBinding(binding)
    await this.store.assertCurrent(binding.generation, binding.partition)
    this.assertBindingNow(binding)
    const response = await this.send(request, { redirect: 'manual', signal: AbortSignal.any([request.signal, this.controller.signal]) })
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('credential_redirect_blocked') }
    if (response.status === 401) {
      this.tokenReady = false
      await response.body?.cancel(); await this.store.clear(binding.generation, binding.partition)
      throw new Error('resource_unauthorized_result_unknown')
    }
    if (response.status === 403) { await response.body?.cancel(); throw new Error('resource_forbidden') }
    if (request.method === 'GET' && response.status === 405) { await response.body?.cancel(); return new Response(null, { status: 405 }) }
    if (!response.ok) { await response.body?.cancel(); throw new Error('resource_request_failed_result_unknown') }
    return response
  }
  /** Private bridge callbacks; bearer values never leave the redactor.
   * @returns Protection for this session's SDK metadata, results and diagnostics.
   */
  outputProtection(): MachineOutputProtection {
    return { prepare: async () => { await this.currentBinding() },
      begin: () => this.redactor.begin(), sanitize: value => this.redactor.sanitize(value), assertActive: async () => {
        await this.initialized
        const binding = this.binding
        if (!binding) throw new Error('connection_disabled')
        await this.assertBinding(binding)
        await this.store.assertCurrent(binding.generation, binding.partition)
        await this.syncHistory()
        await this.assertBinding(binding)
        await this.store.assertCurrent(binding.generation, binding.partition)
        this.assertBindingNow(binding)
      } }
  }
  private async syncHistory(): Promise<void> {
    try {
      const expired = this.redactor.expiredReceipts()
      await this.store.pruneSentHistory(expired)
      this.redactor.acknowledgePruned(expired)
      const records = await this.store.sentHistory()
      if (records.some(record => record.source !== this.issuedSource)) this.priorTokenMayRemain = true
      this.redactor.observe(records)
    } catch (error) { this.blocked = true; throw error }
  }
  private assertBindingNow(binding: Binding): void {
    this.managementAuthorization?.()
    if (this.disposed || this.closing || this.binding !== binding || Date.now() >= binding.target.expiresAt) throw new Error('connection_generation_changed')
  }
  private async assertBinding(binding: Binding): Promise<void> {
    this.assertBindingNow(binding)
    await binding.lease.assertActive()
    this.assertBindingNow(binding)
  }
  private async acquire(binding: Binding): Promise<MachineToken> {
    await this.assertBinding(binding)
    if (this.disposed || this.blocked || Date.now() >= binding.target.expiresAt) throw new Error('target_revalidation_required')
    const token = await this.store.token(binding.generation, binding.partition)
    if (token) this.redactor.remember(token.token, token.acquiredAt, token.expiresAt - token.acquiredAt)
    const now = Date.now()
    const rollback = this.monotonic && now < this.monotonic.wall + (performance.now() - this.monotonic.tick) - 1000
    this.monotonic = { wall: now, tick: performance.now() }
    if (token && token.acquiredAt >= this.startedAt && !rollback && now >= token.acquiredAt
      && token.expiresAt - now > Math.min(30000, (token.expiresAt - token.acquiredAt) / 10)) {
      this.tokenReady = true; this.tokenExpiresAt = token.expiresAt
      return token
    }
    this.tokenReady = false
    if (token && token.expiresAt > now) this.priorTokenMayRemain = true
    if (now < await this.store.retryAt(binding.generation, binding.partition)) throw new Error('token_rate_limited')
    const flightKey = `${this.config.stateRoot}:${this.config.connectionId}:${binding.generation}:${binding.partition}`
    let flight = flights.get(flightKey)
    if (!flight) {
      flight = this.issueWithRetry(binding)
      flights.set(flightKey, flight)
      void flight.finally(() => { if (flights.get(flightKey) === flight) flights.delete(flightKey) }).catch(() => {})
    }
    const acquired = await flight
    this.assertOpen()
    await this.assertBinding(binding)
    this.tokenReady = true
    this.tokenExpiresAt = acquired.expiresAt
    return acquired
  }
  private async issueWithRetry(binding: Binding): Promise<MachineToken> {
    const retry = this.config.tokenRetry ?? { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 5000 }
    for (let attempt = 0;; attempt++) {
      try { return await this.issue(binding) }
      catch (error) {
        const code = error instanceof Error ? error.message : 'token_request_rejected'
        if (!['network_failure', 'token_temporarily_unavailable', 'token_rate_limited'].includes(code)) { if (this.binding === binding && !this.disposed) this.blocked = true; throw new Error(code) }
        if (attempt + 1 >= retry.maxAttempts) throw new Error(code)
        const requestedDelay = error instanceof RetryableTokenError ? error.retryAfterMs : 0
        if (requestedDelay > retry.maxDelayMs) throw new Error(code)
        const delay = Math.max(requestedDelay, Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** attempt))
        await setTimeout(delay, undefined, { signal: this.controller.signal })
        await this.assertBinding(binding)
      }
    }
  }
  private async issue(binding: Binding): Promise<MachineToken> {
    this.assertRoute(binding.target.tokenEndpoint)
    const client = await binding.lease.getOAuthClientIdentity()
    const assertion = await binding.lease.signOAuthClientAssertion(binding.lease.targetRef)
    this.redactor.rememberAssertion(assertion)
    const scopes = [...new Set(this.config.requestedScopes)].sort()
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: client.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion,
      resource: binding.target.resource, scope: scopes.join(' ') })
    await this.assertBinding(binding)
    await this.store.assertCurrent(binding.generation, binding.partition)
    const acquiredAt = Date.now()
    this.tokenAttempts++
    const response = await this.send(binding.target.tokenEndpoint, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(), signal: this.controller.signal })
    if (response.status !== 200) {
      const retryAfter = response.headers.get('retry-after')
      await response.body?.cancel()
      if (response.status === 429) {
        const milliseconds = retryAfter && /^[0-9]+$/u.test(retryAfter) ? Number(retryAfter) * 1000
          : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 0
        const delay = Number.isFinite(milliseconds) ? Math.min(milliseconds, 86400000) : 0
        await this.assertBinding(binding)
        await this.store.defer(binding.generation, binding.partition, Date.now() + delay)
        throw new RetryableTokenError('token_rate_limited', delay)
      }
      throw new Error(response.status >= 500 ? 'token_temporarily_unavailable' : 'token_request_rejected')
    }
    const value = await machineJson(response)
    if (typeof value.access_token !== 'string' || !/^[\x21-\x7e]{1,32768}$/u.test(value.access_token)
      || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' || value.refresh_token !== undefined
      || !Number.isSafeInteger(value.expires_in) || (value.expires_in as number) <= 0 || (value.expires_in as number) > 86400
      || value.scope !== undefined && typeof value.scope !== 'string') throw new Error('incompatible_token_response')
    const granted = value.scope === undefined ? scopes : value.scope.split(' ').filter(Boolean)
    if (granted.some(scope => !scopes.includes(scope)) || scopes.some(scope => !granted.includes(scope))) throw new Error('insufficient_scope')
    const issueId = randomUUID()
    this.issuedSource = issueId
    const token: MachineToken = { token: value.access_token, acquiredAt, issueId,
      expiresAt: acquiredAt + (value.expires_in as number) * 1000, scopes: granted, partition: binding.partition }
    await this.assertBinding(binding)
    if (this.disposed || Date.now() >= token.expiresAt) throw new Error('connection_disabled')
    await this.store.commit(binding.generation, token, () => this.assertBinding(binding))
    return token
  }
  /** Return public connection facts without secret references or credential values.
   * @returns Sanitized Host management status.
   */
  status(): AuthenticationStatus {
    return { connectionId: this.config.connectionId, remoteRevocation: this.revocation, tokenReady: this.tokenReady && !this.disposed && Date.now() < this.tokenExpiresAt, state: this.disposed ? 'disconnected' : this.blocked ? 'blocked' : this.binding ? 'ready' : 'discovering', generation: this.binding?.generation ?? 0,
      ...(this.binding ? { issuer: this.binding.target.issuer, resource: this.binding.target.resource } : {}) }
  }
  /** Complete explicit enablement after actual SDK readiness while the manager remains authorized. */
  async completeEnable(): Promise<void> {
    await this.initialized
    if (!this.binding) throw new Error('connection_disabled')
    await this.assertBinding(this.binding)
    this.managementAuthorization?.()
    this.managementAuthorization = undefined
  }
  /** Roll back only this enable operation, including an uncertain local write result. */
  async rollbackEnable(): Promise<void> {
    if (this.enableOperationId) await this.store.disable(undefined, this.enableOperationId)
  }
  /** Stop work and quiesce requests. Explicit disconnect persists a disabled fence.
   * @param disconnect - Whether this is a management disconnect rather than process unload.
   */
  dispose(disconnect = false): Promise<void> {
    this.closing = true
    this.disposal ??= this.close(disconnect, this.pending.size > 0 || this.tokenAttempts > 1 || this.priorTokenMayRemain)
    return this.disposal
  }
  private async close(disconnect: boolean, uncertain: boolean): Promise<void> {
    try {
      const binding = this.binding
      const token = disconnect && binding ? await this.store.token(binding.generation, binding.partition).catch(() => undefined) : undefined
      if (disconnect) {
        try { if ((await this.store.sentHistory()).some(record => record.source !== this.issuedSource)) uncertain = true }
        catch { uncertain = true }
      }
      let fenceFailed = false
      try { if (disconnect) await this.store.disable() } catch { fenceFailed = true }
      this.disposed = true; this.controller.abort()
      await this.initialized.catch(() => {})
      await Promise.allSettled([...this.pending])
      if (disconnect) {
        this.revocation = 'remote_revocation_unconfirmed'
        if (binding?.target.revocationEndpoint && token) {
          try {
            this.assertRoute(binding.target.revocationEndpoint)
            await binding.lease.assertActive()
            const client = await binding.lease.getOAuthClientIdentity()
            const assertion = await binding.lease.signOAuthClientAssertion(binding.lease.targetRef)
            this.redactor.registerIdentity(client.clientId)
            this.redactor.rememberAssertion(assertion)
            await binding.lease.assertActive()
            const response = await this.send(binding.target.revocationEndpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
              headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.token, token_type_hint: 'access_token',
                client_id: client.clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }).toString() })
            await response.body?.cancel()
            if (response.ok && !uncertain && !fenceFailed) this.revocation = 'confirmed'
          } catch { /* Local disconnect remains committed if the independent remote revocation fails. */ }
        }
      }
      if (fenceFailed) throw new Error('credential_store_unavailable')
    } finally {
      this.binding?.lease.dispose()
      this.releaseConnectionOwner()
    }
  }
}

/** Validate the external provider contract even when its TypeScript declaration uses literals. */
function assertLocalMachineProfile(client: { algorithm: unknown; signerMode: unknown }): void {
  if (client.algorithm !== 'ES256' || client.signerMode !== 'local') throw new Error('unsupported_machine_profile')
}
