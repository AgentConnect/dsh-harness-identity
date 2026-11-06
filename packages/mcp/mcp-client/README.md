---
description: "MCP client bridge for deployments and maintainers choosing, configuring, or debugging connections to external MCP servers whose tools register on ctx.tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-client

English | [中文](README.zh.md)

## Summary

`dsh-mcp-client` lets the model call tools from external Model Context Protocol (MCP) servers as native harness tools. Configure one server per entry, and its tools appear under stable names such as `mcp__github__create_issue`. Use it for filesystem, GitHub, database, memory, or other MCP tool servers; no server is enabled by default. Tool definitions add tokens to every model request, while a slow or crashed server can delay startup or make its tools fail until recovery. The package bridges tools only; MCP resources and prompts are unsupported.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add `dsh-mcp-client` when the model should call tools from an external MCP server as if they were native. One configuration entry per server is the entire setup: give the server a short unique name and a transport, and its tools appear as `mcp__<serverName>__<tool>`. Choose stdio when the server runs as a local program and Streamable HTTP when it runs as a service. If you already use MCP tool servers from another client, the same server rows work here.

### Minimal configuration

Add one entry per server; nothing else is required. After the harness starts, the server's tools appear in the model's tool list.

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

| Field | Default | Meaning |
|---|---|---|
| `transport` | required | `stdio` or `streamable-http` |
| `serverName` | required | Namespace for the server's tool names; `[A-Za-z0-9_-]{1,32}`, unique inside one registration scope |
| `command` / `args` / `env` / `cwd` | — | stdio: executable, arguments, extra env merged over scrubbed ambient env, working directory |
| `url` / `headers` | — | streamable-http: endpoint URL and extra request headers |
| `toolCallTimeoutMs` | `60,000` | Timeout per `tools/call` invocation |
| `failOnStartupError` | `false` | Reject plugin activation when the initial connection or tool synchronization fails |
| `reconnect.enabled` | `true` | Reconnect automatically after a lost connection |
| `reconnect.initialDelayMs` | `500` | First reconnect delay; doubles per consecutive failed attempt |
| `reconnect.maxDelayMs` | `30,000` | Backoff ceiling; also the uptime after which the attempt budget resets |
| `reconnect.maxAttempts` | `10` | Consecutive failed attempts per outage before giving up |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-client) is the exhaustive source for every accepted field.

After startup, the server's tools appear as `mcp__<serverName>__<tool>` — try a prompt that uses one. If the initial connection fails, the harness still starts but no tools from that server appear, and an error is logged; set `failOnStartupError: true` to make a startup failure abort the harness instead.

<a id="cimd-machine-authentication"></a>
### CIMD machine authentication

Omitted authentication and explicit `authentication.mode: none` retain the existing HTTP headers path. Streamable HTTP can explicitly select `authentication.mode: cimd-client-credentials`. Provide a published `identityRef`, approved `policyRef`, nonempty minimum `requestedScopes`, absolute protected `stateRoot`, and `encryptionKeyRef` naming a Host credential with a 32-byte base64url encryption key. An optional exact `issuer` selects one AS when resource metadata lists several. The shared local identity service binds the installed consumer Context to its policy and supplies only a target-bound signer lease; private identity keys remain local.

`connectionId` is a persistent Host-wide logical connection identifier, distinct from `serverName`. Different Agents may reuse a server name with different connection ids. A versioned process registry rejects the same connection id in any scope, app root, state directory or loaded package copy before discovery or signing. This conservative Host contract retains ownership until quiescent disposal, including failed initialization. An opaque owner token prevents an old disposer from releasing the next owner. Reloading the same logical connection reuses its configured id; a restarted process still reads the original persistent disabled fence. Multiple processes sharing one protected directory and id operate the same logical connection and its generation, not independent Agent connections.

Discovery reads public protected-resource and AS metadata without credentials, fixes one exact resource and issuer, and requires explicit CIMD, client_credentials, private_key_jwt and ES256 support. The only Token exchange uses a fresh local assertion with the exact issuer audience. There is no browser, authorization-code, DCR, anonymous-authentication or refresh fallback. Managed Host, Authorization, Proxy-Authorization, Cookie, DPoP and Poppy-Session headers are rejected in this mode.

Machine HTTPS uses the existing Host `proxyRouteFor` authority. This profile implements validated, DNS-pinned direct connections only: an active proxy route fails with `proxy_egress_unsupported` before identity admission or signing; it never silently connects directly. A NO_PROXY destination still passes the direct address/TLS checks. Existing stdio and non-machine HTTP proxy behavior retains its original path. Each direct request pins a public DNS answer to a new verified TLS socket, bounds DNS/upload/response waits and sizes, rejects credential redirects, and validates exact JSON MIME, duplicate names, UTF-8 and BOM.

Tokens remain opaque Bearer values with bounded expiry and sufficient requested scopes. The complete connection/identity/publication/issuer/resource/discovery/scope/policy partition isolates encrypted storage and single-flight acquisition. Each Token task captures one immutable binding, and commit and physical send recheck its generation and local permission. Linux kernel locking serializes updates; the lock-owning worker writes, fsyncs and renames encrypted data itself. Killing that worker cannot let an old parent revive a disabled fence, and broken stdin is contained. Disconnect stops admission before the first await, persists the disabled fence, aborts and drains tasks, and independently reports trusted-endpoint revocation as confirmed or remote_revocation_unconfirmed. A resource 401 fails the current operation without replay; only the next explicit operation may acquire a new Token.

An operation starting after discovery expiry re-fetches and validates public metadata and the current signer lease before its first tool guard. Result projection retains the existing generation, expiry and permission checks; expiry during an in-flight operation fails closed without replaying the business call.

The Host-only `MachineAuthenticationSession` export offers sanitized `status()` and `dispose(true)` for its own connection. Authentication adds no model text or credentials; tool schemas, scoped registration, attachments and result rendering use the existing paths below. The pinned SDK is 1.29.0; this mode uses Streamable HTTP initialize and protocol 2025-11-25, without a 2026 server/discover implementation.

The opt-in `management` and `management-remote` entries expose connection status, disconnect and explicit enablement to the Host’s authenticated user client. Compose them beside the existing Typert Gateway; the management allowlist denies every manager by default:

```yaml
- name: '@deepseek-ai/dsh-mcp-client/management'
  config:
    managerConsumers: ['@deepseek-ai/dsh-mcp-client/management-remote']
- name: '@deepseek-ai/dsh-mcp-client/management-remote'
```

A machine row can require `inject: [mcpConnections, anpIdentity, credentials]` so the Loader makes all three providers available before activation. The protected user endpoints are `mcpConnections/status`, `mcpConnections/disconnect` and `mcpConnections/enable`, each accepting only `{ connectionId }`. Status separates identity binding, usable Token and actual SDK/tool readiness, and returns no URLs or credentials. The manager verifies the installed Remote Context on every operation; C separately verifies the installed MCP consumer and its current policy.

Explicit disconnect persists a disabled generation, aborts pending work, closes the SDK and removes its tools. Reload and process unload retain the durable state. A disabled row remains queryable after reload without contacting the resource or taking a signer lease. Explicit enablement repeats public discovery, current C authorization and SDK/tool connection; a failed attempt keeps the disabled fence. Operation ownership prevents a failed old activation from disabling a concurrent successor. Restart cannot recover proof of a previous remote revocation and reports it as unconfirmed. A dedicated settings card and ACP identity binding are not provided by these Host entries.

The machine plugin masks known bearer values and actual signed client assertions in tool names, descriptions, schemas, result strings and JSON keys, error text and connection logs. A narrow guard also recognizes the fixed ES256 client-auth assertion claims for a client_id confirmed by C, including expired complete assertions after reconstruction; business JWTs with other identities, claim sets or token types retain their data. The SDK wire remains unchanged, and asynchronous projection rechecks the current SDK generation, connection fence and C lease.

Bearer records, completeness and migration qualifications share a mandatory authenticated envelope, including fresh empty history. Its AES-GCM AAD binds the purpose, connection and current Token frame; plaintext advisory fields cannot qualify history. Sending a bearer requires its history write to finish first; output processing reloads history. Token replacement, clear, disable and enable preserve known material. Restart conservatively starts each loaded receipt’s complete advertised lifetime plus 30 seconds on a fresh monotonic clock. In-flight SDK operations pin retention. Expired receipt versions are removed by CAS, preserving concurrent replacements, the disabled fence and retry limits. Memory retains at most 256 values and 1 MiB; persisted history retains at most 256 records and 1 MiB of serialized plaintext before encryption. Exhaustion stops new sending instead of dropping possibly valid values.

Schema 2 retains legacy enablement, generation and ciphertext but marks unknown prior history incomplete. Such a connection remains visible with historyState and migrationId while SDK/tools stay stopped. Missing decryption keys do not create a replacement master or erase old ciphertext. Changing connectionId/stateRoot or revoking only the latest Token does not establish complete history. The Host management legacyRecovery array defaults to empty and accepts exact connectionId/migrationId, a closed kind and evidenceRef only from trusted operator configuration; Remote requests still contain only connectionId. prior-bearers-invalidated records an operator’s evidence covering all earlier Tokens, not an SDK verification. old-writers-stopped requires that evidence plus 86431 seconds of monotonic isolation before a later explicit enable; reconstructing the Host restarts that conservative interval. Recovery never implicitly enables a disabled connection.

Under Electron, the internal Linux lock worker explicitly uses RunAsNode only when the current Host reports `process.versions.electron`. It does not depend on an inherited environment flag or change other child-process launch modes. The Store still requires the system `flock` executable.

### Tool naming and coexistence

The model sees each tool under a stable server-qualified name: `mcp__<serverName>__<rawName>`, for example `mcp__github__create_issue` — the same naming shape Claude Code and Codex use. Names stay stable while the server keeps the same tool name, so session history and permission rules survive restarts and reloads. Two servers can both offer a tool named `search` and coexist as `mcp__github__search` and `mcp__web__search`.

- Two servers publishing the same tool name (for example `search`) coexist under their own namespaces.
- Two entries using the same server name: the later one fails to load with a clear error.
- A server that lists the same tool twice gets its tool list rejected as invalid, and the previous tool set stays active.
- A repeated non-empty `tools/list` continuation cursor rejects that update immediately, including cycles through empty pages; the previous tool set stays active and later updates can still succeed.
- An update that conflicts with an already-registered tool name is rejected entirely — you never get a partial tool set from that server.

### Calling tools and reading results

When the model calls an MCP tool, the call runs against the remote server with a per-call timeout (default 60 seconds) and can be cancelled like any other tool call. The result comes back as ordinary text in block order; resource links appear as text with their name and URI. If the server reports an error, the call fails visibly — the model does not see a fake success.

Images are supported when the current model accepts image input and the harness attachment feature is enabled; they then appear in the conversation like other images. Otherwise — and for audio or embedded resources — the model sees a clear diagnostic message instead of nothing.

### Startup, updates, and reconnection

The server's tools appear before the harness starts its first turn. When the server changes its tool list, the model's tool set updates automatically; if the update fails, the previous tool set keeps working.

When a server connection drops — for example a local server process crashes — the plugin reconnects automatically with delays that double from 500 ms up to 30 s and then refreshes the tool set; reconnect progress is visible in the logs. During an outage the last known tools stay listed but calls to them fail until the server recovers. After ten consecutive failed attempts the server's tools are removed and reconnection stops until you reload the configuration or restart the harness; a server that stays connected for a while resets that counter. Set `reconnect.enabled: false` to disable automatic reconnection — tools then stay listed but fail until you reload. Editing the configuration entry reloads the server connection in place, and unchanged names stay unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the bridge and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Server-qualified identity.** Every MCP tool has the stable identity `(serverName, rawName)`. The namespace is local configuration, never the remote `serverInfo.name` — the remote name is untrusted, not unique across deployments, and can change on upgrade, none of which may silently rename model-facing tools.
- **Naming is a pinned contract.** Public names are pure functions of `(serverName, rawName)` and satisfy the DeepSeek function-name contract; lossy normalization appends a 12-hex-char SHA-256 hash so distinct identities never collapse. Session history and permission rules therefore survive HMR swaps, re-syncs, and other servers' changes.
- **The raw name is the only wire name.** `tools/call` always receives the raw name; the public name is never sent to the server and never parsed to recover the raw name.
- **Full generation or none.** Syncs swap generations atomically: a fetch failure keeps the previous generation, and a registration conflict rolls back the entire attempted generation.
- **One canonical value, one projection.** The executor returns the protocol-complete canonical `McpResult`; a separate ordered projection prepares Native content, and `finalizeContent` installs it only when the registry's post-execute result is unchanged, so policy blocks and value replacements stay authoritative.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `serverName` reservation, activation await |
| [`src/connection.ts`](src/connection.ts) | Connection supervisor: client generations, reconnect policy, attempt budget, disposal |
| [`src/tools.ts`](src/tools.ts) | Tool bridge: discovery, naming, registration swap, execution, image projection |
| [`src/transport.ts`](src/transport.ts) | Transport factory: stdio spawn with scrubbed env, Streamable HTTP |
| — | No runtime invariant companion is published; MCP generations contribute through the tool registry, but the bridge exposes no independent server-to-tool snapshot after an asynchronous resync. |

### Lifecycle and sync

`apply` resolves the reconnect policy, reserves the `serverName` inside the current registration scope, starts the supervisor, and awaits the initial connection plus discovery. Independent Agent scopes may reuse the same namespace because their tools and transports are isolated; a duplicate inside one scope fails at load. The supervisor serializes every sync — initial, notification, and reconnect — through one queue so two syncs can never interleave their dispose-previous/register-next swap. Disposal cancels pending reconnects, closes the live client, waits for the in-flight attempt and queued syncs to quiesce, and unregisters the current generation.

The supervisor listens for `notifications/tools/list_changed` and queues a re-sync; a fetch-phase failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation. Each outage shares one attempt budget: after `maxAttempts` consecutive failures the tools are unregistered and reconnection stops, and a connection that stays up past `maxDelayMs` resets the budget.

### Tool execution internals

A tool call sends an uncached `tools/call` request carrying the raw MCP name, the JSON arguments, the abort signal, and the configured timeout; the public name is never sent to the server and never parsed back. Canonical success is `{ content: JsonValue[], structuredContent? }`, preserving the complete MCP JSON blocks for programmatic and PTC mode callers. A supported advertised `outputSchema` validates `structuredContent`; unsupported schema vocabulary falls back to unconstrained `JsonValue`. An MCP `isError` result throws before any image persistence, so the registry produces a failed tool result. Image batches are decoded and validated as a whole before any member is saved; any refusal projects every image as diagnostic text.

### Environment scrubbing (stdio)

The child environment starts from the subprocess seam's `scrubbedParentEnv()` — ambient names matching `/KEY|PASSWORD|SECRET|TOKEN/i` and ambient `DSH_*` names are dropped — and the configured `env` merges on top, so explicit overrides survive. The MCP SDK owns the actual spawn; this package shares the scrub definition, not the spawn path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared tool registry to the bridge's design evidence and worked example configurations.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `ToolRuntime` and `ctx.tools.register()` contract that receives the bridged tools.
- [CIMD machine authentication decision](../../../.agents/notes/implemented/feature/2026-11-06-mcp-cimd-machine-authentication.md) — local authority, Host-wide connection identity and direct egress.
- [MCP client plugin Agent Note](../../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) — the naming invariants, discovery and execution design, alternatives, and consequences.
- [Canonical tool output contract Agent Note](../../../.agents/notes/implemented/architecture/2026-07-20-canonical-tool-output-contract.md) — how MCP results map into the canonical tool-output contract.
- [Third-party memory MCP guide](../../../docs/user/guide/mcp-memory.md) — three memory-server overlays using this package.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-client) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, every advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form) with the server-provided description and input schema. A successful re-sync — including the one after an automatic reconnect — replaces the generation; plugin disposal or an exhausted reconnect budget removes it.

#### Token effect

The tool descriptions and input schemas enter every request while the tools are registered; re-syncs replace rather than accumulate schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

The tool-definition prefix stays stable while the discovered set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token onward; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. The canonical value retains the complete MCP JSON blocks and optional structured content for programmatic and PTC mode callers; supported image blocks project beside text in their original order after exact route-capability proof. Refused images, audio, embedded resources, resource links, and unknown blocks remain visible as bounded text diagnostics, and MCP `isError` rejects the call before image persistence.

#### Token effect

Arguments, mapped text, and durable image references are retained until compaction. Inline MCP base64 stays only in the execution-local canonical value and is never copied into a session event; the provider reads verified bytes from the attachment store. Audio and embedded-resource payloads stay out of model context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what you cannot do with this plugin and when it needs operational attention. They are current package constraints, not a comparison with other MCP clients or a task backlog.

- **Machine credential storage is Linux-only** — the kernel-lock implementation requires flock and a protected Host encryption credential; other platforms reject this mode.
- **Machine proxy transport is unsupported** — an active Host proxy route fails closed; it is not bypassed or replaced with an unpinned fetch. A re-enable management UI and additional wire lanes remain deferred.
- **Tools are the only bridged MCP capability** — Resources and Prompts have no harness consumer mechanism and are deferred.
- **Startup and discovery timeouts are inherited from the MCP SDK** — the plugin exposes no connection or discovery timeout; each `initialize` and paginated `tools/list` request uses the SDK's 60-second request default, so an unresponsive server or cursor chain can delay both activation and teardown while the initial synchronization settles.
- **Reconnect triggers on transport close** — a crashed stdio child fires it; Streamable HTTP failures surface per request through the SDK transport's own recovery, so an unreachable HTTP server is retried per call rather than respawned by the supervisor.
- **Image is the only durable rich-result bridge** — PNG, JPEG, WebP, and GIF enter Native context after exact capability proof. Audio and embedded-resource payloads remain execution-local with explicit diagnostics, while resource links preserve only their name and URI as text.
- **Unsupported MCP output schemas are not enforced** — `structuredContent` falls back to `JsonValue` when the advertised schema uses vocabulary outside the harness subset.
- **Task-required MCP tools are rejected at call time** — a tool that requires the task-based execution extension throws instead of bridging; the extension is not implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The public-name algorithm is a v1 contract pinned by tests; changing it after release would break session history and permission rules.
- An explicit DSH-owned connection and discovery timeout is an open direction; the SDK's 60-second default bounds startup and teardown.
- Reconnect ownership for Streamable HTTP is open: per-request retry is SDK behavior, and the supervisor could also own the HTTP generation.
- Bridging MCP Resources needs a harness-side injection decision (system prompt, on demand, or model-triggered); bridging Prompts needs a prompt-template concept the harness lacks.
- The pinned MCP SDK is still evolving; a breaking upstream change requires updating the bridge.

</details>
