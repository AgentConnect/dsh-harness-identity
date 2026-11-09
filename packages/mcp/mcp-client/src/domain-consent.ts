/** Single-operation MCP consent and exact physical-call enforcement. @module */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { McpToolCallGate, McpConsentTool } from './tools.ts'
import type { machineFetch } from './machine-http.ts'
import type { MachineIdentityClient } from './machine-types.ts'
import type { ProtocolPolicyClient, ProtocolTarget, ProtocolAdmission } from './domain-policy.ts'

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
  executeAllowed<T>(request: Request,
    authorization: { target: ProtocolTarget; policyVersion: number; annotations?: unknown; metadataOnly: boolean },
    effect: (assertActive: () => Promise<void>, capabilities?: DomainConsentCapabilities) => Promise<T>): Promise<T>
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
  policy: ProtocolPolicyClient
  target: ProtocolTarget
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
  active: boolean
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
  private disposed = false
  constructor(private readonly options: McpDomainConsentOptions) {}
  /** Release this instance's discovery binding after its connection or one-shot lifetime ends. */
  dispose(): void { if (this.disposed) return; this.disposed = true; this.options.policy.forget(this.options.target) }

  private async admission(metadataOnly: boolean, annotations?: unknown): Promise<ProtocolAdmission> {
    if (this.disposed) throw new McpDomainConsentError('connection_disabled')
    const policy = this.options.policy, target = this.options.target
    const decisions = [await policy.evaluate(target, { url: this.options.resource, ...policy.classifyScopes(this.options.scopes) })]
    if (!metadataOnly) decisions.push(await policy.evaluate(target, { url: this.options.resource, ...policy.classifyMcp(annotations) }))
    const first = decisions[0]
    if (!first) throw new McpDomainConsentError('protocol_policy_unavailable')
    const version = first.version
    if (decisions.some(decision => decision.version !== version)) throw new McpDomainConsentError('protocol_policy_changed')
    const decision = decisions.some(value => value.decision === 'deny') ? 'deny' : decisions.some(value => value.decision === 'ask') ? 'ask' : 'allow'
    return { decision, version, assertActive: async () => {
      if (this.disposed) throw new McpDomainConsentError('connection_disabled')
      for (const current of decisions) await current.assertActive()
    } }
  }

  /** Only affirmative non-destructive read hints count as automatic read permission.
   * @param tool - Current advertised tool.
   * @returns Whether the current read-scoped connection may invoke it without another dialog.
   */
  automaticRead(tool: McpConsentTool): boolean {
    return this.options.policy.classifyMcp(tool.annotations).effect === 'read'
  }

  /** Invoke through the current SDK only after the exact owner policy admits it. */
  readonly callGate: McpToolCallGate = async (call) => {
    if (call.tool.name === '__mcp_tools_list__') throw new McpDomainConsentError('reserved_operation_name')
    const signal = AbortSignal.any([this.options.signal, call.execution.signal])
    const args = JSON.parse(JSON.stringify(call.args)) as Record<string, unknown>
    const automatic = this.automaticRead(call.tool)
    const invoke = async (assertConsent: () => Promise<void>) => this.withWireCall(
      call.tool.name, args, signal, false, assertConsent, () => call.invoke(), !automatic,
    )
    return this.approve(call.tool.name, args, signal, async assertConsent => invoke(assertConsent), call.tool.annotations)
  }

  /** Request one owner decision and consume it only inside the exact effect.
   * @param tool - Discovered tool name or the metadata-only marker.
   * @param args - Exact immutable logical arguments.
   * @param signal - Caller cancellation.
   * @param effect - No effect runs before the owner approves this request.
   * @param annotations - Current discovered semantic hints; omitted or conflicting hints cannot become automatic reads.
   * @returns The one effect's result; pending, denial and unknown outcomes never replay it.
   */
  async approve<T>(tool: string, args: Record<string, unknown>, signal: AbortSignal,
    effect: (assertActive: () => Promise<void>, capabilities?: DomainConsentCapabilities) => Promise<T>, annotations?: McpConsentTool['annotations']): Promise<T> {
    const combined = AbortSignal.any([this.options.signal, signal])
    await this.options.assertActive()
    combined.throwIfAborted()
    const request = mcpConsentRequest(this.options.resource, this.options.scopes, tool, args, this.options.issuer)
    const metadataOnly = tool === '__mcp_tools_list__'
    const policy = await this.admission(metadataOnly, annotations)
    if (policy.decision === 'deny') throw new McpDomainConsentError('protocol_permission_denied')
    const assertPolicy = async () => {
      combined.throwIfAborted()
      await this.options.assertActive()
      await policy.assertActive()
      await this.options.policy.assertNoDenial(request.clone())
      await policy.assertActive()
    }
    await assertPolicy()
    const run = async (assertConsent: () => Promise<void>, capabilities?: DomainConsentCapabilities) => {
      const check = async () => { await assertPolicy(); await assertConsent(); combined.throwIfAborted() }
      await check(); const result = await effect(check, capabilities); await check(); return result
    }
    if (policy.decision === 'allow') return this.options.consent.executeAllowed(request.clone(), {
      target: this.options.target, policyVersion: policy.version, metadataOnly, ...(annotations === undefined ? {} : { annotations }),
    }, run)
    let decision = await this.options.consent.request({ requestId: `mcp-once-${randomUUID()}`, purpose: `MCP ${tool}; exact operation approval; policy ${policy.version}`, request: request.clone() })
    const deadline = Date.now() + this.options.approvalWaitMs
    try {
      while (decision.status === 'pending' && Date.now() < deadline) {
        await wait(Math.min(this.options.approvalPollMs, Math.max(0, deadline - Date.now())), combined)
        await policy.assertActive()
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
    return this.options.consent.execute(decision.grantId, request.clone(), run)
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
      active: true,
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
      finally { current.active = false }
    })
  }

  /** Public pinned transport with a final exact-payload assertion after DNS/token/body awaits. */
  readonly fetch: typeof machineFetch = async (input, init, beforeSend) => {
    const request = new Request(input, init)
    const inherited = this.calls.getStore()
    const current = inherited?.active ? inherited : undefined
    let business = false
    if (request.url === new URL(this.options.resource).href && request.method === 'POST') {
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
      else {
        await this.options.assertActive()
        const permission = await this.admission(false, { readOnlyHint: true, destructiveHint: false })
        if (permission.decision !== 'allow') throw new McpDomainConsentError(permission.decision === 'deny' ? 'protocol_permission_denied' : 'identity_authorization_required')
        await permission.assertActive()
      }
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
