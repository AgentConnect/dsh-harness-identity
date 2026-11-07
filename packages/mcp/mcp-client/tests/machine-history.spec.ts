/** Private encrypted history, receipt CAS and conservative legacy migration. No wall-clock 24-hour run. */
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { MachineConnectionStore } from '../src/machine-store.ts'
import type { MachineToken } from '../src/machine-store.ts'
import { MachineHistoryQuarantine, MACHINE_HISTORY_QUARANTINE } from '../src/machine-history.ts'
import { MachineBearerRedactor } from '../src/machine-output.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(id = 'history') {
  const root = await mkdtemp(join(tmpdir(), 'mcp-history-')); roots.push(root)
  const store = new MachineConnectionStore(root, id, async () => Buffer.alloc(32, 73))
  const generation = await store.open('partition')
  const file = join(root, (await readdir(root)).find(name => name.endsWith('.json'))!)
  const token = (value: string, issueId: string): MachineToken => ({ token: value, issueId, partition: 'partition', acquiredAt: 1000, expiresAt: 61000, scopes: ['read'] })
  return { root, store, generation, file, token }
}

it('preserves encrypted known material across replacement, clear, disable and explicit enable', async () => {
  const f = await fixture()
  const a = f.token('private-bearer-alpha', 'issue-a'); const b = f.token('private-bearer-beta', 'issue-b')
  await f.store.commit(f.generation, a)
  await f.store.rememberSent(f.generation, 'partition', a, async () => {})
  await f.store.clear(f.generation, 'partition')
  await f.store.commit(f.generation, b)
  await f.store.rememberSent(f.generation, 'partition', b, async () => {})
  const reloaded = new MachineConnectionStore(f.root, 'history', async () => Buffer.alloc(32, 73))
  expect((await reloaded.sentHistory()).length).toBe(2)
  const raw = await readFile(f.file, 'utf8')
  expect(raw.includes(a.token) || raw.includes(b.token)).toBe(false)
  await reloaded.disable()
  const disabled = (await reloaded.state())!
  expect((await reloaded.sentHistory()).length).toBe(2)
  await reloaded.enable(disabled.generation, 'new-partition', async () => {})
  expect((await reloaded.sentHistory()).length).toBe(2)
})

it('does not reuse a Token ciphertext as history or copy history to another connection', async () => {
  const f = await fixture()
  const token = f.token('private-purpose-bearer', 'purpose')
  await f.store.commit(f.generation, token)
  await f.store.rememberSent(f.generation, 'partition', token, async () => {})
  const original = JSON.parse(await readFile(f.file, 'utf8'))
  const substituted = { ...original, history: { iv: original.iv, tag: original.tag, ciphertext: original.ciphertext } }
  await writeFile(f.file, JSON.stringify(substituted), { mode: 0o600 })
  await expect(f.store.sentHistory()).rejects.toThrow('credential_store_unavailable')
  await writeFile(f.file, JSON.stringify(original), { mode: 0o600 })
  const other = new MachineConnectionStore(f.root, 'other', async () => Buffer.alloc(32, 73)); await other.open('partition')
  const file = (await readdir(f.root)).filter(name => name.endsWith('.json')).find(name => join(f.root, name) !== f.file)!
  const otherRow = JSON.parse(await readFile(join(f.root, file), 'utf8'))
  await writeFile(join(f.root, file), JSON.stringify({ ...otherRow, history: original.history }), { mode: 0o600 })
  await expect(other.sentHistory()).rejects.toThrow('credential_store_unavailable')
})

it('CAS cleanup preserves a newer receipt and does not reset the connection fence or retry deadline', async () => {
  const f = await fixture()
  const old = f.token('same-private-bearer', 'old-issue')
  await f.store.commit(f.generation, old)
  const previous = await f.store.rememberSent(f.generation, 'partition', old, async () => {})
  const renewed = { ...old, issueId: 'new-issue' }
  await f.store.commit(f.generation, renewed)
  const current = await f.store.rememberSent(f.generation, 'partition', renewed, async () => {})
  await f.store.defer(f.generation, 'partition', 999999)
  const state = await f.store.state()
  await f.store.pruneSentHistory([previous[0]!.receipt])
  expect((await f.store.sentHistory())[0]!.receipt).toBe(current[0]!.receipt)
  await f.store.pruneSentHistory([current[0]!.receipt])
  expect(await f.store.sentHistory()).toEqual([])
  expect(await f.store.state()).toEqual(state)
  expect(await f.store.retryAt(f.generation, 'partition')).toBe(999999)
  expect(await f.store.token(f.generation, 'partition')).toBeUndefined()
})

it('migrates schema1 without altering ciphertext or claiming complete history, and recovery cannot enable it', async () => {
  const f = await fixture()
  await f.store.commit(f.generation, f.token('legacy-private-bearer', 'legacy'))
  const original = JSON.parse(await readFile(f.file, 'utf8'))
  delete original.historyVersion; delete original.history; original.schema = 1
  await writeFile(f.file, JSON.stringify(original), { mode: 0o600 })
  const migrated = await f.store.inspectHistory()
  expect(migrated).toMatchObject({ generation: f.generation, active: true })
  expect(Boolean(migrated?.migrationId)).toBe(true)
  const row = JSON.parse(await readFile(f.file, 'utf8'))
  expect(row.schema).toBe(2); expect(row.ciphertext === original.ciphertext).toBe(true)
  await expect(f.store.open('partition')).rejects.toThrow('machine_history_migration_required')
  await f.store.disable()
  await expect(f.store.completeHistoryRecovery('wrong-migration', () => {})).rejects.toThrow('machine_history_migration_changed')
  await f.store.completeHistoryRecovery(migrated!.migrationId!, () => {})
  expect((await f.store.state())!.active).toBe(false)
  expect((await f.store.state())!.migrationId).toBeUndefined()
  expect(await f.store.sentHistory()).toEqual([])
})

it('does not erase old encrypted data or mint a replacement key when the credential source is unavailable', async () => {
  const f = await fixture()
  await f.store.commit(f.generation, f.token('unavailable-key-bearer', 'missing'))
  const original = JSON.parse(await readFile(f.file, 'utf8'))
  original.schema = 1; delete original.historyVersion; delete original.history
  await writeFile(f.file, JSON.stringify(original), { mode: 0o600 })
  const unavailable = new MachineConnectionStore(f.root, 'history', async () => { throw new Error('key_unavailable') })
  const migrated = await unavailable.inspectHistory()
  expect(migrated?.historyUnavailable).toBe(true)
  expect(migrated?.migrationId).toBeUndefined()
  await expect(unavailable.completeHistoryRecovery('unavailable-migration', () => {})).rejects.toThrow('key_unavailable')
  const kept = JSON.parse(await readFile(f.file, 'utf8'))
  expect(kept.ciphertext === original.ciphertext).toBe(true)
  expect(kept.active).toBe(original.active)
  await expect(unavailable.disable()).rejects.toThrow('credential_store_unavailable')
  expect((await unavailable.state())!.active).toBe(false)
  expect(JSON.parse(await readFile(f.file, 'utf8')).ciphertext === original.ciphertext).toBe(true)
})

it('requires the entire 86431-second monotonic isolation and resets it when the Host is reconstructed', () => {
  let now = 0
  const rule = { connectionId: 'history', migrationId: 'migration-current', kind: 'old-writers-stopped' as const, evidenceRef: 'operator-stopped-1' }
  const clock = new MachineHistoryQuarantine(() => now)
  expect(clock.ready(rule, 'wrong-migration')).toBe(false)
  expect(clock.ready(rule, rule.migrationId)).toBe(false)
  now = MACHINE_HISTORY_QUARANTINE - 1
  expect(clock.ready(rule, rule.migrationId)).toBe(false)
  now++
  expect(clock.ready(rule, rule.migrationId)).toBe(true)
  expect(new MachineHistoryQuarantine(() => now).ready(rule, rule.migrationId)).toBe(false)
  expect(clock.ready({ ...rule, kind: 'prior-bearers-invalidated' }, rule.migrationId)).toBe(true)
})

it('does not restart an unchanged receipt lifetime on every history reload', () => {
  let now = 0
  const redactor = new MachineBearerRedactor(() => now)
  const record = { value: 'private-expiring-bearer', source: 'issue', receipt: 'receipt-current-12345', lifetime: 1000 }
  redactor.observe([record]); now = 30000; redactor.observe([record]); now = 31001
  expect(redactor.expiredReceipts()).toEqual([record.receipt])
  expect(redactor.sanitize(record.value)).toBe(record.value)
  redactor.acknowledgePruned([record.receipt])
  redactor.observe([{ ...record, receipt: 'receipt-new-version-12345' }])
  expect(redactor.sanitize(record.value).includes(record.value)).toBe(false)
})

it('refuses an unsupported future state format without replacing it', async () => {
  const f = await fixture()
  const row = JSON.parse(await readFile(f.file, 'utf8')); row.schema = 3
  const raw = JSON.stringify(row); await writeFile(f.file, raw, { mode: 0o600 })
  await expect(f.store.inspectHistory()).rejects.toThrow('credential_store_unavailable')
  expect((await readFile(f.file, 'utf8')) === raw).toBe(true)
})

it('does not silently evict a live receipt when durable history reaches its count budget', async () => {
  const { createCipheriv, createHash, randomBytes } = await import('node:crypto')
  const f = await fixture()
  const row = JSON.parse(await readFile(f.file, 'utf8'))
  const records = Array.from({ length: 256 }, (_, index) => ({ value: `private-record-${index}`, source: `source-${index}`,
    receipt: `receipt-for-record-${index}-version`, lifetime: 86400000 }))
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 73), iv)
  const fingerprint = createHash('sha256').update(JSON.stringify([row.generation, row.partition,
    row.cipherGeneration ?? row.generation, row.iv ?? '', row.tag ?? '', row.ciphertext ?? ''])).digest('hex')
  cipher.setAAD(Buffer.from('@deepseek-ai/dsh-mcp-client/sent-bearer-history/1:'
    + createHash('sha256').update('history').digest('hex') + ':' + fingerprint))
  const payload = { format: 1, status: 'complete', records }
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
  row.history = { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }
  await writeFile(f.file, JSON.stringify(row), { mode: 0o600 })
  await expect(f.store.rememberSent(f.generation, 'partition', f.token('overflow-private', 'overflow'), async () => {}))
    .rejects.toThrow('machine_secret_retention_full')
  expect((await f.store.sentHistory()).length).toBe(256)
  expect(JSON.parse(await readFile(f.file, 'utf8')).history.ciphertext === row.history.ciphertext).toBe(true)
  expect((await f.store.state())!.active).toBe(true)
})

it('authenticates fresh empty completeness and rejects missing or truncated envelopes', async () => {
  const f = await fixture()
  const original = JSON.parse(await readFile(f.file, 'utf8'))
  expect(Boolean(original.history?.ciphertext)).toBe(true)
  for (const altered of [
    { ...original, history: undefined },
    { ...original, history: { ...original.history, ciphertext: '' } },
    { ...original, history: { ...original.history, tag: 'truncated' } },
  ]) {
    await writeFile(f.file, JSON.stringify(altered), { mode: 0o600 })
    expect((await f.store.inspectHistory())!.historyUnavailable).toBe(true)
    await expect(f.store.open('partition')).rejects.toThrow('credential_store_unavailable')
    await expect(f.store.sentHistory()).rejects.toThrow('credential_store_unavailable')
  }
})

it('cannot remove plaintext migration metadata to bypass the authenticated operator gate', async () => {
  const f = await fixture()
  const fresh = JSON.parse(await readFile(f.file, 'utf8'))
  await f.store.commit(f.generation, f.token('legacy-secret-unchanged', 'legacy'))
  const legacy = JSON.parse(await readFile(f.file, 'utf8'))
  legacy.schema = 1; delete legacy.history; delete legacy.historyVersion
  await writeFile(f.file, JSON.stringify(legacy), { mode: 0o600 })
  const migration = await f.store.inspectHistory()
  const authenticated = JSON.parse(await readFile(f.file, 'utf8'))
  delete authenticated.historyMigration; delete authenticated.historyVersion
  await writeFile(f.file, JSON.stringify(authenticated), { mode: 0o600 })
  expect((await f.store.state())!.migrationId).toBe(migration!.migrationId)
  await expect(f.store.open('partition')).rejects.toThrow('machine_history_migration_required')
  await expect(f.store.completeHistoryRecovery('forged-user-approved', () => {})).rejects.toThrow('machine_history_migration_changed')
  // Replaying this connection's earlier empty envelope cannot qualify a different Token frame as complete.
  await writeFile(f.file, JSON.stringify({ ...authenticated, history: fresh.history }), { mode: 0o600 })
  expect((await f.store.inspectHistory())!.historyUnavailable).toBe(true)
  await expect(f.store.open('partition')).rejects.toThrow('credential_store_unavailable')
})
