/** Public OAuth discovery for the fixed CIMD client-credentials profile. @module */
import { createHash } from 'node:crypto'
import { machineFetch, machineJson, machineUrl } from './machine-http.ts'
import type { MachineTarget } from './machine-types.ts'

/** Stable discovery failure without metadata or credential values. */
export class MachineDiscoveryError extends Error {
  /** @param code - Discovery failure discriminant. */
  constructor(readonly code: string) { super(code) }
}

/** Discover one exact MCP resource and select one compatible AS.
 * @param endpoint - Exact MCP resource URL.
 * @param selectedIssuer - Explicit selection when the resource lists multiple issuers.
 * @param cacheMs - Maximum lifetime of the validated discovery snapshot.
 * @param send - HTTPS transport; tests may inject isolated responses.
 * @returns Discovery evidence. This is not signing permission.
 */
export async function discoverMachineTarget(endpoint: string, selectedIssuer?: string,
  send: typeof machineFetch = machineFetch, cacheMs = 300000): Promise<MachineTarget> {
  const resource = machineUrl(endpoint)
  const candidates = [...new Set([`${resource.origin}/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`, `${resource.origin}/.well-known/oauth-protected-resource`])]
  let metadata: Record<string, unknown> | undefined
  let source = ''
  for (const candidate of candidates) {
    const response = await send(candidate, { headers: { accept: 'application/json' }, redirect: 'manual' })
    if (response.status === 404) { await response.body?.cancel(); continue }
    if (response.status !== 200) { await response.body?.cancel(); throw new MachineDiscoveryError('discovery_failed') }
    metadata = await machineJson(response); source = candidate; break
  }
  if (!metadata) {
    const probe = await send(endpoint, { method: 'HEAD', redirect: 'manual' })
    const challenge = probe.headers.get('www-authenticate')
    await probe.body?.cancel()
    const match = challenge?.match(/^Bearer\s+.*?resource_metadata="([^"\\]+)"/iu)
    if (probe.status !== 401 || !match?.[1]) throw new MachineDiscoveryError('discovery_failed')
    source = match[1]; machineUrl(source)
    const response = await send(source, { headers: { accept: 'application/json' }, redirect: 'manual' })
    if (response.status !== 200) { await response.body?.cancel(); throw new MachineDiscoveryError('discovery_failed') }
    metadata = await machineJson(response)
  }
  if (metadata.resource !== endpoint || !Array.isArray(metadata.authorization_servers)
    || !metadata.authorization_servers.length || metadata.authorization_servers.length > 16
    || !metadata.authorization_servers.every(value => typeof value === 'string')) throw new MachineDiscoveryError('incompatible_resource')
  const issuers = [...new Set(metadata.authorization_servers as string[])]
  for (const issuer of issuers) machineUrl(issuer)
  const issuer = selectedIssuer ?? (issuers.length === 1 ? issuers[0] : undefined)
  if (!issuer || !issuers.includes(issuer)) throw new MachineDiscoveryError('issuer_selection_required')
  const parsed = machineUrl(issuer)
  const asSource = `${parsed.origin}/.well-known/oauth-authorization-server${parsed.pathname === '/' ? '' : parsed.pathname}`
  const response = await send(asSource, { headers: { accept: 'application/json' }, redirect: 'manual' })
  if (response.status !== 200) { await response.body?.cancel(); throw new MachineDiscoveryError('discovery_failed') }
  const authorization = await machineJson(response)
  for (const [name, required] of [['grant_types_supported', 'client_credentials'], ['token_endpoint_auth_methods_supported', 'private_key_jwt'], ['token_endpoint_auth_signing_alg_values_supported', 'ES256']] as const) {
    if (!Array.isArray(authorization[name]) || !(authorization[name] as unknown[]).includes(required)) throw new MachineDiscoveryError('unsupported_machine_profile')
  }
  if (authorization.issuer !== issuer || authorization.client_id_metadata_document_supported !== true
    || typeof authorization.token_endpoint !== 'string') throw new MachineDiscoveryError('unsupported_machine_profile')
  machineUrl(authorization.token_endpoint)
  if (authorization.revocation_endpoint !== undefined) {
    if (typeof authorization.revocation_endpoint !== 'string') throw new MachineDiscoveryError('incompatible_metadata')
    machineUrl(authorization.revocation_endpoint)
  }
  return { profile: 'mcp_machine', issuer, resource: endpoint, tokenEndpoint: authorization.token_endpoint,
    ...(typeof authorization.revocation_endpoint === 'string' ? { revocationEndpoint: authorization.revocation_endpoint } : {}),
    metadataDigest: createHash('sha256').update(JSON.stringify({ resource: metadata, authorizationServer: authorization })).digest('hex'),
    expiresAt: Date.now() + cacheMs, sources: { resource: source, authorizationServer: asSource } }
}
