/** Assembled keyless headless transcript over the shipping MCP plugin and SDK. @module */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, scrubRequestHeaders } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { packChunkRuns, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../mcp-machine.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/mcp-machine/driver.ts', import.meta.url))
const expected = fileURLToPath(new URL('./snapshots/mcp-machine/session.expected.jsonl', import.meta.url))

it('records machine-only MCP grants, an unreplayed rejection and credential reacquisition through the headless app', async () => {
  let session = ''
  const result = await runLoaderSmoke({
    label: 'machine MCP headless snapshot', tempDirPrefix: 'headless-mcp-machine-', binScript, libBinScript: binScript,
    configPath, binArgs: [configPath, 'Read the machine identity, observe one rejected call, then try a separate read.'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { NODE_ENV: 'test', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: '' },
    inspect: async (cwd) => {
      const files = (await readdir(join(cwd, '.sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'))
      expect(files).toHaveLength(1)
      const raw = await readFile(join(cwd, '.sessions', files[0]!), 'utf8')
      const header = JSON.parse(raw.split('\n')[0]!) as { id: string }
      const normalized = scrubRequestHeaders(normalizeSessionLog(raw, { sessionIds: [header.id], cwd }))
      const [first, ...events] = normalized.trimEnd().split('\n')
      session = [first, ...packChunkRuns(events.map(line => JSON.parse(line) as SessionEvent)).map(record => JSON.stringify(record)), ''].join('\n')
      if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, session)
      expect(session).toBe(await readFile(expected, 'utf8'))
    },
  })
  expect(result.stderr).toBe('')
  const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(records.at(-1)).toMatchObject({ type: 'machine_wire_summary', tokenExchanges: 2, assertions: 2, toolCalls: 3,
    custody: 'explicit-test-fixture', authorizationServer: 'external-wire-fixture' })
  const toolEvents = records.filter(row => row.type === 'session_event').map(row => row.event as { type: string; data: { message?: { content: Array<{ isError?: boolean }> } } }).filter(event => event.type === 'tool/result')
  expect(toolEvents).toHaveLength(3)
  expect(toolEvents.map(event => event.data.message?.content[0]?.isError)).toEqual([false, true, false])
  expect(records.findLast(row => row.type === 'result')).toMatchObject({ output: 'The machine identity is did:web:agent.example. The rejected call was not replayed; the next call acquired a new machine token.' })
  expect(session).toContain('resource_unauthorized_result_unknown')
  expect(session).toContain('did:web:agent.example')
  expect(result.stdout + session).not.toContain('private-machine-fixture-token')
  expect(result.stdout + session).not.toContain('client_assertion')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
