#!/usr/bin/env node
/** Keyless runnable driver: isolate external network before booting the real headless app. @module */
import { installMachineWireFixture, machineWireSummary } from './remote.ts'

const dispose = installMachineWireFixture()
try {
  await import('../headless-driver.ts')
  process.stdout.write(`${JSON.stringify(machineWireSummary())}\n`)
} finally {
  dispose()
}
