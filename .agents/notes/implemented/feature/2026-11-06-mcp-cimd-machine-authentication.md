# Agent Note: Explicit CIMD machine authentication for MCP

Status: implemented

English | [中文](2026-11-06-mcp-cimd-machine-authentication.zh.md)

## Problem

Static MCP headers cannot obtain renewable resource-bound machine credentials from an unfamiliar CIMD authorization server or coordinate local identity permission with connection disposal.

## Decision

The [MCP client](../../../../packages/mcp/mcp-client/README.md) adds an explicit client-credentials mode. Discovery validates public metadata before the shared identity authority issues a target-bound local signer lease. The SDK receives a fetch adapter and no OAuth provider; browser, code, DCR and refresh flows are unreachable from this mode. Existing stdio and explicit header configuration retain their independent entry paths.

Every Token flight captures one immutable target/lease/generation/partition. Signing, Token exchange, encrypted commit and physical resource send verify that same binding. Credential partitions include the publication key/version and policy generation. Linux kernel locking serializes durable mutations; the lock-owning worker performs writes and atomic renames, so killing it prevents a delayed parent operation from overwriting a newer disabled fence. Restart requests a new Token rather than trusting an old wall-clock lifetime.

The private lock worker uses the current Host executable. Under Electron, the worker environment explicitly sets RunAsNode after checking `process.versions.electron`; Desktop may clear the inherited flag without changing how the holder starts. This environment applies only to the internal worker, and the system `flock` prerequisite remains explicit.

Host-wide connectionId is a persistent logical connection identity. A versioned globalThis Symbol.for registry rejects duplicates across scopes, roots, state directories and package copies; opaque owner tokens release only their own reservation. Restart never creates a new id to bypass a disabled fence. Existing Agent-scoped serverName and attachment behavior remain independent. The machine direct profile consults the existing proxyRouteFor before a request or signature; a proxy requirement is explicitly unsupported rather than silently bypassed.

## Alternatives considered

**Reading an opaque scopeKey id or inheriting the initiator** cannot prove the current new Agent: setup may inherit its parent, and scope keys promise no properties. Connection ownership uses an explicit Host-global identifier enforced by the actual constructor.

**Static Authorization headers** cannot refresh or bind credentials to independently validated discovery and permission generations.

**The SDK OAuth provider** includes interactive and dynamic-registration paths beyond this machine-only mode. The supported custom fetch extension preserves SDK MCP handling without enabling those paths.

**A timestamp-expired directory lock** cannot prove that the original writer stopped. A separate lock holder with parent-owned writes also permits the parent to write after the holder dies. The holder therefore owns the rename itself.

## Verification

Package tests cover immutable Token-flight generations, revocation during signing, disabled admission, process/holder death and actual DNS/TLS sockets. The [headless machine scenario](../../../../snapshots/session/mcp-machine/snapshot.yml) boots the production plugin, SDK and agent loop, pins the keyless session transcript, and verifies that a resource 401 is not replayed. Remote identity and AS/RS fixtures remain distinct from product E2E and deployment evidence.

The explicit Electron 43.3 / ABI148 source regression removes the inherited RunAsNode flag before exercising actual encrypted Store writes, disabled-fence restart, parent SIGKILL recovery and lock-worker loss. It verifies the private process launch, without claiming a packaged Desktop profile or native identity-provider acceptance test.

## Consequences

Actual wire support is the installed SDK 1.29.0 Streamable HTTP initialize lane, including protocol 2025-11-25. Modern server/discover and machine credential storage on platforms without Linux flock remain unimplemented. Local disconnect fencing is separate from remote Token revocation; the result is reported independently as confirmed or remote_revocation_unconfirmed, and a re-enable UI remains deferred. Public discovery and encrypted credential storage add no model-visible text or credentials.
