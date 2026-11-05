/** Host-only machine authentication interfaces. No token enters the model or configuration. @module */

/** Durable configuration for the client-credentials profile. */
export interface MachineAuthentication {
  /** Selects the local CIMD client-credentials flow without interactive fallbacks. */
  mode: 'cimd-client-credentials'
  /** Persistent local connection identifier, independent of the displayed server name. */
  connectionId: string
  /** Exact identity reference from the shared local identity authority. */
  identityRef: {
    /** Local encrypted Store identifier. */
    storeId: string
    /** Identity identifier within that Store. */
    identityId: string
    /** Exact published DID. */
    did: string
  }
  /** Administrator-approved policy reference in the shared identity service. */
  policyRef: string
  /** Nonempty minimum scope set required by this connection. */
  requestedScopes: string[]
  /** Exact preselected AS issuer; required when resource metadata lists several. */
  issuer?: string
  /** Absolute protected directory for this connection's encrypted credentials. */
  stateRoot: string
  /** Host credential reference containing the base64url 32-byte encryption key. */
  encryptionKeyRef: string
  /** Maximum discovery snapshot lifetime in milliseconds; default 300000, maximum 3600000. */
  discoveryCacheMs?: number
  /** Bounded Token acquisition retry policy; every retry creates a fresh assertion. */
  tokenRetry?: {
    /** Maximum attempts in one acquisition, including the first; default 3, maximum 5. */
    maxAttempts: number
    /** Initial backoff delay in milliseconds; default 250. */
    initialDelayMs: number
    /** Maximum local retry delay in milliseconds; default 5000. */
    maxDelayMs: number
  }
}

/** Public discovery evidence; the identity authority independently verifies its sources. */
export interface MachineTarget {
  profile: 'mcp_machine'
  issuer: string
  resource: string
  tokenEndpoint: string
  revocationEndpoint?: string
  metadataDigest: string
  expiresAt: number
  sources: { resource: string; authorizationServer: string }
}

/** Local identity authorization. The object itself is the unforgeable lease. */
export interface MachineSignerLease {
  readonly targetRef: object
  readonly policyGeneration: number
  getOAuthClientIdentity(): Promise<{ clientId: string; keyId: string; algorithm: 'ES256'; version: number; signerMode: 'local' }>
  assertActive(): Promise<void>
  signOAuthClientAssertion(targetRef: object): Promise<string>
  dispose(): void
}

/** Consumer interface implemented by the shared identity Host service. */
export interface MachineIdentityClient {
  registerValidatedTarget(input: { identityRef: MachineAuthentication['identityRef']; policyRef: string; discovery: MachineTarget; requestedScopes: string[] }): Promise<MachineSignerLease>
}

/** Host-bound identity service, discovered only for configured machine mode. */
export interface MachineIdentityService {
  bindProtocolConsumer(context: import('@deepseek-ai/cordis').Context): MachineIdentityClient
}
