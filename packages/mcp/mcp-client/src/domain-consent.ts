/** Single-operation MCP consent and exact physical-call enforcement. @module */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { McpToolCallGate, McpConsentTool } from './tools.ts'
import type { machineFetch } from './machine-http.ts'
import type { MachineIdentityClient } from './machine-types.ts'

/** Safe request state from the shared identity owner. */
export interface DomainConsentDecision {
  id: string
  status: string
  version: number
  grantId?: string
  mode?: string
}
/** Capabilities exist only inside one admitted owner-approved execution. */
export interface DomainConsentCapabilities { machineIdentity?: MachineIdentityClient }
/** Context-bound owner confirmation; consumers cannot approve or widen permission. */
export interface DomainOperationClient {
  request(input: { requestId: string; purpose: string; request: Request }): Promise<DomainConsentDecision>
  status(id: string): Promise<DomainConsentDecision>
  cancel(id: string, version: number): Promise<DomainConsentDecision>
  execute<T>(
    grantId: string, request: Request,
    effect: (assertActive: () => Promise<void>, capabilities?: DomainConsentCapabilities) => Promise<T>,
  ): Promise<T>
}
/** Stable refusal; no request body, credentials, or remote error text is included. */
export class McpDomainConsentError extends Error {
  /** @param code - Stable refusal or unknown-result code. */
  constructor(readonly code: string) { super(code) }
}
/** Configured authority and lifecycle for one resource. */
export interface McpDomainConsentOptions {
  resource: string
  issuer?: string
  scopes: string[]
  approvalWaitMs: number
  approvalPollMs: number
  signal: AbortSignal
  consent: DomainOperationClient
  assertActive(): Promise<void>
  send: typeof machineFetch
}
interface WireCall {
  tool: string
  args: Record<string, unknown>
  assertActive(): Promise<void>
  signal: AbortSignal
  metadataOnly: boolean
  sensitive: boolean
  sent: number
}
const PROTOCOL_METHODS = new Set(['initialize','server/discover','notifications/initialized','tools/list','ping','notifications/cancelled'])
const METADATA_METHODS = new Set(['initialize', 'server/discover', 'notifications/initialized', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read', 'ping', 'notifications/cancelled'])

/** Logical consent excludes only transport-generated JSON-RPC ids and session headers.
 * @param resource - Exact discovered resource.
 * @param scopes - Exact scopes used for this invocation.
 * @param tool - Exact advertised raw tool name; the reserved marker is metadata-only.
 * @param args - Immutable model-provided arguments.
 * @param issuer - Optional validated issuer pin.
 * @returns Credential-free request hashed by the Host authorization ledger.
 */
export function mcpConsentRequest(
  resource: string, scopes: readonly string[], tool: string, args: Record<string, unknown>, issuer?: string,
): Request {
  return new Request(resource, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'mcp', resource, ...(issuer ? { issuer } : {}), tool: { name: tool, arguments: args }, scopes: [...scopes].sort() }) })
}

/** Owns consent waits and exact wire checks for one live connector resource. */
export class McpDomainConsent {
  private readonly calls = new AsyncLocalStorage<WireCall>()
  constructor(private readonly options: McpDomainConsentOptions) {}

  /** Only affirmative non-destructive read hints count as automatic read permission.
   * @param tool - Current advertised tool.
   * @returns Whether the current read-scoped connection may invoke it without another dialog.
   */
  automaticRead(tool: McpConsentTool): boolean {
    return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false
  }

  /** Invoke through the current SDK only after the exact owner policy admits it. */
  readonly callGate: McpToolCallGate = async (call) => {
    if (call.tool.name === '__mcp_tools_list__') throw new McpDomainConsentError('reserved_operation_name')
    const signal = AbortSignal.any([this.options.signal, call.execution.signal])
    const args = JSON.parse(JSON.stringify(call.args)) as Record<string, unknown>
    const automatic = this.automaticRead(call.tool)
    const invoke = async (assertConsent: () => Promise<void>) => this.withWireCall(
      call.tool.name, args, signal, false, assertConsent, call.invoke, !automatic,
    )
    if (automatic) return invoke(async () => {})
    return this.approve(call.tool.name, args, signal, async assertConsent => invoke(assertConsent))
  }

  /** Request one owner decision and consume it only inside the exact effect.
   * @param tool - Discovered tool name or the metadata-only marker.
   * @param args - Exact immutable logical arguments.
   * @param signal - Caller cancellation.
   * @param effect - No effect runs before the owner approves this request.
   * @returns The one effect's result; pending, denial and unknown outcomes never replay it.
   */
  async approve<T>(tool: string, args: Record<string, unknown>, signal: AbortSignal,
    effect: (assertActive: () => Promise<void>, capabilities?: DomainConsentCapabilities) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([this.options.signal, signal])
    await this.options.assertActive()
    combined.throwIfAborted()
    const request = mcpConsentRequest(this.options.resource, this.options.scopes, tool, args, this.options.issuer)
    let decision = await this.options.consent.request({ requestId: `mcp-once-${randomUUID()}`, purpose: `MCP ${tool}; exact operation approval`, request: request.clone() })
    const deadline = Date.now() + this.options.approvalWaitMs
    try {
      while (decision.status === 'pending' && Date.now() < deadline) {
        await wait(Math.min(this.options.approvalPollMs, Math.max(0, deadline - Date.now())), combined)
        decision = await this.options.consent.status(decision.id)
      }
      combined.throwIfAborted()
    } catch (error) {
      await this.options.consent.cancel(decision.id, decision.version).catch(() => undefined)
      throw error
    }
    if (decision.status === 'pending') throw new McpDomainConsentError('identity_authorization_required')
    if (decision.status !== 'approved' || !decision.grantId) throw new McpDomainConsentError('identity_authorization_denied')
    if (decision.mode !== 'once') throw new McpDomainConsentError('once_authorization_required')
    return this.options.consent.execute(decision.grantId, request.clone(), async (assertConsent, capabilities) => {
      const check = async () => {
        combined.throwIfAborted()
        await this.options.assertActive()
        await assertConsent()
        combined.throwIfAborted()
      }
      await check()
      const result = await effect(check, capabilities)
      await check()
      return result
    })
  }

  /** Run a one-shot SDK invocation under an already admitted consent execution.
   * @param tool - Exact approved raw tool or the reserved metadata marker.
   * @param args - Exact approved arguments.
   * @param signal - Caller lifecycle.
   * @param metadataOnly - Forbids every business tools/call even under elevated scopes.
   * @param assertConsent - Current Host grant assertion.
   * @param invoke - Actual SDK operation; not a model callback.
   * @param sensitive - Whether a sent request failure must be reported as an unknown write outcome.
   * @returns One SDK operation result without automatic business-call retry.
   */
  async withWireCall<T>(tool: string, args: Record<string, unknown>, signal: AbortSignal, metadataOnly: boolean,
    assertConsent: () => Promise<void>, invoke: () => Promise<T>, sensitive = true): Promise<T> {
    const current: WireCall = {
      tool, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown>, signal, metadataOnly, sensitive, sent: 0,
      assertActive: async () => {
        signal.throwIfAborted()
        await this.options.assertActive()
        await assertConsent()
        signal.throwIfAborted()
      },
    }
    await current.assertActive()
    return this.calls.run(current, async () => {
      try { const result = await invoke(); await current.assertActive(); return result }
      catch (error) {
        if (current.sent > 0 && current.sensitive) throw new McpDomainConsentError('operation_result_unknown')
        throw error
      }
    })
  }

  /** Public pinned transport with a final exact-payload assertion after DNS/token/body awaits. */
  readonly fetch: typeof machineFetch = async (input, init = {}, beforeSend) => {
    const request = new Request(input, init)
    const current = this.calls.getStore()
    let business = false
    if (request.url === this.options.resource && request.method === 'POST') {
      let message: unknown
      try { message = JSON.parse(await request.clone().text()) } catch { throw new McpDomainConsentError('unapproved_mcp_request') }
      if (!message || typeof message !== 'object' || Array.isArray(message) || !('method' in message) || typeof message.method !== 'string') throw new McpDomainConsentError('unapproved_mcp_request')
      if (message.method === 'tools/call') {
        business = true
        if (!current || current.metadataOnly || !('params' in message) || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) throw new McpDomainConsentError('unapproved_mcp_operation')
        const params = message.params
        if (Object.keys(message).some(key => !['jsonrpc','id','method','params'].includes(key))
          || Object.keys(params).some(key => !['name','arguments'].includes(key))
          || !('name' in params) || params.name !== current.tool || !('arguments' in params) || !isDeepStrictEqual(params.arguments, current.args)) throw new McpDomainConsentError('operation_mismatch')
      } else if (!(current ? PROTOCOL_METHODS : METADATA_METHODS).has(message.method)) throw new McpDomainConsentError('unapproved_mcp_request')
    }
    const check = async () => {
      await beforeSend?.()
      if (current) await current.assertActive()
      else await this.options.assertActive()
    }
    await check()
    return this.options.send(request, {}, async () => {
      await check()
      if (business) {
        if (!current || current.sent !== 0) throw new McpDomainConsentError('operation_already_sent')
        current.sent++
      }
    })
  }
}

/** Interruptible owner wait; no background task survives its calling operation. */
async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve() }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new McpDomainConsentError('operation_cancelled')) }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
