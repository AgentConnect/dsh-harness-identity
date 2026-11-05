/** Recorded-session secrecy and machine tool semantics; the shared headless owner runs the profile. @module */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { assertSessionFixtureVersion, redactSessionSnapshotIds, scrubSystemPrompts, scrubToolSchemas } from '@deepseek-ai/dsh-session-snapshot'

it('mcp-machine retains public tool outcomes without credentials or alternate application entrypoints', async () => {
  const path = fileURLToPath(new URL('./mcp-machine/session.v3.jsonl', import.meta.url))
  const source = await readFile(path, 'utf8')
  assertSessionFixtureVersion('session.v3.jsonl', source)
  expect(redactSessionSnapshotIds([source])).toEqual([source])
  expect(scrubSystemPrompts(source)).toBe(source)
  expect(scrubToolSchemas(source)).toBe(source)
  for (const secret of ['private-machine-fixture-token', 'client_assertion', 'BEGIN PRIVATE KEY', 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM']) expect(source).not.toContain(secret)
  const records = source.trim().split('\n').map(line => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
  const calls = records.filter(row => row.type === 'tool/call')
  expect(calls.map(row => row.data?.name)).toEqual(Array(3).fill('mcp__machine__identity_get'))
  const outcomes = records.filter(row => row.type === 'tool/result').map(row => row.data?.message as { content: Array<{ isError: boolean }> })
  expect(outcomes.map(row => row.content[0]?.isError)).toEqual([false, true, false])
  expect(source).toContain('resource_unauthorized_result_unknown')
})
