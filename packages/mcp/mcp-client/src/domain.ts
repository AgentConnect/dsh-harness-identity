/** Domain discovery and managed MCP connections under one Host identity policy. @module */
import { createHash, randomUUID } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Config as ClientConfig } from './index.ts'
import { resolveReconnectPolicy } from './connection.ts'
import { ManagedConnection } from './managed-connection.ts'
import { McpStatusCell } from './status.ts'
import { machineFetch, directPublicMachineFetch, machineJson, machineUrl, assertMachineDirectRoute } from './machine-http.ts'
import { discoverMachineTarget } from './machine-discovery.ts'
import { registerServerContext } from './server-context.ts'
import { McpDomainConsent, type DomainOperationClient } from './domain-consent.ts'
import { DomainCredentialHistory, domainKeyReader } from './domain-history.ts'
import { runOneShotMcp, type DiscoveredMcpTool, type OneShotMcpTarget } from './domain-once.ts'
import type { MachineAuthentication, MachineTarget } from './machine-types.ts'
import type {} from '@deepseek-ai/dsh-tools'

/** Loader entry for the optional domain connector. */
export const name = 'mcp-domain'
/** One global opt-in; it does not configure a particular remote server. */
export const inject = ['tools', 'credentials']
/** Resource and connection limits for the domain connector. */
export interface Config {
  /** Must be explicitly enabled by the Host. */
  enabled: boolean
  /** Maximum live connections owned by this plugin instance. */
  maxConnections: number
  /** Explicit public-only direct egress, without per-domain NO_PROXY entries. */
  publicDirectHttps: boolean
  /** Maximum owner wait per exact operation. */
  approvalWaitMs: number
  /** Pending-decision polling interval. */
  approvalPollMs: number
  /** Maximum SDK connect/list/call budget for one-shot operations. */
  oneShotTimeoutMs: number
  /** Maximum retained one-shot histories; reaching it fails closed. */
  maxOneShotRecords: number
  /** Bound on unexpired opaque operation references. */
  maxDiscoveredOperations: number
  /** Lifetime of an elevated discovered operation reference. */
  operationRefTtlMs: number
}
/** Validate Host configuration before registering tools. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false), publicDirectHttps: z.boolean().default(false),
  maxConnections: z.number().step(1).min(1).max(128).default(32),
  approvalWaitMs: z.number().step(1).min(0).max(600000).default(120000),
  approvalPollMs: z.number().step(1).min(10).max(10000).default(1000),
  oneShotTimeoutMs: z.number().step(1).min(1000).max(120000).default(60000),
  maxOneShotRecords: z.number().step(1).min(1).max(4096).default(512),
  maxDiscoveredOperations: z.number().step(1).min(1).max(4096).default(256),
  operationRefTtlMs: z.number().step(1).min(1000).max(3600000).default(300000),
})

interface Binding {
  identityRef: MachineAuthentication['identityRef']
  policyRef: string
  scopes: string[]
  stateRoot: string
}
interface DomainIdentity {
  resolveDomainAccess(context: Context, profile: 'mcp_machine'): Promise<Binding>
  bindDomainOperationConsumer(context: Context): DomainOperationClient
}
const failureCodes = new Set(['identity_plugin_required', 'domain_access_disabled', 'domain_access_expired', 'published_identity_required', 'default_identity_required',
  'scope_authorization_required', 'scope_selection_required', 'scope_change_requires_owner', 'invalid_domain', 'discovery_failed', 'incompatible_metadata',
  'incompatible_resource', 'issuer_selection_required', 'unsupported_machine_profile', 'unsafe_target', 'invalid_target',
  'proxy_egress_unsupported', 'network_failure', 'connection_limit', 'connection_disabled', 'credential_store_unavailable',
  'identity_authorization_required','identity_authorization_denied','once_authorization_required','operation_cancelled','operation_result_unknown',
  'scope_authorization_unavailable','discovered_operation_changed','domain_history_unavailable','domain_history_limit','one_shot_cleanup_unconfirmed','operation_reference_expired','unknown_operation','remote_tool_error','reserved_operation_name'])

/** Closed domain-connection failure; untrusted text is never returned to the model. */
export class DomainConnectionError extends Error {
  /** @param code - Stable failure discriminant. */
  constructor(readonly code: string) { super(code) }
}

/** Build a canonical public HTTPS discovery origin from a domain, never a supplied URL.
 * @param domain - Hostname with optional port.
 * @returns HTTPS origin with no path or credentials.
 */
export function domainOrigin(domain: string): string {
  if (!domain || domain.length > 253 || /[/?#@\\\s]/u.test(domain)) throw new DomainConnectionError('invalid_domain')
  let url: URL
  try { url = new URL(`https://${domain}`) } catch { throw new DomainConnectionError('invalid_domain') }
  if (url.pathname !== '/' || url.username || url.password) throw new DomainConnectionError('invalid_domain')
  return url.origin
}

/** Discover and verify the real endpoint before any identity assertion is available.
 * @param domain - User-provided hostname.
 * @param ceiling - Host-approved OAuth scopes, not remote metadata permissions.
 * @param requested - Optional exact scopes selected for the current task.
 * @param send - Pinned HTTPS public transport.
 * @param allowExtraScopes - Permit advertised extra scopes for metadata-only owner approval, never persistent read access.
 * @returns Validated endpoint and minimum permitted scopes.
 */
export async function discoverDomain(
  domain: string, ceiling: readonly string[], requested?: string[], send = machineFetch, allowExtraScopes = false,
): Promise<{ target: MachineTarget; scopes: string[]; advertisedScopes: string[] }> {
  const source = `${domainOrigin(domain)}/.well-known/oauth-protected-resource`
  const response = await send(source, { redirect: 'manual', headers: { accept: 'application/json' } })
  if (response.status !== 200) { await response.body?.cancel(); throw new DomainConnectionError('discovery_failed') }
  const metadata = await machineJson(response)
  if (typeof metadata.resource !== 'string') throw new DomainConnectionError('incompatible_metadata')
  machineUrl(metadata.resource)
  const advertised = metadata.scopes_supported
  if (!Array.isArray(advertised) || advertised.length > 64 || !advertised.every(scope => typeof scope === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/u.test(scope))) throw new DomainConnectionError('scope_selection_required')
  const scopes = [...new Set(requested ?? ceiling.filter(scope => advertised.includes(scope)))].sort()
  if (!scopes.length || scopes.some(scope => !allowExtraScopes && !ceiling.includes(scope) || !advertised.includes(scope))) throw new DomainConnectionError('scope_authorization_required')
  const target = await discoverMachineTarget(metadata.resource, undefined, send)
  return { target, scopes, advertisedScopes: advertised }
}

type DomainOperationRef = Branded<'McpDomainOperationRef'>
interface DiscoveredOperation { binding: Binding; target: OneShotMcpTarget; tool: DiscoveredMcpTool; expiresAt: number }

/** Register a domain tool that reuses the normal authenticated SDK supervisor and encrypted store.
 * @param ctx - Loader-owned connector Context.
 * @param config - Explicit Host opt-in and live-connection budget.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const credentials = ctx.get('credentials')
  if (!credentials) throw new DomainConnectionError('credential_store_unavailable')
  const lane = config.publicDirectHttps ? { fetch: directPublicMachineFetch, assertRoute: (url: string) => { machineUrl(url) } } : undefined
  const fetchPublic = lane?.fetch ?? machineFetch
  const controller = new AbortController()
  const histories = new Map<string,DomainCredentialHistory>()
  const operations = new Map<DomainOperationRef,DiscoveredOperation>()
  const connections = new Map<string, { connection: ManagedConnection; serverName: string; policyRef: string; scopes: string[] }>()
  let chain: Promise<unknown> = Promise.resolve()
  ctx.effect(() => async () => {
    controller.abort()
    // Close startup transports before waiting for the admission queue.
    await Promise.all([...connections.values()].map(value => value.connection.dispose()))
    await chain.catch(() => undefined)
    connections.clear()
    operations.clear()
  }, 'mcp-domain.connections')
  const historyFor = (binding: Binding) => {
    let history = histories.get(binding.stateRoot)
    if (!history) {
      history = new DomainCredentialHistory(credentials,binding.stateRoot,config.maxOneShotRecords)
      histories.set(binding.stateRoot,history)
    }
    return history
  }
  const assertBinding = async (identity: DomainIdentity, binding: Binding, signal: AbortSignal) => {
    signal.throwIfAborted()
    const current = await identity.resolveDomainAccess(ctx,'mcp_machine')
    if (current.policyRef !== binding.policyRef || JSON.stringify(current.identityRef) !== JSON.stringify(binding.identityRef) || current.stateRoot !== binding.stateRoot) throw new DomainConnectionError('connection_disabled')
    await historyFor(binding).restore()
    signal.throwIfAborted()
  }
  const consentFor = (
    identity: DomainIdentity,binding: Binding,target: OneShotMcpTarget,signal: AbortSignal, assertConnection?:()=>Promise<void>,
  ) => {
    if (typeof identity.bindDomainOperationConsumer !== 'function') throw new DomainConnectionError('scope_authorization_unavailable')
    return new McpDomainConsent({ resource:target.target.resource,issuer:target.target.issuer,scopes:target.scopes,
      approvalWaitMs:config.approvalWaitMs,approvalPollMs:config.approvalPollMs,signal,consent:identity.bindDomainOperationConsumer(ctx),
      assertActive:async()=>{await assertBinding(identity,binding,signal);await assertConnection?.()},send:fetchPublic })
  }
  ctx.effect(() => ctx.tools.register({
    name: 'mcp_connect',
    timeoutMs: config.approvalWaitMs + 3 * config.oneShotTimeoutMs + 30000,
    description: 'Connect MCP from a domain: discover the actual endpoint and authentication metadata, use the Host default public identity and permitted scopes, then register its mcp__ tools. No per-domain configuration or pasted tokens. Missing global permission or default identity needs one owner decision, not a manually configured server. Read scopes create/reuse a persistent read connection. Additional advertised scopes trigger a metadata-only owner dialog, return opaque operationRefs, and never widen that connection; use mcp_call_once for an exact discovered operation. Request only scopes necessary for the user task.',
    parameters: { type: 'object', properties: { domain: { type: 'string', minLength: 1, maxLength: 253 }, scopes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, maxItems: 64 } }, required: ['domain'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: { domain: string; scopes?: string[] }, execution) => {
      const run = chain.then(async () => {
        if (!execution.agent || execution.signal.aborted || controller.signal.aborted) throw new DomainConnectionError('connection_disabled')
        const identity = ctx.get('anpIdentity') as DomainIdentity | undefined
        if (!identity) throw new DomainConnectionError('identity_plugin_required')
        const binding = await identity.resolveDomainAccess(ctx, 'mcp_machine')
        const signal = AbortSignal.any([execution.signal, controller.signal])
        const send: typeof machineFetch = (url, init = {}) => fetchPublic(url, {
          ...init, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
        })
        const discovered = await discoverDomain(args.domain, binding.scopes, args.scopes, send, true)
        signal.throwIfAborted()
        const history=historyFor(binding);await history.restore()
        const target:OneShotMcpTarget={ identityRef:binding.identityRef,policyRef:binding.policyRef,
          stateRoot:binding.stateRoot,target:discovered.target,scopes:discovered.scopes }
        if (discovered.scopes.some(scope=>!binding.scopes.includes(scope))) {
          const consent=consentFor(identity,binding,target,signal)
          const listed=await consent.approve('__mcp_tools_list__',{},signal,(assertActive,capabilities)=>runOneShotMcp(ctx,{ target,args:{},consent,history,signal,assertActive,capabilities,
            assertRoute:lane?.assertRoute??assertMachineDirectRoute,callTimeoutMs:config.oneShotTimeoutMs }))
          if(listed.kind!=='tools'||listed.tools.some(tool=>tool.name==='__mcp_tools_list__'))throw new DomainConnectionError('discovery_failed')
          for(const [reference,operation] of operations)if(operation.expiresAt<=Date.now())operations.delete(reference)
          if(operations.size+listed.tools.length>config.maxDiscoveredOperations)throw new DomainConnectionError('connection_limit')
          const publicOperations=listed.tools.map((tool)=>{
            const reference=brandString<DomainOperationRef>(`mcp-op-${randomUUID()}`)
            operations.set(reference,{ binding,target,tool,expiresAt:Date.now()+config.operationRefTtlMs })
            return { operationRef:reference,name:tool.name,description:tool.description??'',inputSchema:tool.inputSchema,authorization:'once-required' }
          })
          return { ok:true,mode:'one-shot-discovery',resource:discovered.target.resource,scopes:discovered.scopes,operations:publicOperations,persistentConnectionWidened:false,credentialRevocation:listed.credentialRevocation }
        }
        const id = createHash('sha256').update(JSON.stringify([binding.identityRef, discovered.target.resource, binding.stateRoot])).digest('hex')
        let owned = connections.get(id)
        if (owned && owned.policyRef !== binding.policyRef) throw new DomainConnectionError('connection_disabled')
        if (owned && JSON.stringify(owned.scopes) !== JSON.stringify(discovered.scopes)) throw new DomainConnectionError('scope_change_requires_owner')
        if (!owned) {
          if (connections.size >= config.maxConnections) throw new DomainConnectionError('connection_limit')
          const connectionId = `domain-${id}`
          const readKey = await domainKeyReader(credentials, binding.stateRoot, connectionId)
          signal.throwIfAborted()
          const serverName = `domain_${id.slice(0, 24)}`
          const resolved = ClientConfig({ transport: 'streamable-http', serverName, url: discovered.target.resource,
            authentication: { mode: 'cimd-client-credentials', connectionId, identityRef: binding.identityRef,
              policyRef: binding.policyRef, requestedScopes: discovered.scopes, issuer: discovered.target.issuer,
              stateRoot: binding.stateRoot, encryptionKeyRef: 'MCP_DOMAIN_HOST_KEY' }, startupTimeoutMs: 15000 })
          if (resolved.transport !== 'streamable-http' || !resolved.authentication || resolved.authentication.mode !== 'cimd-client-credentials') throw new DomainConnectionError('connection_disabled')
          const status = new McpStatusCell(() => ctx.logger.warn('mcp_domain_observer_failed'))
          const consent=consentFor(identity,binding,target,controller.signal,async()=>{
            const current=await connection.status();if(current.state==='disconnected'||current.state==='blocked')throw new DomainConnectionError('connection_disabled')
          })
          const network={ fetch:consent.fetch,assertRoute:lane?.assertRoute??assertMachineDirectRoute }
          const connection = new ManagedConnection(ctx, { ...resolved, authentication: resolved.authentication }, resolveReconnectPolicy(resolved.reconnect, 'mcp-domain'), status, readKey, network,
            { callGate:consent.callGate,timeoutMs:config.approvalWaitMs+resolved.toolCallTimeoutMs+30000,
              redactor:history.redactor,assertHistory:()=>history.restore() })
          owned = { connection, serverName, policyRef: binding.policyRef, scopes: discovered.scopes }
          connections.set(id, owned)
          registerServerContext(ctx, serverName, connection)
          await connection.start()
        }
        signal.throwIfAborted()
        const status = await owned.connection.status()
        return { ok: status.state === 'ready', resource: discovered.target.resource, serverName: owned.serverName, availableScopes: discovered.advertisedScopes, readScopes: owned.scopes, ...status,
          ...(status.state === 'ready' ? {} : { error: status.state === 'disconnected' ? 'connection_disabled' : 'connection_not_ready' }) }
      })
      chain = run.catch(() => undefined)
      try { return await run }
      catch (error) {
        const raw = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        return { ok: false, error: typeof raw === 'string' && failureCodes.has(raw) ? raw : 'connection_failed' }
      }
    },
  }), 'mcp-domain.tool')
  ctx.effect(()=>ctx.tools.register({
    name:'mcp_call_once',timeoutMs:config.approvalWaitMs+3*config.oneShotTimeoutMs+30000,
    description:'Invoke an opaque operationRef returned by mcp_connect after advertised extra-scope discovery. A new owner dialog binds the exact service, raw tool, arguments and scopes; only one call executes. Does not enable permanent write access or widen a read connection. Denial/cancel never sends; unknown writes must not be retried.',
    parameters:{ type:'object',properties:{ operationRef:{ type:'string',minLength:1,maxLength:256 },arguments:{ type:'object',additionalProperties:true } },required:['operationRef','arguments'],additionalProperties:false },
    output:{ schema:{ type:'object',additionalProperties:true },render:(_args,value)=>[{ type:'text',text:JSON.stringify(value) }] },
    execute:async(args:{ operationRef:string;arguments:Record<string,unknown> },execution)=>{
      try{
        const signal=AbortSignal.any([controller.signal,execution.signal]);if(!execution.agent)throw new DomainConnectionError('connection_disabled')
        const reference=brandString<DomainOperationRef>(args.operationRef),operation=operations.get(reference)
        if(!operation)throw new DomainConnectionError('unknown_operation')
        if(operation.expiresAt<=Date.now())throw new DomainConnectionError('operation_reference_expired')
        const identity=ctx.get('anpIdentity') as DomainIdentity|undefined;if(!identity)throw new DomainConnectionError('identity_plugin_required')
        await assertBinding(identity,operation.binding,signal)
        const history=historyFor(operation.binding),consent=consentFor(identity,operation.binding,operation.target,signal)
        const frozen=JSON.parse(JSON.stringify(args.arguments)) as Record<string,unknown>
        const value=await consent.approve(operation.tool.name,frozen,signal,(assertActive,capabilities)=>runOneShotMcp(ctx,{
          target:operation.target,tool:operation.tool,args:frozen,consent,history,signal,assertActive,capabilities,
          assertRoute:lane?.assertRoute??assertMachineDirectRoute,callTimeoutMs:config.oneShotTimeoutMs }))
        if(value.kind!=='result')throw new DomainConnectionError('unknown_operation')
        return { ok:value.result.isError!==true,...(value.result.isError===true?{ error:'remote_tool_error',mayHaveExecuted:true }:{}),result:value.result,credentialRevocation:value.credentialRevocation }
      }catch(error){const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;return { ok:false,error:typeof code==='string'&&failureCodes.has(code)?code:'operation_failed' }}
    },
  }),'mcp-domain.once-tool')

}
