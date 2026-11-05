/** Opt-in Host authority for configured MCP machine connections. @module */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ManagedMachineConnection, MachineConnectionManager } from './management-types.ts'

export type { MachineConnectionManager, MachineConnectionStatus } from './management-types.ts'

/** Installed Host plugins allowed to manage machine connections. Empty denies all managers. */
export interface Config { managerConsumers: string[] }
interface Entry { options: { name: string }; disabled?: boolean; fiber?: { ctx?: Context; state: number } }
function sameFiber(entry: Entry, ctx: Context): boolean { return (entry.fiber?.ctx?.fiber ?? entry.fiber) === ctx.fiber }

/** Closed management refusal reasons, safe for authenticated user responses. */
export type MachineManagementRefusal = 'manager_forbidden' | 'invalid_connection_id' | 'connection_unavailable' | 'operation_failed'
/** A management refusal containing no external error text. */
export class MachineManagementError extends Error {
  constructor(readonly code: MachineManagementRefusal) { super(code); this.name = 'MachineManagementError' }
}

declare module '@deepseek-ai/cordis' { interface Context { mcpConnections: McpConnections } }

/** Host-only registry; bound management capabilities are never model tools. */
export class McpConnections extends Service {
  static inject = ['loader']
  static Config: z<Config> = z.object({ managerConsumers: z.array(String).default([]) })
  private readonly hostContext: Context
  private readonly records = new Map<string, { context: Context; connection: ManagedMachineConnection }>()
  private readonly managers: Set<string>
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcpConnections')
    this.hostContext = ctx
    this.managers = new Set(config.managerConsumers)
  }
  private authorize(context: Context): void {
    const loader = this.hostContext.get('loader') as { entries(): Iterable<Entry> } | undefined
    const entry = loader && [...loader.entries()].find(value => sameFiber(value, context))
    if (this.hostContext.fiber.state > 2 || !entry || entry.disabled || ![1, 2].includes(context.fiber.state)
      || !this.managers.has(entry.options.name)) throw new MachineManagementError('manager_forbidden')
  }
  /** Bind management to an actual installed Host plugin, rechecked on every operation.
   * @param context - Current Loader-owned manager context, never a consumer name.
   * @returns A capability restricted to public state and explicit lifecycle actions.
   */
  bindManager(context: Context): MachineConnectionManager {
    this.authorize(context)
    const record = (id: string) => {
      this.authorize(context)
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new MachineManagementError('invalid_connection_id')
      const value = this.records.get(id)
      if (!value || ![1, 2].includes(value.context.fiber.state)) throw new MachineManagementError('connection_unavailable')
      return value
    }
    return Object.freeze({
      status: async (id: string) => {
        const value = record(id)
        const status = await value.connection.status()
        if (record(id) !== value) throw new MachineManagementError('connection_unavailable')
        return status
      },
      disconnect: async (id: string) => {
        const value = record(id)
        await value.connection.disconnect()
        if (record(id) !== value) throw new MachineManagementError('connection_unavailable')
        return value.connection.status()
      },
      enable: async (id: string) => {
        const value = record(id)
        const authorize = () => {
          if (record(id) !== value) throw new MachineManagementError('connection_unavailable')
        }
        await value.connection.enable(authorize)
        authorize()
        return value.connection.status()
      },
    })
  }
  /** Register a configured connection from its actual MCP Loader context.
   * @param context - Installed MCP plugin owning the supervisor and signer session.
   * @param id - Stable Host connection id.
   * @param connection - Controls closed over the owner context and immutable configuration.
   * @returns Removal after the owner has quiesced its work.
   */
  register(context: Context, id: string, connection: ManagedMachineConnection): () => void {
    const entry = (context.fiber as unknown as { entry?: Entry }).entry
    if (!entry || entry.options.name !== '@deepseek-ai/dsh-mcp-client' || !sameFiber(entry, context)) throw new Error('machine_connection_forbidden')
    if (this.records.has(id)) throw new Error('machine_connection_id_conflict')
    const record = { context, connection }
    this.records.set(id, record)
    return () => { if (this.records.get(id) === record) this.records.delete(id) }
  }
}
export default McpConnections
