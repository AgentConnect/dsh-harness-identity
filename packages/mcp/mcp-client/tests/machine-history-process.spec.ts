/** Two real source-mode Node Hosts reuse one protected encrypted connection state. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

it.skipIf(process.platform !== 'linux')('restores still-valid historical bearer protection after the first Host process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-history-process-'))
  const harness = fileURLToPath(new URL('../../../../', import.meta.url))
  try {
    await writeFile(join(root, 'host-credential.json'), JSON.stringify({ key: randomBytes(32).toString('base64url') }), { mode: 0o600 })
    await writeFile(join(root, 'external-fixture.json'), JSON.stringify({ issued: [], observed: [] }), { mode: 0o600 })
    const records: Array<{
      pid: number
      oldStillValid: boolean
      oldInModelText: boolean
      oldInCanonicalStructuredValue: boolean
      issued: number
    }> = []
    for (const phase of [1, 2]) {
      const child = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(new URL('./fixtures/machine-history-restart.ts', import.meta.url)), String(phase), root], {
        cwd: harness, env: { ...scrubbedParentEnv(), NODE_ENV: 'test', TSX_TSCONFIG_PATH: join(harness, 'tsconfig.base.json') },
        encoding: 'utf8', timeout: 30000, maxBuffer: 1048576,
      })
      // Child diagnostics must never print fixture credentials in a failed test report.
      expect(child.status === 0).toBe(true)
      records.push(JSON.parse(child.stdout))
    }
    expect(records[0]!.pid !== records[1]!.pid).toBe(true)
    expect(records[0]).toMatchObject({ issued: 2, oldStillValid: true, oldInModelText: false, oldInCanonicalStructuredValue: false })
    expect(records[1]).toMatchObject({ issued: 3, oldStillValid: true, oldInModelText: false, oldInCanonicalStructuredValue: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})
