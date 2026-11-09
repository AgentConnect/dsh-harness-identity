/** Exact consent is exercised through real tool execution; only owner decisions and HTTPS are fixtures. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { McpDomainConsent } from '../src/domain-consent.ts'
import type { McpToolCallGate } from '../src/tools.ts'
import type { machineFetch } from '../src/machine-http.ts'

type GateInput = Parameters<McpToolCallGate>[0]
type ConsentOptions = ConstructorParameters<typeof McpDomainConsent>[0]
type ConsentClient = ConsentOptions['consent']
type Decision = Awaited<ReturnType<ConsentClient['request']>>
const resource = 'https://resource.example/mcp'
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function tool(name = 'write', annotations?: GateInput['tool']['annotations']): GateInput['tool'] {
  return { name, ...(annotations === undefined ? {} : { annotations }) }
}

async function fixture(options: { waitMs?: number; holdSend?: boolean; sendError?: Error } = {}) {
  const ctx = new Context(); roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  let decision: Decision = { id: 'approval-request', status: 'pending', version: 1 }
  let requestCount = 0, executeCount = 0, cancelCount = 0, revoked = false
  let requested!: () => void
  const requestStarted = new Promise<void>((resolve) => { requested = resolve })
  let releaseSend!: () => void
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
  let enteredSend!: () => void
  const sendStarted = new Promise<void>((resolve) => { enteredSend = resolve })
  const approvedRequests: Request[] = []
  const physical: Request[] = []
  const assertActive = async () => { if (revoked) throw new Error('owner_revoked') }
  const consent: ConsentClient = {
    async request(input) { requestCount++; approvedRequests.push(input.request.clone()); requested(); return { ...decision } },
    async status() { return { ...decision } },
    async cancel() { cancelCount++; decision = { ...decision, status: 'cancelled', version: decision.version + 1 }; return { ...decision } },
    async execute<T>(_grantId: string, _request: Request, effect: (check: () => Promise<void>) => Promise<T>): Promise<T> {
      executeCount++
      await assertActive()
      return effect(assertActive)
    },
  }
  const send: typeof machineFetch = async (input, init = {}, beforeSend?: () => Promise<void>) => {
    enteredSend()
    if (options.holdSend) await sendGate
    await beforeSend?.()
    physical.push(new Request(input, init))
    if (options.sendError) throw options.sendError
    return Response.json({ jsonrpc: '2.0', id: 'wire-call', result: { content: [{ type: 'text', text: 'ok' }] } })
  }
  const guard = new McpDomainConsent({ resource, issuer: 'https://issuer.example', scopes: ['protocol.read'],
    approvalWaitMs: options.waitMs ?? 1000, approvalPollMs: 10, signal: lifetime.signal, consent, assertActive, send })
  let serial = 0
  const wire = (raw: string, args: Record<string, unknown>) => new Request(resource, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'wire-call', method: 'tools/call', params: { name: raw, arguments: args } }) })
  const run = (definition: GateInput['tool'], args: Record<string, unknown> = { message: 'approved' },
    control: {
      signal?: AbortSignal
      mutate?: Record<string, unknown>
      twice?: boolean
      rpc?: { method: string; params: Record<string, unknown> }
    } = {}) => {
    const name = `fixture_mcp_${serial++}`
    ctx.tools.register({ name, description: 'Consent executor fixture', parameters: { type: 'object', additionalProperties: true },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (supplied, execution) => guard.callGate({ tool: definition, args: supplied as Record<string, unknown>, execution,
        invoke: async () => {
          const outgoing = control.rpc === undefined ? wire(definition.name, control.mutate ?? args)
            : new Request(resource, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'wire-call', ...control.rpc }) })
          await guard.fetch(outgoing)
          if (control.twice) await guard.fetch(wire(definition.name, control.mutate ?? args))
          return { content: [{ type: 'text', text: 'ok' }] }
        } }),
    })
    return executeToolFixture(ctx, {
      name, arguments: args, callId: ToolCallId(name), signal: control.signal ?? new AbortController().signal,
    })
  }
  return { guard, run, wire, physical, approvedRequests, requestStarted, sendStarted, releaseSend,
    approve(mode: 'once' | 'permanent' = 'once') { decision = { ...decision, status: 'approved', version: decision.version + 1, grantId: 'approved-grant', mode } },
    deny() { decision = { ...decision, status: 'denied', version: decision.version + 1 } },
    revoke() { revoked = true }, abort() { lifetime.abort() }, counts: () => ({ requestCount, executeCount, cancelCount }) }
}

it('automatically invokes only affirmative non-destructive reads', async () => {
  const f = await fixture()
  const result = await f.run(tool('annotated_read', { readOnlyHint: true, destructiveHint: false }))
  expect(result.isError).toBe(false)
  expect(f.counts()).toMatchObject({ requestCount: 0, executeCount: 0 })
  expect(f.physical).toHaveLength(1)
})

it.each([
  ['missing hints', tool('unknown')],
  ['write hint', tool('write', { readOnlyHint: false, destructiveHint: true })],
  ['conflicting hints', tool('conflicting', { readOnlyHint: true, destructiveHint: true })],
] as const)('waits for exact owner approval for %s before a business send', async (_name, definition) => {
  const f = await fixture()
  const result = f.run(definition, { amount: 3, currency: 'USD' })
  await f.requestStarted
  expect(f.physical).toEqual([])
  expect(f.counts().executeCount).toBe(0)
  const logical = f.approvedRequests[0]!
  expect(logical.url).toBe(resource)
  expect(await logical.json()).toEqual({ protocol: 'mcp', resource, issuer: 'https://issuer.example', tool: { name: definition.name, arguments: { amount: 3, currency: 'USD' } }, scopes: ['protocol.read'] })
  f.approve()
  expect((await result).isError).toBe(false)
  expect(f.counts().executeCount).toBe(1)
  expect(f.physical).toHaveLength(1)
})

it('denial, timeout and a forged permanent grant never reach the wire', async () => {
  const denied = await fixture(); const pending = denied.run(tool())
  await denied.requestStarted; denied.deny()
  expect((await pending).isError).toBe(true); expect(denied.physical).toEqual([])
  const timedOut = await fixture({ waitMs: 0 })
  expect((await timedOut.run(tool())).isError).toBe(true); expect(timedOut.physical).toEqual([])
  const permanent = await fixture(); const invalid = permanent.run(tool())
  await permanent.requestStarted; permanent.approve('permanent')
  expect((await invalid).isError).toBe(true); expect(permanent.physical).toEqual([])
})

it('cancels a pending request and cannot send after a late approval', async () => {
  for (const unload of [false, true]) {
    const f = await fixture(); const caller = new AbortController()
    const pending = f.run(tool(), {}, { signal: caller.signal })
    await f.requestStarted
    if (unload) f.abort(); else caller.abort()
    expect((await pending).isError).toBe(true)
    await vi.waitFor(() => expect(f.counts().cancelCount).toBe(1))
    f.approve(); expect(f.physical).toEqual([])
  }
})

it('rejects out-of-context sends, changed arguments and a duplicate physical call', async () => {
  const outside = await fixture()
  await expect(outside.guard.fetch(outside.wire('write', {}))).rejects.toThrow()
  expect(outside.physical).toEqual([])
  const tampered = await fixture(); const pending = tampered.run(tool(), { amount: 3 }, { mutate: { amount: 300 } })
  await tampered.requestStarted; tampered.approve()
  expect((await pending).isError).toBe(true); expect(tampered.physical).toEqual([])
  const replayed = await fixture(); const replay = replayed.run(tool(), {}, { twice: true })
  await replayed.requestStarted; replayed.approve()
  expect((await replay).isError).toBe(true); expect(replayed.physical).toHaveLength(1)
})

it('rechecks owner authorization after an asynchronous network preparation before the physical send', async () => {
  const f = await fixture({ holdSend: true }); const pending = f.run(tool())
  await f.requestStarted; f.approve(); await f.sendStarted
  f.revoke(); f.releaseSend()
  expect((await pending).isError).toBe(true)
  expect(f.physical).toEqual([])
})

it('cannot use a metadata-only consent execution for a business call or an unapproved RPC method', async () => {
  const f = await fixture()
  await expect(f.guard.withWireCall('__mcp_tools_list__', {}, new AbortController().signal, true, async () => {},
    async () => f.guard.fetch(f.wire('write', {})))).rejects.toThrow()
  expect(f.physical).toEqual([])
  const forbidden = new Request(resource, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'not-allowed', method: 'admin/reset', params: {} }) })
  await expect(f.guard.fetch(forbidden)).rejects.toThrow()
  const batch = new Request(resource, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 'batch', method: 'tools/call', params: { name: 'write', arguments: {} } }]) })
  await expect(f.guard.fetch(batch)).rejects.toThrow()
  expect(f.physical).toEqual([])
})

it('preserves a read transport failure rather than labeling it an unknown write result', async () => {
  const f = await fixture({ sendError: new Error('fixture_read_transport_failure') })
  const result = await f.run(tool('annotated_read', { readOnlyHint: true, destructiveHint: false }))
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('fixture_read_transport_failure')
  expect(JSON.stringify(result.content)).not.toContain('operation_result_unknown')
  expect(f.counts().requestCount).toBe(0)
  expect(f.physical).toHaveLength(1)
})

it('does not convert tool-discovery or business consent into unrelated resource-read access', async () => {
  const metadata = await fixture()
  const readResource = () => new Request(resource, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'resource-read', method: 'resources/read', params: { uri: 'private://account' } }) })
  await expect(metadata.guard.withWireCall('__mcp_tools_list__', {}, new AbortController().signal, true, async () => {},
    async () => metadata.guard.fetch(readResource()))).rejects.toThrow()
  expect(metadata.physical).toEqual([])
  const business = await fixture()
  const pending = business.run(tool(), {}, { rpc: { method: 'resources/read', params: { uri: 'private://account' } } })
  await business.requestStarted; business.approve()
  expect((await pending).isError).toBe(true)
  expect(business.physical).toEqual([])
  // The persistent read-scoped resource API remains separate from a per-operation permit.
  await metadata.guard.fetch(readResource())
  expect(metadata.physical).toHaveLength(1)
})

it('binds the full business envelope except for generated RPC ids and session headers', async () => {
  const f=await fixture()
  for(const message of [
    { jsonrpc:'2.0',id:'extra-param',method:'tools/call',params:{ name:'write',arguments:{},_meta:{ approvalBypass:true } } },
    { jsonrpc:'2.0',id:'extra-envelope',method:'tools/call',params:{ name:'write',arguments:{} },extension:{ differentTarget:'unapproved' } },
  ]) {
    await expect(f.guard.withWireCall('write',{},new AbortController().signal,false,async()=>{},async()=>f.guard.fetch(new Request(resource,{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify(message) })))).rejects.toThrow('operation_mismatch')
  }
  expect(f.physical).toEqual([])
})
