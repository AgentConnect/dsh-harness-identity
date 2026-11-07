/** Machine authentication respects the existing Host proxy authority without weakening DNS pinning. */
import { createServer } from 'node:http'
import * as dns from 'node:dns/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { machineFetch } from '../src/machine-http.ts'
import { MachineAuthenticationSession } from '../src/machine-auth.ts'

vi.mock('node:dns/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns/promises')>()
  return { ...original, lookup: vi.fn(original.lookup) }
})
type LookupAll = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>
const lookup = vi.mocked(dns.lookup as LookupAll)

it('refuses a proxied machine lane before DNS, identity admission, signing or Token requests', async () => {
  let proxyHits = 0
  const proxy = createServer((_request, response) => { proxyHits++; response.writeHead(502); response.end() })
  proxy.on('connect', (_request, socket) => { proxyHits++; socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('fixture_address')
  const proxyUrl = `http://127.0.0.1:${address.port}`
  const stopProxy = await installProxyFromEnvironment({ get: name => ['HTTP_PROXY', 'HTTPS_PROXY'].includes(name) ? { value: proxyUrl } : undefined }, () => {})
  const root = await mkdtemp(join(tmpdir(), 'mcp-machine-proxy-'))
  const bind = vi.fn(() => { throw new Error('identity_must_not_be_admitted') })
  const ctx = { get: (name: string) => name === 'credentials' ? { resolve: async () => ({ value: Buffer.alloc(32, 41).toString('base64url') }) }
    : { bindProtocolConsumer: bind } } as unknown as Context
  lookup.mockClear()
  const session = new MachineAuthenticationSession(ctx, { mode: 'cimd-client-credentials', connectionId: 'proxy-egress-unit',
    identityRef: { storeId: 'store', identityId: 'identity', did: 'did:web:identity.example' }, policyRef: 'policy', requestedScopes: ['agent.self.read'],
    stateRoot: root, encryptionKeyRef: 'MCP_KEY' }, 'https://resource-proxy.invalid/mcp')
  try {
    await expect(session.fetch('https://resource-proxy.invalid/mcp')).rejects.toThrow('proxy_egress_unsupported')
    expect(lookup).not.toHaveBeenCalled()
    expect(bind).not.toHaveBeenCalled()
    expect(proxyHits).toBe(0)
  } finally {
    await session.dispose(); await stopProxy(); await rm(root, { recursive: true, force: true })
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  }
})

it('keeps an explicit NO_PROXY destination on the validated direct path', async () => {
  const proxyUrl = 'http://127.0.0.1:1'
  const stopProxy = await installProxyFromEnvironment({ get: name => name === 'NO_PROXY' ? { value: 'direct-bypass.invalid' }
    : ['HTTP_PROXY', 'HTTPS_PROXY'].includes(name) ? { value: proxyUrl } : undefined }, () => {})
  try {
    expect(proxyRouteFor(new URL('https://proxied.invalid/metadata')).proxied).toBe(true)
    expect(proxyRouteFor(new URL('https://direct-bypass.invalid/metadata')).proxied).toBe(false)
    lookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    await expect(machineFetch('https://direct-bypass.invalid/metadata')).rejects.toThrow('unsafe_target')
    expect(lookup).toHaveBeenLastCalledWith('direct-bypass.invalid', { all: true, verbatim: true })
  } finally { await stopProxy(); lookup.mockReset() }
})
