/** Cross-connection credential history for single-operation domain sessions. @module */
import { createHash, randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { MachineConnectionStore } from './machine-store.ts'
import { MachineBearerRedactor } from './machine-output.ts'

/** Retained encrypted state cannot be replaced merely because a key is missing. */
export class DomainHistoryError extends Error {
  /** @param code - Stable storage refusal. */
  constructor(readonly code: string) { super(code) }
}

/** Obtain one protected credential key atomically without exposing it to configuration or tools.
 * @param credentials - Host credential provider.
 * @param stateRoot - Existing encrypted connection root.
 * @param connectionId - Exact persistent connection id.
 * @param create - Whether this is a new connection rather than restoring retained history.
 * @returns A per-operation key reader that never silently replaces existing ciphertext keys.
 */
export async function domainKeyReader(
  credentials: CredentialProvider, stateRoot: string, connectionId: string, create = true,
): Promise<() => Promise<Buffer>> {
  const digest = createHash('sha256').update(connectionId).digest('hex')
  const key = credentialKey('mcp-domain', `key-${digest}`)
  await credentials.modifyRecord(key, async (current) => {
    if (current) return undefined
    if (!create) throw new DomainHistoryError('domain_history_unavailable')
    try { await stat(join(stateRoot, `${digest}.json`)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { kind: 'api-key', key: randomBytes(32).toString('base64url') }
    }
    throw new DomainHistoryError('credential_store_unavailable')
  })
  return async () => {
    const record = await credentials.modifyRecord(key, async () => undefined)
    if (record?.kind !== 'api-key' || !record.key || !/^[A-Za-z0-9_-]{43}$/u.test(record.key)) throw new DomainHistoryError('credential_store_unavailable')
    return Buffer.from(record.key, 'base64url')
  }
}

/** Retains one-shot receipts and keys until they can be safely retired, including across restart. */
export class DomainCredentialHistory {
  /** Domain-owned masking of retained credentials across persistent and single-operation sessions. */
  readonly redactor = new MachineBearerRedactor()
  private readonly indexKey: ReturnType<typeof credentialKey>
  constructor(private readonly credentials: CredentialProvider, private readonly root: string, private readonly maxRecords: number) {
    this.indexKey = credentialKey('mcp-domain', `inventory-${createHash('sha256').update(root).digest('hex')}`)
  }
  /** Register a new one-shot id before acquiring any elevated token.
   * @param connectionId - Unique id for this consent, never reused by another grant.
   * @returns Protected encryption-key reader for the normal MachineConnectionStore.
   */
  async reserve(connectionId: string): Promise<() => Promise<Buffer>> {
    const readKey = await domainKeyReader(this.credentials, this.root, connectionId)
    await this.credentials.modifyRecord(this.indexKey, async (current) => {
      const ids = this.ids(current?.kind === 'grant' ? current.payload : current === undefined ? undefined : null)
      if (!ids.includes(connectionId)) {
        if (ids.length >= this.maxRecords) throw new DomainHistoryError('domain_history_limit')
        ids.push(connectionId)
      }
      return { kind:'grant',payload:{ version:1,connections:ids } }
    })
    return readKey
  }
  /** Restore all retained sent-bearer records before model-visible output or another send. */
  async restore(): Promise<void> {
    const record = await this.credentials.modifyRecord(this.indexKey, async () => undefined)
    const ids = this.ids(record?.kind === 'grant' ? record.payload : record === undefined ? undefined : null)
    try {
      for (const id of ids) {
        const readKey = await domainKeyReader(this.credentials, this.root, id, false)
        const store = new MachineConnectionStore(this.root, id, readKey)
        const state = await store.inspectHistory()
        // A reservation without a row precedes token acquisition. Any existing row must authenticate.
        if (state?.historyUnavailable || state?.migrationId) throw new DomainHistoryError('domain_history_unavailable')
        if (state) this.redactor.observe(await store.sentHistory())
      }
    } catch (error) {
      if (error instanceof DomainHistoryError) throw error
      throw new DomainHistoryError('domain_history_unavailable')
    }
  }
  private ids(value: unknown): string[] {
    if (value === undefined) return []
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('connections' in value)
      || !Array.isArray(value.connections) || value.connections.length > this.maxRecords
      || !value.connections.every(id => typeof id === 'string' && /^once-[a-f0-9]{64}$/u.test(id))) throw new DomainHistoryError('domain_history_unavailable')
    return [...value.connections]
  }
}
