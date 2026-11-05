/** Explicit keyless Host provider; contains no production identity adapter. @module */
import type { Context } from '@deepseek-ai/cordis'
import { credentials, identityService } from './remote.ts'

/** Fixture plugin name. */
export const name = 'machine-host-fixture'
/** Publish fixture-only credentials and local identity capabilities.
 * @param ctx - Application context used by the production machine MCP plugin.
 */
export function apply(ctx: Context): void {
  ctx.provide('credentials', credentials)
  ctx.provide('anpIdentity', identityService)
}
