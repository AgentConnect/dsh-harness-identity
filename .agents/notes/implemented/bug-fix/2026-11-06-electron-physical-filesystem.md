# Agent Note: Physical filesystem IO in Electron

Status: implemented

English | [中文](2026-11-06-electron-physical-filesystem.zh.md)

## Problem

Electron treats ASAR paths as virtual directories. In Electron 43.3, a request for bigint metadata on those paths returns synthetic number Stats without nanosecond timestamps and with unstable inode values. The local filesystem backend requires realpath identity and physical metadata for its version tokens; mixing virtual metadata with kernel writes breaks that contract and can throw before listing completes.

## Decision

The [local backend](../../../../packages/fs/fs-local/README.md) selects Electron's built-in `original-fs` when the actual process reports `process.versions.electron`. Callback streams and every promise-based IO operation use that same physical implementation. Missing `original-fs` fails explicitly. Ordinary Node continues using its existing `node:fs` and `node:fs/promises` implementations.

ASAR archives are physical regular files to this provider, and virtual members do not resolve as host paths. No global filesystem method or `process.noAsar` setting changes. Electron's ordinary module and asset loaders retain their virtual archive access, as described by the [official ASAR documentation](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

## Alternatives considered

**Converting only mode to a number** leaves missing timestamps and synthetic inode changes in version tokens. Inventing nanoseconds cannot restore physical identity.

**Ignoring a particular stock archive or disabling ASAR globally** either leaves other host archives broken or changes module and asset loading outside this provider.

## Verification

The explicit Linux Electron 43.3 / ABI148 source regression reproduces the original BigInt/number failure. It checks physical archive metadata and repeated versions, root-directory listing, absent virtual members, bounded byte streams, symlink identity, atomic guarded writes and stale-write rejection. Parallel assertions read the same virtual member through ordinary Node fs and require, and confirm that `process.noAsar` remains unchanged. Existing Node filesystem, IO-fault and native-boundary unit tests retain their independent coverage.

## Consequences

This restores physical IO selection; it does not strengthen the existing process-local mutation lock or remove external-writer replacement races. The package's documented metadata and cross-process limitations remain. A packaged Electron runtime still requires its owning artifact smoke; source-provider evidence does not replace that check.
