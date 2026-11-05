/** Deterministic model boundary for the assembled machine MCP transcript. @module */
import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class MachineModel extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    if (results.length < 3) {
      const block = { type: 'tool-call' as const, id: CallId(`machine-call-${results.length + 1}`), name: 'mcp__machine__identity_get', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'The machine identity is did:web:agent.example. The rejected call was not replayed; the next call acquired a new machine token.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Fixture plugin name. */
export const name = 'machine-model-fixture'
/** Required model registry. */
export const inject = ['llm']
/** Register the deterministic model; all tool execution uses the real application.
 * @param ctx - Settled application model registry.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['machine-keyless'], new MachineModel())
}
