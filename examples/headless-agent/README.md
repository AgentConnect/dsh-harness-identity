# headless-agent

English | [中文](README.zh.md)

This directory owns the replay and real-model test composition for a headless coding agent: DeepSeek V4 + local bash and filesystem tools + subagent delegation + workflows and fresh-agent Ralph iteration + `todo_write` + JSONL persistence. It explicitly mounts the shared agent spine, one root agent, persistence, and checkpoint policy; it is not a second product entry point.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm dsh --profile headless "fix the failing test in this workspace"
```

The product command is [`dsh --profile headless`](../../apps/cli/README.md): it accepts one nonblank task, creates and persists a fresh session, prints the final assistant text, and exits.

Snapshot suites run this directory's configuration through [`tests/fixtures/headless-driver.ts`](tests/fixtures/headless-driver.ts), an unexported test-only process that emits canonical session events as JSONL before its result record. That stream is test infrastructure, not a supported CLI output format. Child sessions surface only through parent tool events and results.

## E2B POC overlay

[`e2b.cordis.yml`](e2b.cordis.yml) replaces the local filesystem and subprocess providers with one shared E2B sandbox while retaining `dsh-bash-local` and the same model-facing tools. Put `E2B_API_KEY` beside `DEEPSEEK_API_KEY` in the gitignored root `.env`, then run the credential-gated live composition, which drives FS, Bash, PTY, and LSP in one sandbox and proves final deletion:

```sh
pnpm exec vitest run --config vitest.e2e.config.ts packages/e2b/e2b/tests/composition.e2e.ts
```

The overlay creates the same absolute cwd inside the sandbox, but it does not upload or mount the host workspace. File and Bash mutations exist only in E2B; Cordis, model calls, agent/session state, session logs, skills, and SDK buffers remain on the host. The composition kills its sandbox on timeout and disposal. It is a provider-composition POC, not a whole-harness migration or a workspace-sync feature.

## Keyless machine MCP example

[`mcp-machine.cordis.snapshot.yml`](mcp-machine.cordis.snapshot.yml) runs the real headless agent, MCP client plugin, machine authentication session, encrypted credential store and MCP SDK. Its explicit fixtures replace the model, local identity provider and external DNS/HTTPS replies; no remote API, browser, user authorization-code, DCR or refresh-token flow runs. The fixture AS verifies an ES256 client assertion and issues a synthetic resource-bound Token. This proves assembled machine-only behavior, not independent authorization-server interoperability or production key custody.

```sh
node node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts examples/headless-agent/tests/mcp-machine.snapshot.ts
```

The checked-in session transcript records one successful identity read, a sanitized 401 failure without automatic business-call replay, and a separate read that acquires a new machine Token. The wire summary asserts two client-credentials exchanges and three actual tool calls; neither access tokens nor assertions enter the model-visible transcript. The [fixture driver](tests/fixtures/mcp-machine/driver.ts) is runnable through the shared source/lib Loader launcher; lib mode requires the normal built workspace artifacts. The successful machine credential-store scenario currently requires Linux `flock`; other platforms retain the machine plugin's explicit unsupported-storage failure policy. Only Linux replay is validated here.

## Advanced configuration

[`advanced.cordis.yml`](advanced.cordis.yml) adds Code Mode and the Cordis tools to the test composition.
