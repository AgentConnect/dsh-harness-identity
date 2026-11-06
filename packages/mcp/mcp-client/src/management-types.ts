/** Public machine connection management facts; credentials never cross this interface. @module */
import type { MachineHistoryRecoveryRule } from './machine-history.ts'

/** Sanitized state of one configured machine connection. */
export interface MachineConnectionStatus {
  connectionId: string
  state: 'discovering' | 'connecting' | 'ready' | 'retry_wait' | 'blocked' | 'disconnecting' | 'disconnected'
  generation: number
  remoteRevocation: 'not_requested' | 'confirmed' | 'remote_revocation_unconfirmed'
  authentication: 'discovering' | 'binding_ready' | 'token_ready' | 'blocked' | 'stopped'
  historyState?: 'migration_required' | 'quarantine'
  migrationId?: string
}

/** Capability issued to one installed, operator-approved Host manager. */
export interface MachineConnectionManager {
  /** Read public state for a configured connection. */
  status(connectionId: string): Promise<MachineConnectionStatus>
  /** Persist a disabled fence, quiesce SDK/tools, and attempt standard revocation. */
  disconnect(connectionId: string): Promise<MachineConnectionStatus>
  /** Explicitly reauthorize and enable the same connection id with a fresh generation. */
  enable(connectionId: string): Promise<MachineConnectionStatus>
}

/** Lifecycle operations supplied only by the installed MCP plugin. */
export interface ManagedMachineConnection {
  status(): Promise<MachineConnectionStatus>
  disconnect(): Promise<void>
  enable(authorize: () => void, recovery?: MachineHistoryRecoveryRule): Promise<void>
}
