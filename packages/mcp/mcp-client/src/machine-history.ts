/** Private durable bearer history and operator-authorized legacy recovery. @module */
import { performance } from 'node:perf_hooks'

/** Maximum validated expires_in, in milliseconds. */
export const MACHINE_TOKEN_MAX_LIFETIME = 86400000
/** Conservative network allowance after the advertised lifetime. */
export const MACHINE_HISTORY_ALLOWANCE = 30000
/** Full legacy isolation after an operator establishes that old writers stopped. */
export const MACHINE_HISTORY_QUARANTINE = MACHINE_TOKEN_MAX_LIFETIME + MACHINE_HISTORY_ALLOWANCE + 1000
/** Maximum retained bearer count. */
export const MACHINE_HISTORY_COUNT = 256
/** Maximum serialized private history size. */
export const MACHINE_HISTORY_BYTES = 1048576

/** Secret history record; never part of Remote or public status. */
export interface MachineSentBearer { value: string; receipt: string; source: string; lifetime: number }
/** Trusted Host profile statement, bound to one migration, not supplied by a user RPC. */
export interface MachineHistoryRecoveryRule {
  connectionId: string
  migrationId: string
  kind: 'old-writers-stopped' | 'prior-bearers-invalidated'
  evidenceRef: string
}
/** A monotonic isolation interval; reconstruction deliberately restarts elapsed time. */
export class MachineHistoryQuarantine {
  private interval: { migrationId: string; evidenceRef: string; since: number } | undefined
  constructor(private readonly now: () => number = () => performance.now()) {}
  /** Start or retain this process's isolation interval.
   * @param migrationId - Exact incomplete-history migration.
   * @param evidenceRef - Trusted operator reference establishing stopped old writers.
   */
  observe(migrationId: string, evidenceRef: string): void {
    if (this.interval?.migrationId !== migrationId || this.interval.evidenceRef !== evidenceRef) {
      this.interval = { migrationId, evidenceRef, since: this.now() }
    }
  }
  /** Require a matching trusted statement and the complete monotonic interval when applicable.
   * @param rule - Immutable operator-approved rule, never a Remote request field.
   * @param migrationId - Current durable migration id.
   * @returns Whether recovery may now complete.
   */
  ready(rule: MachineHistoryRecoveryRule, migrationId: string): boolean {
    if (rule.migrationId !== migrationId || !rule.evidenceRef) return false
    if (rule.kind === 'prior-bearers-invalidated') return true
    this.observe(migrationId, rule.evidenceRef)
    const interval = this.interval
    return interval !== undefined && this.now() - interval.since >= MACHINE_HISTORY_QUARANTINE
  }
}
