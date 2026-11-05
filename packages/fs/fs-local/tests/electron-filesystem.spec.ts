/** Explicit Electron source regression for physical Host IO; no GUI or built Harness output is used. */
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const electron = process.env.DSH_FS_TEST_ELECTRON
const require = createRequire(import.meta.url)
const roots: string[] = []
const source = pathToFileURL(join(process.cwd(), 'packages/fs/fs-local/src/index.ts')).href
const script = `
  import assert from 'node:assert/strict';
  import { createRequire } from 'node:module';
  import { join } from 'node:path';
  import { Context } from '@deepseek-ai/cordis';
  import LocalFileSystem from ${JSON.stringify(source)};
  const require = createRequire(import.meta.url);
  const virtual = require('node:fs').promises;
  const physical = process.getBuiltinModule('original-fs').promises;
  assert.equal(process.versions.electron, '43.3.0');
  assert.equal(process.versions.modules, '148');
  const [root, mode] = process.argv.slice(1);
  const archive = join(root, 'fixture.asar');
  const noAsar = process.noAsar;
  assert.ok(!noAsar);
  const ctx = new Context();
  try {
    await ctx.plugin(LocalFileSystem, { cwd: root });
    if (mode === 'archive') {
      const virtualInfo = await virtual.stat(archive, { bigint: true });
      assert.equal(virtualInfo.isDirectory(), true);
      assert.equal(typeof virtualInfo.mode, 'number');
      const asset = await virtual.readFile(archive + '/package.json', 'utf8');
      assert.deepEqual(require(archive + '/package.json'), JSON.parse(asset));
      const target = await ctx.fs.resolve(archive);
      const first = await ctx.fs.stat(target);
      assert.equal(first.type, 'file');
      for (let index = 0; index < 4; index++) assert.deepEqual(await ctx.fs.stat(target), first);
      assert.deepEqual(await ctx.fs.lstat(archive), first);
      const entries = await ctx.fs.listDir(await ctx.fs.resolve(root));
      assert.equal(entries.find(entry => entry.name === 'fixture.asar').type, 'file');
      await assert.rejects(ctx.fs.listDir(target), { code: 'FS_NOT_DIRECTORY' });
      await assert.rejects(ctx.fs.resolve(archive + '/package.json'), { code: 'FS_NOT_FOUND' });
      assert.equal(await ctx.fs.lstat(archive + '/package.json'), undefined);
      const raw = await physical.readFile(archive);
      assert.deepEqual(Buffer.from(await ctx.fs.readBytes(target, undefined, raw.length)), raw);
      assert.deepEqual(Buffer.from(await ctx.fs.readByteRange(target, { offset: 0, length: 16 })), raw.subarray(0, 16));
      assert.equal(await virtual.readFile(archive + '/package.json', 'utf8'), asset);
      assert.equal((await virtual.stat(archive)).isDirectory(), true);
      assert.equal(process.noAsar, noAsar);
      console.log(JSON.stringify({ electron: process.versions.electron, abi: process.versions.modules, physicalArchive: true, stableVersion: true, virtualAssetsUnchanged: true }));
    } else if (mode === 'cas') {
      const alias = join(root, 'alias.asar');
      await physical.symlink(archive, alias);
      const target = await ctx.fs.resolve(archive), linked = await ctx.fs.resolve(alias);
      assert.equal(linked.targetKey, target.targetKey);
      assert.equal((await ctx.fs.lstat(alias)).type, 'symlink');
      const first = await ctx.fs.stat(target);
      await assert.rejects(ctx.fs.writeText(target, 'must not replace', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' });
      const written = await ctx.fs.writeText(linked, 'physical replacement\\n', { kind: 'replaceIfVersion', version: first.version });
      assert.notEqual(written.version, first.version);
      assert.equal((await physical.lstat(alias)).isSymbolicLink(), true);
      assert.equal(await physical.readFile(archive, 'utf8'), 'physical replacement\\n');
      assert.equal(await ctx.fs.readText(target), 'physical replacement\\n');
      let streamed = ''; for await (const chunk of await ctx.fs.streamText(target)) streamed += chunk;
      assert.equal(streamed, 'physical replacement\\n');
      await assert.rejects(ctx.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: first.version }), { code: 'FS_STALE_VERSION' });
      await physical.writeFile(archive, 'external physical change');
      await assert.rejects(ctx.fs.writeText(linked, 'stale external overwrite', { kind: 'replaceIfVersion', version: written.version }), { code: 'FS_STALE_VERSION' });
      assert.equal(await physical.readFile(archive, 'utf8'), 'external physical change');
      assert.equal(process.noAsar, noAsar);
      console.log(JSON.stringify({ electron: process.versions.electron, abi: process.versions.modules, symlinkPreserved: true, physicalCas: true, staleVersionsRejected: true }));
    } else throw new Error('unknown_test_mode');
  } finally { await ctx.fiber.dispose(); }
`

async function fixture() {
  if (!electron) throw new Error('Explicit DSH_FS_TEST_ELECTRON is required')
  const root = await mkdtemp(join(tmpdir(), 'fs-local-electron-'))
  roots.push(root)
  await copyFile(join(dirname(electron), 'resources', 'default_app.asar'), join(root, 'fixture.asar'))
  return root
}

async function run(root: string, mode: string): Promise<Record<string, unknown>> {
  if (!electron) throw new Error('Explicit DSH_FS_TEST_ELECTRON is required')
  const child = spawn(electron, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--input-type=module', '-e', script, root, mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.base.json'), DISPLAY: '', WAYLAND_DISPLAY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { errors += String(chunk) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code !== 0) reject(new Error(`Electron filesystem regression exited ${code}/${signal}: ${errors}`))
        else { try { resolve(JSON.parse(output.trim()) as Record<string, unknown>) } catch (error) { reject(error) } }
      })
    })
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'linux' || !electron)('physical filesystem in actual Electron 43.3 / ABI148', () => {
  it('reports archives as stable physical files while Node ASAR assets and module loading remain virtual', async () => {
    expect(await run(await fixture(), 'archive')).toEqual({ electron: '43.3.0', abi: '148', physicalArchive: true, stableVersion: true, virtualAssetsUnchanged: true })
  }, 15000)

  it('uses physical symlink identity, streams and atomic guarded publication consistently', async () => {
    expect(await run(await fixture(), 'cas')).toEqual({ electron: '43.3.0', abi: '148', symlinkPreserved: true, physicalCas: true, staleVersionsRejected: true })
  }, 15000)
})
