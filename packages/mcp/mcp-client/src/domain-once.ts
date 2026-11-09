/** One SDK lifetime under one exact scope/operation approval. @module */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type { MachineAuthentication, MachineTarget } from './machine-types.ts'
import { MachineAuthenticationSession } from './machine-auth.ts'
import type { DomainConsentCapabilities } from './domain-consent.ts'
import { McpDomainConsent, McpDomainConsentError } from './domain-consent.ts'
import { DomainCredentialHistory } from './domain-history.ts'

/** Current SDK tool declaration, sanitized before it can become an opaque operation. */
export type DiscoveredMcpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]
/** Immutable scope and target selected by discovery, not a model-provided URL. */
export interface OneShotMcpTarget {
  identityRef: MachineAuthentication['identityRef']
  policyRef: string
  stateRoot: string
  target: MachineTarget
  scopes: string[]
}
/** One-shot network and lifetime settings supplied by the connector Host. */
export interface OneShotMcpOptions {
  target: OneShotMcpTarget
  tool?: DiscoveredMcpTool
  args: Record<string, unknown>
  consent: McpDomainConsent
  capabilities?: DomainConsentCapabilities | undefined
  history: DomainCredentialHistory
  signal: AbortSignal
  assertActive(): Promise<void>
  assertRoute(url: string): void
  callTimeoutMs: number
}

type OneShotMcpOutcome =
  | { kind: 'tools'; tools: DiscoveredMcpTool[]; credentialRevocation: string }
  | { kind: 'result'; result: Awaited<ReturnType<Client['callTool']>>; credentialRevocation: string }

/** Acquire no token before approval, register no tools, and retain encrypted history after closure.
 * @param ctx - Installed domain-connector Context.
 * @param options - Current admitted once-execution capabilities and exact discovered target.
 * @returns Advertised tools for metadata-only consent, or the exact tool's sanitized result.
 */
export async function runOneShotMcp(ctx: Context, options: OneShotMcpOptions): Promise<OneShotMcpOutcome> {
  const signer = options.capabilities?.machineIdentity
  if (!signer) throw new McpDomainConsentError('scope_authorization_unavailable')
  await options.assertActive()
  const connectionId = `once-${createHash('sha256').update(randomUUID()).digest('hex')}`
  const readKey = await options.history.reserve(connectionId)
  await options.assertActive()
  const current = options.target
  const machine = new MachineAuthenticationSession(ctx, {
    mode:'cimd-client-credentials',connectionId,identityRef:current.identityRef,policyRef:current.policyRef,
    requestedScopes:current.scopes,issuer:current.target.issuer,stateRoot:current.stateRoot,encryptionKeyRef:'MCP_DOMAIN_ONE_SHOT_KEY',
    tokenRetry:{ maxAttempts:1,initialDelayMs:1,maxDelayMs:1 },
  },current.target.resource,options.consent.fetch,undefined,options.history.redactor,readKey,options.assertRoute,signer)
  const client = new Client({ name:'dsh-mcp-client-once',version:'0.0.1' },{ capabilities:{},versionNegotiation:{ mode:'auto' } })
  const transport = new StreamableHTTPClientTransport(new URL(current.target.resource),{ fetch:machine.fetch })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    try { await transport.terminateSession() }
    catch (_error) { ctx.logger.warn('mcp_domain_session_termination_unconfirmed') }
    const settled=await Promise.allSettled([client.close(),machine.dispose(true)])
    if(settled.some(result=>result.status==='rejected'))throw new McpDomainConsentError('one_shot_cleanup_unconfirmed')
  })()
  const abort=()=>{void close().catch(() => undefined)}
  options.signal.addEventListener('abort',abort,{ once:true })
  try {
    const outcome = await options.consent.withWireCall(options.tool?.name ?? '__mcp_tools_list__',options.args,options.signal,!options.tool,options.assertActive,async()=>{
      try {
        options.signal.throwIfAborted()
        await client.connect(transport,{ signal:options.signal,timeout:options.callTimeoutMs })
        await options.assertActive()
        const listed=await client.listTools(undefined,{ cacheMode:'refresh',signal:options.signal,timeout:options.callTimeoutMs })
        await options.assertActive()
        await options.history.restore()
        const tools=options.history.redactor.sanitize(listed).tools
        const tool = options.tool
        if(!tool)return { kind:'tools' as const,tools }
        const selected=tools.find(candidate=>candidate.name===tool.name)
        if(!selected||!isDeepStrictEqual(selected,tool))throw new McpDomainConsentError('discovered_operation_changed')
        const result=await client.callTool(
          { name:selected.name,arguments:options.args },
          { signal:options.signal,timeout:options.callTimeoutMs,toolDefinition:selected },
        )
        await options.assertActive()
        await options.history.restore()
        return { kind:'result' as const,result:options.history.redactor.sanitize(result) }
      } finally { await close() }
    })
    return { ...outcome,credentialRevocation:machine.status().remoteRevocation }
  } finally {
    options.signal.removeEventListener('abort',abort)
    // Remote revocation may remain unconfirmed. Retained encrypted receipts and keys are not discarded.
    await close()
    await options.history.restore()
  }
}
