/** The same file store contract applies to native macOS, Linux and Windows Hosts. */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MachineConnectionStore } from '../src/machine-store.ts'

it('keeps credentials encrypted while serializing independent writers and preserving disablement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-file-store-'))
  const store = () => new MachineConnectionStore(root, 'file-demo', async () => Buffer.alloc(32, 73))
  try {
    const first = store(), second = store()
    const [generation, sameGeneration] = await Promise.all([first.open('partition'), second.open('partition')])
    expect(sameGeneration).toBe(generation)
    const token = { token: 'private-file-token', acquiredAt: Date.now(), expiresAt: Date.now() + 60000,
      partition: 'partition', scopes: ['agent.self.read'] }
    await first.commit(generation, token)
    expect(await second.token(generation, 'partition')).toMatchObject({ token: token.token })
    const file = (await readdir(root)).find(name => name.endsWith('.json'))!
    expect(await readFile(join(root, file), 'utf8')).not.toContain(token.token)
    await second.disable()
    await expect(first.commit(generation, token)).rejects.toThrow('connection_generation_changed')
    expect((await first.state())?.active).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
