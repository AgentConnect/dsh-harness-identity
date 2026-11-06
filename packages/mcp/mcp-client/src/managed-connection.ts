/** Own the machine signer session and actual SDK/tool lifecycle together. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { StreamableHttpConfig } from './index.ts'
import type { ConnectionHandle, ConnectionOutcome, ResolvedReconnectPolicy } from './connection.ts'
import { startConnection } from './connection.ts'
import { createTransport } from './transport.ts'
import { MachineAuthenticationSession } from './machine-auth.ts'
import { MachineConnectionStore } from './machine-store.ts'
import type { MachineConnectionStatus } from './management-types.ts'
import type { MachineAuthentication } from './machine-types.ts'
import { MachineBearerRedactor } from './machine-output.ts'
import { MachineHistoryQuarantine } from './machine-history.ts'
import type { MachineHistoryRecoveryRule } from './machine-history.ts'
import { MachineManagementError } from './management.ts'

type MachineConfig = Omit<StreamableHttpConfig, 'authentication'> & { authentication: MachineAuthentication }

/** One configured connection, retained while explicitly disabled. */
export class ManagedConnection {
  private machine: MachineAuthenticationSession | undefined
  private connection: ConnectionHandle | undefined
  private readonly store: MachineConnectionStore
  private stopped = false
  private enabled = true
  private chain: Promise<unknown> = Promise.resolve()
  private remoteRevocation: MachineConnectionStatus['remoteRevocation'] = 'not_requested'
  private closing = false
  private historyUnavailable = false
  private readonly redactor = new MachineBearerRedactor()
  private readonly quarantine = new MachineHistoryQuarantine()
  constructor(private readonly ctx: Context, private readonly config: MachineConfig,
    private readonly reconnect: ResolvedReconnectPolicy) {
    config = structuredClone(config); this.config = config
    this.store = new MachineConnectionStore(config.authentication.stateRoot, config.authentication.connectionId,
      async () => {
        const credentials = this.ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined
        const resolved = await credentials?.resolve(config.authentication.encryptionKeyRef)
        if (!resolved || !/^[A-Za-z0-9_-]{43}$/u.test(resolved.value)) throw new Error('credential_store_unavailable')
        return Buffer.from(resolved.value, 'base64url')
      })
  }
  /** Start only if the persisted configuration is enabled.
   * @returns The real SDK's initial connection outcome, or a disabled no-op.
   */
  start(): Promise<ConnectionOutcome> {
    return this.serialize(async () => {
      let state: Awaited<ReturnType<MachineConnectionStore['inspectHistory']>>
      try { state = await this.store.inspectHistory() }
      catch { this.enabled = false; this.historyUnavailable = true; return {} }
      if (state?.historyUnavailable) { this.enabled = false; this.historyUnavailable = true; return {} }
      if (state?.migrationId) {
        this.enabled = false
        if (state.quarantineEvidence) this.quarantine.observe(state.migrationId, state.quarantineEvidence)
        return {}
      }
      if (state?.active === false) { this.enabled = false; this.remoteRevocation = 'remote_revocation_unconfirmed'; return {} }
      if (this.stopped || !this.enabled) return {}
      const outcome = await this.connect()
      return this.enabled ? outcome : {}
    })
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation)
    this.chain = run.catch(() => {})
    return run
  }
  private async connect(explicitEnable?: { generation: number; authorize: () => void }): Promise<ConnectionOutcome> {
    if (this.stopped || !this.enabled) throw new Error('connection_disabled')
    explicitEnable?.authorize()
    const machine = this.machine = new MachineAuthenticationSession(
      this.ctx, this.config.authentication, this.config.url, undefined, explicitEnable, this.redactor)
    this.connection = startConnection(this.ctx, this.config, this.reconnect,
      () => createTransport(this.config, machine.fetch), machine.outputProtection())
    return this.connection.ready
  }
  /** Read durable enablement and real supervisor readiness without credentials.
   * @returns Public current connection facts.
   */
  async status(): Promise<MachineConnectionStatus> {
    let fence: Awaited<ReturnType<MachineConnectionStore['state']>>
    try { fence = await this.store.state() } catch { this.historyUnavailable = true }
    const auth = this.machine?.status()
    return { connectionId: this.config.authentication.connectionId,
      generation: fence?.generation ?? 0, remoteRevocation: this.remoteRevocation,
      state: this.closing ? 'disconnecting' : this.historyUnavailable || fence?.historyUnavailable ? 'blocked'
        : !this.enabled && fence?.active === true ? 'blocked'
          : !this.enabled || fence?.active === false ? 'disconnected'
            : auth?.state === 'blocked' ? 'blocked' : this.connection?.status() ?? 'discovering',
      authentication: !this.enabled || fence?.active === false ? 'stopped' : auth?.state === 'blocked' ? 'blocked'
        : auth?.tokenReady ? 'token_ready' : auth?.state === 'ready' ? 'binding_ready' : 'discovering',
      ...(fence?.migrationId ? { migrationId: fence.migrationId,
        historyState: fence.quarantineEvidence ? 'quarantine' as const : 'migration_required' as const }
        : this.historyUnavailable || fence?.historyUnavailable ? { historyState: 'migration_required' as const } : {}) }
  }
  /** Persist a disabled fence before draining the actual SDK and tool registrations. */
  disconnect(): Promise<void> {
    this.enabled = false; this.closing = true
    const machine = this.machine
    const outcomes = Promise.allSettled([machine ? machine.dispose(true) : this.store.disable(), this.connection?.dispose()])
    return this.serialize(async () => {
      try {
        const stopped = await outcomes
        if (machine) this.remoteRevocation = machine.status().remoteRevocation as MachineConnectionStatus['remoteRevocation']
        for (const outcome of stopped) if (outcome.status === 'rejected') throw outcome.reason
        this.historyUnavailable = false
      } finally { this.machine = undefined; this.connection = undefined; this.closing = false }
    })
  }
  /** Explicit re-enable obtains a fresh C lease and CAS-replaces only the observed disabled generation.
   * @param authorize - Current manager and installed owner check, repeated before committing enablement.
   * @param recovery - Exact operator-approved legacy rule from trusted Host configuration.
   */
  enable(authorize: () => void, recovery?: MachineHistoryRecoveryRule): Promise<void> {
    return this.serialize(async () => {
      authorize()
      if (this.stopped) throw new Error('machine_connection_unavailable')
      let fence = await this.store.inspectHistory()
      if (fence?.historyUnavailable) throw new MachineManagementError('history_migration_required')
      if (fence?.migrationId) {
        if (!recovery || recovery.connectionId !== this.config.authentication.connectionId
          || recovery.migrationId !== fence.migrationId) throw new MachineManagementError('history_migration_required')
        const migrationId = fence.migrationId
        if (recovery.kind === 'old-writers-stopped') {
          await this.store.quarantineHistory(migrationId, recovery.evidenceRef, authorize)
          authorize()
        }
        if (!this.quarantine.ready(recovery, migrationId)) throw new MachineManagementError('history_quarantine_required')
        await this.store.completeHistoryRecovery(migrationId, () => {
          authorize()
          if (!this.quarantine.ready(recovery, migrationId)) throw new MachineManagementError('history_quarantine_required')
        })
        authorize()
        await this.store.disable()
        authorize()
        fence = await this.store.state()
      }
      if (!fence || fence.active || this.enabled) throw new Error('machine_connection_not_disabled')
      this.enabled = true
      try {
        const outcome = await this.connect({ generation: fence.generation, authorize })
        if (outcome.error !== undefined) throw new Error('machine_connection_enable_failed')
        const machine = this.machine
        if (!machine) throw new Error('machine_connection_enable_failed')
        await machine.completeEnable()
        authorize()
        this.remoteRevocation = 'not_requested'
        this.historyUnavailable = false
      } catch (error) {
        this.enabled = false
        await Promise.allSettled([this.machine?.dispose(false), this.connection?.dispose()])
        await this.machine?.rollbackEnable()
        this.machine = undefined; this.connection = undefined
        throw error
      }
    })
  }
  /** Process unload stops work but preserves the persisted enabled/disabled state. */
  async dispose(): Promise<void> {
    this.stopped = true; this.enabled = false
    await Promise.allSettled([this.machine?.dispose(false), this.connection?.dispose()])
    await this.chain
  }
}
