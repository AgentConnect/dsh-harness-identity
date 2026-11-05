/** The lock worker pipe may report EPIPE through both its callback and its error event. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ failWrites: false, observedErrorListener: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (_command: string, args: string[]) => {
    const owner = Object.assign(new EventEmitter(), { exitCode: null as number | null, killed: false,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: undefined as unknown as Writable })
    const exit = (code: number) => { if (owner.exitCode !== null) return; owner.exitCode = code; owner.emit('exit', code) }
    owner.stdin = new Writable({ write(chunk, _encoding, callback) {
      if (state.failWrites) {
        state.observedErrorListener = owner.stdin.listenerCount('error') > 0
        callback(Object.assign(new Error('fixture broken pipe'), { code: 'EPIPE' }))
        return
      }
      const content = JSON.parse(String(chunk).trim()) as string
      void writeFile(args[7]!, content, { mode: 0o600 }).then(() => { owner.stdout.write('written\n'); callback() }, callback)
    } })
    owner.stdin.on('finish', () => exit(0)); owner.stdin.on('close', () => exit(state.failWrites ? 1 : 0))
    queueMicrotask(() => owner.stdout.write('locked\n'))
    return owner
  } }
})
import { MachineConnectionStore } from '../src/machine-store.ts'

it('contains a broken worker stdin without an unhandled Host error or credential write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-store-pipe-'))
  try {
    const store = new MachineConnectionStore(root, 'pipe', async () => Buffer.alloc(32, 19))
    const generation = await store.open('partition')
    state.failWrites = true
    await expect(store.commit(generation, { token: 'must-not-be-written', partition: 'partition', acquiredAt: Date.now(), expiresAt: Date.now() + 60000, scopes: ['read'] })).rejects.toThrow('connection_store_locked')
    expect(state.observedErrorListener).toBe(true)
    const file = (await readdir(root)).find(name => name.endsWith('.json'))!
    expect(await readFile(join(root, file), 'utf8')).not.toContain('must-not-be-written')
    expect((JSON.parse(await readFile(join(root, file), 'utf8')) as { generation: number }).generation).toBe(generation)
  } finally { await rm(root, { recursive: true, force: true }) }
})
