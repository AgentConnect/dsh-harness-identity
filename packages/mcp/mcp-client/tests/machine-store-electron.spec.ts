/** Explicit Electron RunAsNode source regression; no GUI, built Harness output or Electron dependency is required. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const electron = process.env.DSH_MCP_TEST_ELECTRON
const directories: string[] = []
const require = createRequire(import.meta.url)
const source = pathToFileURL(join(process.cwd(), 'packages/mcp/mcp-client/src/machine-store.ts')).href
const program = `
  import assert from 'node:assert/strict';
  import { readFile } from 'node:fs/promises';
  import { MachineConnectionStore } from ${JSON.stringify(source)};
  assert.match(process.versions.electron, /^43\\.3\\./);
  assert.equal(process.versions.modules, '148');
  // Real Desktop Hosts and the Desktop CLI clear the inherited RunAsNode flag.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const [directory, mode] = process.argv.slice(1);
  const token = () => ({ token: 'electron-private-token', partition: 'partition', acquiredAt: Date.now(), expiresAt: Date.now() + 60000, scopes: ['read'] });
  const make = key => new MachineConnectionStore(directory, 'electron-connection', key ?? (async () => Buffer.alloc(32, 17)));
  const facts = () => ({ electron: process.versions.electron, abi: process.versions.modules });
  if (mode === 'roundtrip') {
    const store = make(), generation = await store.open('partition');
    await store.commit(generation, token());
    assert.equal((await store.token(generation, 'partition')).token, 'electron-private-token');
    await store.disable();
    await assert.rejects(store.open('partition'), /connection_disabled/);
    console.log(JSON.stringify({ ...facts(), encryptedRoundtrip: true, disabled: true }));
  } else if (mode === 'hold') {
    const store = make(async () => { console.log('held'); await new Promise(() => {}); return Buffer.alloc(32, 17); });
    const generation = await store.open('partition');
    await store.commit(generation, token());
  } else if (mode === 'recover') {
    const store = make(), generation = await store.open('partition');
    assert.equal(await store.token(generation, 'partition'), undefined);
    await store.commit(generation, token());
    assert.equal((await store.token(generation, 'partition')).token, 'electron-private-token');
    await store.disable();
    console.log(JSON.stringify({ ...facts(), recovered: true, disabled: true }));
  } else if (mode === 'disabled') {
    await assert.rejects(make().open('partition'), /connection_disabled/);
    console.log(JSON.stringify({ ...facts(), persistedFence: true }));
  } else if (mode === 'holder-loss') {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const store = make(async () => { entered(); await gate; return Buffer.alloc(32, 17); });
    const generation = await store.open('partition');
    const pending = store.commit(generation, token());
    const rejected = assert.rejects(pending, /connection_store_locked/);
    await started;
    const children = (await readFile('/proc/self/task/' + process.pid + '/children', 'utf8')).trim().split(/\\s+/).filter(Boolean);
    let owner;
    for (const candidate of children) {
      const command = await readFile('/proc/' + candidate + '/cmdline', 'utf8').catch(() => '');
      if (command.includes(directory)) { owner = candidate; break; }
    }
    assert.ok(owner, 'lock holder must be a real child');
    const workers = (await readFile('/proc/' + owner + '/task/' + owner + '/children', 'utf8')).trim().split(/\\s+/).filter(Boolean);
    process.kill(Number(workers[0] ?? owner), 'SIGKILL');
    await store.disable();
    release(); await rejected;
    await assert.rejects(store.open('partition'), /connection_disabled/);
    console.log(JSON.stringify({ ...facts(), killedHolderRejected: true, disabledNotRevived: true }));
  } else throw new Error('unknown_test_mode');
`

function start(directory: string, mode: string) {
  if (!electron) throw new Error('Explicit DSH_MCP_TEST_ELECTRON is required')
  const child = spawn(electron, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--input-type=module', '-e', program, directory, mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.base.json'), DISPLAY: '', WAYLAND_DISPLAY: '' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', (value) => { output += String(value) })
  child.stderr.on('data', (value) => { errors += String(value) })
  const completion = new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`Electron worker regression exited ${code}/${signal}: ${errors}`)))
  })
  void completion.catch(() => {})
  const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* The owned process group already exited. */ } } }, 10000)
  const stop = () => {
    clearTimeout(timer)
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* The owned process group already exited. */ } }
  }
  return { child, completion, stop, output: () => output }
}

async function run(directory: string, mode: string) {
  const instance = start(directory, mode)
  try { return JSON.parse((await instance.completion).trim()) as Record<string, unknown> } finally { instance.stop() }
}

async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-store-electron-'))
  directories.push(directory)
  return directory
}

afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'linux' || !electron)('machine store in actual Electron 43.3 / ABI148', () => {
  it('runs its internal Node holder without inheriting RunAsNode and preserves an encrypted disabled fence across restart', async () => {
    const directory = await root()
    expect(await run(directory, 'roundtrip')).toEqual({ electron: '43.3.0', abi: '148', encryptedRoundtrip: true, disabled: true })
    expect(await run(directory, 'disabled')).toMatchObject({ persistedFence: true })
    const files = await readdir(directory)
    const row = await readFile(join(directory, files.find(name => name.endsWith('.json'))!), 'utf8')
    expect(row).not.toContain('electron-private-token')
    expect(JSON.parse(row)).toMatchObject({ active: false })
  }, 20000)

  it('recovers the kernel lock after SIGKILL of an Electron parent and leaves the restart disabled fence effective', async () => {
    const directory = await root()
    const held = start(directory, 'hold')
    try {
      await expect.poll(held.output, { timeout: 8000 }).toContain('held')
      held.child.kill('SIGKILL')
      await held.completion.catch(() => {})
      expect(await run(directory, 'recover')).toMatchObject({ recovered: true, disabled: true })
    } finally { held.stop() }
    expect(await run(directory, 'disabled')).toMatchObject({ persistedFence: true })
  }, 25000)

  it('cannot let a stale Electron transaction revive a disabled fence after the actual lock worker is killed', async () => {
    const directory = await root()
    expect(await run(directory, 'holder-loss')).toMatchObject({ killedHolderRejected: true, disabledNotRevived: true })
    expect(await run(directory, 'disabled')).toMatchObject({ persistedFence: true })
  }, 20000)
})
