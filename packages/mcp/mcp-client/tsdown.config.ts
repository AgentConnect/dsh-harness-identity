/** Build the upstream MCP entry and opt-in identity management entries together. */
import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/domain.js', 'lib/types/management.js', 'lib/types/management-remote.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
