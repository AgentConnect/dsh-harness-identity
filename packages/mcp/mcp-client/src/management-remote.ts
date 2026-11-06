/** Opt-in user Remote, carried only by the Host's authenticated Typert gateway. @module */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { z } from 'zod'
import type { MachineConnectionManager, MachineConnectionStatus } from './management-types.ts'
import type {} from './management.ts'
import { MachineManagementError } from './management.ts'
import type { MachineManagementRefusal } from './management.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'mcp/management-refused': { readonly reason: MachineManagementRefusal } }
}

const connectionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)
const status = z.object({ connectionId,
  state: z.enum(['discovering', 'connecting', 'ready', 'retry_wait', 'blocked', 'disconnecting', 'disconnected']),
  generation: z.number().int().nonnegative(),
  remoteRevocation: z.enum(['not_requested', 'confirmed', 'remote_revocation_unconfirmed']),
  authentication: z.enum(['discovering', 'binding_ready', 'token_ready', 'blocked', 'stopped']),
  historyState: z.enum(['migration_required', 'quarantine']).optional(),
  migrationId: z.string().regex(/^[A-Za-z0-9-]{16,64}$/u).optional(),
}).strict()

/** User administration of configured connections; no identity or key selectors cross this API. */
export class MachineManagementRemote extends TypertRemoteService {
  static inject = ['mcpConnections', 'typert']
  private readonly manager: MachineConnectionManager
  constructor(ctx: Context) {
    super(ctx, 'mcpConnectionManager', { namespace: 'mcpConnections' })
    this.manager = ctx.mcpConnections.bindManager(ctx)
    ctx.effect(() => ctx.typert.register({
      package: '@deepseek-ai/dsh-mcp-client', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
      invocations: ['status', 'disconnect', 'enable'].map(method => ({
        id: `@deepseek-ai/dsh-mcp-client#mcpConnections/${method}`, service: 'mcpConnectionManager', namespace: 'mcpConnections', method,
        invocation: { kind: 'direct' as const },
        parameters: [{ name: 'connectionId', wire: 'connectionId', source: 'json' as const,
          codec: { mode: 'strict' as const, typeSymbol: 'mcpConnections/connectionId', schema: connectionId } }],
        result: { mode: 'strict' as const, typeSymbol: 'mcpConnections/status', schema: status },
      })),
    }))
  }
  private async invoke(method: keyof MachineConnectionManager, id: string): Promise<MachineConnectionStatus> {
    if (!connectionId.safeParse(id).success) throw new RemoteError('gateway/bad-request', 'Invalid machine connection id.', {})
    try { return await this.manager[method](id) }
    catch (error) {
      throw new RemoteError('mcp/management-refused', 'Machine connection management refused.', {
        reason: error instanceof MachineManagementError ? error.code : 'operation_failed',
      })
    }
  }
  /** Read lifecycle state, including a disabled connection after Host restart.
   * @param id - Configured stable connection id.
   * @returns Public state without credentials or signer leases.
   */
  @Remote status(id: string): Promise<MachineConnectionStatus> { return this.invoke('status', id) }
  /** Disable locally and attempt trusted-endpoint Token revocation.
   * @param id - Configured stable connection id.
   * @returns Disabled state and independent remote revocation outcome.
   */
  @Remote disconnect(id: string): Promise<MachineConnectionStatus> { return this.invoke('disconnect', id) }
  /** Revalidate C permission and target before explicit enablement.
   * @param id - Configured stable connection id.
   * @returns Actual SDK state after the new connection attempt.
   */
  @Remote enable(id: string): Promise<MachineConnectionStatus> { return this.invoke('enable', id) }
}
export default MachineManagementRemote
