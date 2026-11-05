/** Encrypted, cross-process fenced machine connection storage. @module */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Opaque bearer and its exact local partition; never a public connection description. */
export interface MachineToken { token: string; expiresAt: number; acquiredAt: number; scopes: string[]; partition: string }
interface Row {
  schema: 1
  generation: number
  active: boolean
  partition: string
  retryNotBefore?: number
  iv?: string
  tag?: string
  ciphertext?: string
}

/** Stores encrypted credentials separately for one persistent connection id. */
export class MachineConnectionStore {
  private readonly file: string
  private readonly lock: string
  constructor(private readonly root: string, connectionId: string, private readonly key: () => Promise<Buffer>) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(connectionId)) throw new Error('invalid_connection_id')
    this.file = join(root, createHash('sha256').update(connectionId).digest('hex') + '.json')
    this.lock = this.file + '.lock'
  }
  /** Read the persistent fence, creating the connection only when absent.
   * @param partition - Full identity/resource/key/policy partition.
   * @returns Current connection generation.
   */
  async open(partition: string): Promise<number> {
    return this.transaction(async (write) => {
      let row = await this.read()
      if (row && !row.active) throw new Error('connection_disabled')
      if (!row || row.partition !== partition) {
        row = { schema: 1, generation: (row?.generation ?? 0) + 1, active: true, partition }
        await write(row)
      }
      return row.generation
    })
  }
  /** Read only the matching active generation.
   * @param generation - Expected durable generation.
   * @param partition - Exact credential partition.
   * @returns Decrypted token, if one was committed.
   */
  async token(generation: number, partition: string): Promise<MachineToken | undefined> {
    const row = await this.read()
    this.check(row, generation, partition)
    if (!row.ciphertext || !row.iv || !row.tag) return undefined
    try {
      const key = await this.key()
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64url'))
        decipher.setAAD(Buffer.from(`${generation}:${partition}`)); decipher.setAuthTag(Buffer.from(row.tag, 'base64url'))
        const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64url')), decipher.final()]).toString('utf8'))
        if (!value || typeof value !== 'object') throw new Error()
        const token = value as MachineToken
        if (token.partition !== partition || typeof token.token !== 'string' || !Number.isSafeInteger(token.expiresAt)
          || !Number.isSafeInteger(token.acquiredAt) || !Array.isArray(token.scopes) || !token.scopes.every(v => typeof v === 'string')) throw new Error()
        return token
      } finally { key.fill(0) }
    } catch { throw new Error('credential_store_unavailable') }
  }
  /** Atomically commit only while the connection is still active.
   * @param generation - Expected generation.
   * @param value - Secret token.
   * @param authorize - Rechecks the captured local permission and generation inside the commit lock.
   */
  async commit(generation: number, value: MachineToken, authorize?: () => Promise<void>): Promise<void> {
    await this.transaction(async (write) => {
      const row = await this.read(); this.check(row, generation, value.partition)
      const key = await this.key()
      try {
        await authorize?.()
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(Buffer.from(`${generation}:${value.partition}`))
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
        await write({ ...row, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') })
      } finally { key.fill(0) }
    })
  }
  /** Check the durable disabled/generation fence immediately before a physical send.
   * @param generation - Expected generation.
   * @param partition - Exact credential partition.
   */
  async assertCurrent(generation: number, partition: string): Promise<void> { this.check(await this.read(), generation, partition) }
  /** Persist AS throttling across process instances.
   * @param generation - Current generation.
   * @param partition - Exact partition.
   * @param until - Wall-clock deadline; no retry is admitted before this value.
   */
  async defer(generation: number, partition: string, until: number): Promise<void> {
    await this.transaction(async (write) => {
      const row = await this.read(); this.check(row, generation, partition)
      await write({ ...row, retryNotBefore: Math.max(row.retryNotBefore ?? 0, until) })
    })
  }
  /** Read the shared Token retry deadline.
   * @param generation - Current generation.
   * @param partition - Exact partition.
   * @returns Earliest allowed attempt time.
   */
  async retryAt(generation: number, partition: string): Promise<number> {
    const row = await this.read(); this.check(row, generation, partition)
    return row.retryNotBefore ?? 0
  }
  /** Clear a rejected token without reviving a disabled generation.
   * @param generation - Expected generation.
   * @param partition - Exact credential partition.
   */
  async clear(generation: number, partition: string): Promise<void> {
    await this.transaction(async (write) => {
      const row = await this.read(); this.check(row, generation, partition)
      await write({ schema: 1, generation, active: true, partition })
    })
  }
  /** Persist the disabled fence before any in-flight result can commit. */
  async disable(): Promise<void> {
    await this.transaction(async (write) => {
      const row = await this.read()
      await write({ schema: 1, generation: (row?.generation ?? 0) + 1, active: false, partition: row?.partition ?? '' })
    })
  }
  private check(row: Row | undefined, generation: number, partition: string): asserts row is Row {
    if (!row || !row.active || row.generation !== generation || row.partition !== partition) throw new Error('connection_generation_changed')
  }
  private async read(): Promise<Row | undefined> {
    try {
      const info = await stat(this.file)
      if (info.size > 131072 || (info.mode & 0o077) !== 0) throw new Error('credential_store_unavailable')
      const row = JSON.parse(await readFile(this.file, 'utf8')) as Row
      if (row.schema !== 1 || !Number.isSafeInteger(row.generation) || typeof row.active !== 'boolean' || typeof row.partition !== 'string') throw new Error()
      return row
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('credential_store_unavailable')
    }
  }
  private async transaction<T>(run: (write: (row: Row) => Promise<void>) => Promise<T>): Promise<T> {
    if (process.platform !== 'linux') throw new Error('machine_store_platform_unsupported')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const lockFile = await open(this.lock, 'a', 0o600); await lockFile.close()
    // The process holding the kernel lock performs every rename. A killed holder cannot later revive an old fence.
    const script = String.raw`
      const fs = require('node:fs/promises');
      const { randomUUID } = require('node:crypto');
      const lines = require('node:readline').createInterface({ input: process.stdin });
      const target = process.argv[1], root = process.argv[2];
      const emit = value => process.stdout.write(value + String.fromCharCode(10));
      emit('locked');
      let chain = Promise.resolve();
      lines.on('line', line => { chain = chain.then(async () => {
        const value = JSON.parse(line), temporary = target + '.' + randomUUID();
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
        try { await fs.rename(temporary, target); } finally { await fs.unlink(temporary).catch(() => {}); }
        const directory = await fs.open(root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        emit('written');
      }).catch(() => { emit('failed'); process.exitCode = 1; process.stdin.destroy(); }); });
      lines.on('close', () => { void chain.then(() => {}); });
    `
    const environment = scrubbedParentEnv()
    // The executable belongs to this Host. Only this private worker must enter Node mode under Electron.
    if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1'
    const owner = spawn('flock', ['--exclusive', '--timeout', '10', this.lock, process.execPath, '-e', script, this.file, this.root],
      { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    owner.stderr.resume()
    let acknowledge: { resolve(): void; reject(error: Error): void } | undefined
    owner.stdin.on('error', () => { acknowledge?.reject(new Error('connection_store_locked')); acknowledge = undefined })
    let acquired!: () => void
    const locked = new Promise<void>((resolve) => { acquired = resolve })
    createInterface({ input: owner.stdout }).on('line', (line) => {
      if (line === 'locked') acquired()
      else if (line === 'written') { acknowledge?.resolve(); acknowledge = undefined }
      else { acknowledge?.reject(new Error('connection_store_locked')); acknowledge = undefined }
    })
    const exited = new Promise<void>((resolve, reject) => {
      owner.once('error', () => { acknowledge?.reject(new Error('connection_store_locked')); reject(new Error('connection_store_locked')) })
      owner.once('exit', (code) => {
        acknowledge?.reject(new Error('connection_store_locked')); acknowledge = undefined
        if (code === 0) resolve()
        else reject(new Error('connection_store_locked'))
      })
    })
    void exited.catch(() => {})
    try {
      await Promise.race([locked, exited.then(() => { throw new Error('connection_store_locked') })])
      const write = (row: Row) => new Promise<void>((resolve, reject) => {
        if (owner.exitCode !== null || owner.killed || owner.stdin.destroyed) { reject(new Error('connection_store_locked')); return }
        acknowledge = { resolve, reject }
        owner.stdin.write(JSON.stringify(JSON.stringify(row)) + '\n', (error) => { if (error) { acknowledge?.reject(new Error('connection_store_locked')); acknowledge = undefined } })
      })
      const result = await run(write)
      if (owner.exitCode !== null) throw new Error('connection_store_locked')
      return result
    } finally { owner.stdin.end(); await exited }
  }
}
