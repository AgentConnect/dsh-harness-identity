/** External identity owner policy fixture; tests exercise the real MCP executor, SDK and transport. */
import type { ProtocolPolicyClient, ProtocolTarget, ProtocolClassification } from '../../src/domain-policy.ts'

export function domainPolicyFixture() {
  const targets = new WeakMap<ProtocolTarget, { domain: string; origins: Set<string> }>()
  const decisions = { read: 'allow', write: 'ask', unknown: 'ask', payment: 'ask' } as Record<ProtocolClassification['effect'], 'allow' | 'ask' | 'deny'>
  let version = 0
  let writeDomain: string | undefined
  const changed = () => Object.assign(new Error('Fixture policy changed'), { code: 'protocol_policy_changed' })
  const client: ProtocolPolicyClient = {
    register(input) {
      const target = { protocolTarget: true as const }
      targets.set(target, { domain: new URL(input.discoveryOrigin).hostname, origins: new Set(input.destinations) })
      return target
    },
    forget(target) { targets.delete(target) },
    classifyMcp(raw) {
      const value = raw as { readOnlyHint?: boolean; destructiveHint?: boolean; paymentHint?: boolean } | undefined
      return { effect: value?.paymentHint ? 'payment' : value?.readOnlyHint === true ? value.destructiveHint === false ? 'read' : 'unknown' : value?.readOnlyHint === false || value?.destructiveHint === true ? 'write' : 'unknown', extraPermissions: false }
    },
    classifyScopes(scopes) {
      const known = scopes.length && scopes.every(scope => /(?:^|[.:/_-])(?:read|write)$/iu.test(scope))
      return { effect: !known ? 'unknown' : scopes.some(scope => /(?:^|[.:/_-])write$/iu.test(scope)) ? 'write' : 'read', extraPermissions: !known }
    },
    async assertNoDenial(request) { if (request.headers.has('authorization') || request.headers.has('cookie')) throw new Error('Credential in logical policy request') },
    async evaluate(target, input) {
      const entry = targets.get(target), expected = version
      if (!entry || !entry.origins.has(new URL(input.url).origin)) throw changed()
      const selected = input.effect === 'write' && writeDomain ? entry.domain === writeDomain ? 'allow' : 'deny' : decisions[input.effect]
      const decision = selected === 'deny' ? 'deny' : input.extraPermissions || input.effect === 'payment' || input.effect === 'unknown' ? 'ask' : selected
      return { decision, version, async assertActive() { if (!targets.has(target) || expected !== version || decision === 'deny') throw changed() } }
    },
  }
  return { client, set(effect: ProtocolClassification['effect'], decision: 'allow' | 'ask' | 'deny') { decisions[effect] = decision; version++ },
    whitelistWrite(domain: string) { writeDomain = domain; version++ } }
}
