/** Installed identity Host contract; model tools cannot mutate permissions or construct target handles. @module */
export interface ProtocolTarget { readonly protocolTarget: true }
/** Semantic classification from the shared Host implementation. */
export interface ProtocolClassification { effect: 'read' | 'write' | 'unknown' | 'payment'; extraPermissions: boolean }
/** Version-pinned policy decision, rechecked at the physical send. */
export interface ProtocolAdmission {
  decision: 'allow' | 'ask' | 'deny'
  version: number
  assertActive(): Promise<void>
}
/** Read-only adapter capability; no owner decision or settings-write methods. */
export interface ProtocolPolicyClient {
  register(input: { discoveryOrigin: string; destinations: readonly string[] }): ProtocolTarget
  forget(target: ProtocolTarget): void
  classifyMcp(annotations: unknown): ProtocolClassification
  classifyScopes(scopes: readonly string[]): ProtocolClassification
  evaluate(target: ProtocolTarget, input: { url: string } & ProtocolClassification): Promise<ProtocolAdmission>
  assertNoDenial(request: Request): Promise<void>
}
