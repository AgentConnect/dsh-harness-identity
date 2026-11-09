import { expect, it, vi } from 'vitest'
import { discoverDomain, domainOrigin } from '../src/domain.ts'
import { directPublicMachineFetch } from '../src/machine-http.ts'
import type { machineFetch } from '../src/machine-http.ts'

const urlOf = (input: string | URL | Request) => input instanceof Request ? input.url : input.toString()
const resource = 'https://service.example/mcp'
const issuer = 'https://service.example'
const prm = { resource, authorization_servers: [issuer], scopes_supported: ['protocol.read', 'message.write'] }
const as = { issuer, token_endpoint: `${issuer}/token`, client_id_metadata_document_supported: true,
  grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] }
it('discovers a service subdomain and requests only Host-approved scopes without credentials', async () => {
  const send = vi.fn<typeof machineFetch>(async (input, init) => {
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    return Response.json(urlOf(input).includes('oauth-authorization-server') ? as : prm)
  })
  const result = await discoverDomain('website.example', ['protocol.read'], undefined, send)
  expect(result).toMatchObject({ target: { resource, issuer }, scopes: ['protocol.read'] })
  expect(send.mock.calls.map(([url]) => urlOf(url))).toEqual([
    'https://website.example/.well-known/oauth-protected-resource',
    'https://service.example/.well-known/oauth-protected-resource/mcp',
    'https://service.example/.well-known/oauth-authorization-server',
  ])
  await expect(discoverDomain('website.example', ['protocol.read'], ['message.write'], send)).rejects.toThrow('scope_authorization_required')
})
it('rejects URLs, redirects, incompatible endpoints and authentication without opening a connection', async () => {
  for (const domain of ['https://example.com', 'example.com/path', 'user@example.com', 'example.com#part', 'example.com?x=1', 'example.com\\path', 'example.com x']) expect(() => domainOrigin(domain)).toThrow('invalid_domain')
  await expect(discoverDomain('example.com', ['protocol.read'], undefined, async () => new Response(null, { status:302 }))).rejects.toThrow('discovery_failed')
  let calls = 0
  await expect(discoverDomain('example.com', ['protocol.read'], undefined, async () => Response.json(calls++ === 0 ? prm : { ...prm,resource:'https://different.example/mcp' }))).rejects.toThrow('incompatible_resource')
  await expect(discoverDomain('example.com', ['protocol.read'], undefined, async input => Response.json(urlOf(input).includes('oauth-authorization-server') ? { ...as,grant_types_supported:['authorization_code'] } : prm))).rejects.toThrow('unsupported_machine_profile')
  await expect(discoverDomain('example.com', ['protocol.read'], undefined, async () => Response.json({ ...prm,resource:'http://private.example/mcp' }))).rejects.toThrow('invalid_target')
})

it('keeps private-address rejection in the explicit direct public HTTPS lane', async () => {
  await expect(directPublicMachineFetch('https://127.0.0.1/mcp')).rejects.toThrow('unsafe_target')
})
it('selects the service single declared read scope without a hard-coded protocol.read dependency', async () => {
  const send: typeof machineFetch = async input => Response.json(urlOf(input).includes('oauth-authorization-server') ? as : { ...prm, scopes_supported: ['intent:read', 'intent:write'] })
  expect(await discoverDomain('matchall.net', ['protocol.read'], undefined, send, true)).toMatchObject({ scopes: ['intent:read'] })
  expect(await discoverDomain('matchall.net', [], undefined, send, true)).toMatchObject({ scopes: ['intent:read'] })
})
it('does not silently request every advertised scope when read scope selection is ambiguous', async () => {
  const send: typeof machineFetch = async input => Response.json(urlOf(input).includes('oauth-authorization-server') ? as : { ...prm, scopes_supported: ['intent:read', 'profile.read', 'intent:write'] })
  await expect(discoverDomain('matchall.net', [], undefined, send, true)).rejects.toMatchObject({ code: 'scope_selection_required', availableScopes: ['intent:read', 'profile.read', 'intent:write'] })
  expect(await discoverDomain('matchall.net', [], ['intent:read'], send, true)).toMatchObject({ scopes: ['intent:read'] })
})
