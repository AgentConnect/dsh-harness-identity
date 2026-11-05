# Agent Note: Explicit CIMD machine authentication for MCP

Status: implemented

English | [中文](2026-11-06-mcp-cimd-machine-authentication.zh.md)

## Problem

Static MCP headers cannot obtain renewable resource-bound machine credentials from an unfamiliar CIMD authorization server or coordinate local identity permission with connection disposal.

## Decision

The [MCP client](../../../../packages/mcp/mcp-client/README.md) adds an explicit client-credentials mode. Discovery validates public metadata before the shared identity authority issues a target-bound local signer lease. The SDK receives a fetch adapter and no OAuth provider; browser, code, DCR and refresh flows are unreachable from this mode. Existing stdio and explicit header configuration retain their independent entry paths.

Every Token flight captures one immutable target/lease/generation/partition. Signing, Token exchange, encrypted commit and physical resource send verify that same binding. Credential partitions include the publication key/version and policy generation. Linux kernel locking serializes durable mutations; the lock-owning worker performs writes and atomic renames, so killing it prevents a delayed parent operation from overwriting a newer disabled fence. Restart requests a new Token rather than trusting an old wall-clock lifetime.

## Alternatives considered

**Static Authorization headers** cannot refresh or bind credentials to independently validated discovery and permission generations.

**The SDK OAuth provider** includes interactive and dynamic-registration paths beyond this machine-only mode. The supported custom fetch extension preserves SDK MCP handling without enabling those paths.

**A timestamp-expired directory lock** cannot prove that the original writer stopped. A separate lock holder with parent-owned writes also permits the parent to write after the holder dies. The holder therefore owns the rename itself.

## Verification

Package tests cover immutable Token-flight generations, revocation during signing, disabled admission, process/holder death and actual DNS/TLS sockets. The [headless machine scenario](../../../../examples/headless-agent/mcp-machine.cordis.snapshot.yml) boots the production plugin, SDK and agent loop, pins the keyless session transcript, and verifies that a resource 401 is not replayed. Remote identity and AS/RS fixtures remain distinct from product E2E and deployment evidence.

## Consequences

Actual wire support is the installed SDK 1.29.0 Streamable HTTP initialize lane, including protocol 2025-11-25. Modern server/discover and machine credential storage on platforms without Linux flock remain unimplemented. Local disconnect fencing is separate from remote Token revocation; the result is reported independently as confirmed or remote_revocation_unconfirmed, and a re-enable UI remains deferred. Public discovery and encrypted credential storage add no model-visible text or credentials.
