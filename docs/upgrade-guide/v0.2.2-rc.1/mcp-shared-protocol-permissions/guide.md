---
kind: upgrade-guide
description: "Domain MCP requires the shared Identity policy API and original-domain-bound connection ids."
---

# Domain MCP shared permissions

English | [中文](guide.zh.md)

## Change

The optional domain connector requires matching Identity Host policy methods; older Hosts return `protocol_policy_required`. Read/write and domain rules control execution, rather than a fixed `protocol.read` name. Omitted scopes select one unambiguous advertised read scope. `mcp_call_once` still uses one isolated SDK lifetime but may run without another dialog when the saved rule allows it. Unknown effects, payments and extra privileges still require confirmation.

Connection ids include the original discovery origin. Old encrypted records and keys remain untouched; aliases do not share connections merely because they discover the same endpoint. Explicitly configured MCP servers remain outside the domain policy unless their integration supplies the required checks.

A saved default identity change advances its admission epoch. Reconnect explicitly to adopt it; old in-flight operations cannot switch identity. The Identity manager also offers Agent configuration tools with one persistent-change confirmation. Disconnect and credential-history fences still apply.

## Migration

1. Stop the previous profile normally so transports can close and attempt token revocation. Preserve the profile, credential store, identities and authorization history; do not delete ciphertext or replace missing keys.
2. Install matching Identity, PAP/ANP and Harness builds together. Retain the one-time `domainAccess` and connector `enabled` opt-ins. Use Protocol Management for read/write rules and exact whitelists; its service directory grants no permission.
3. Call `mcp_connect` with the original domain. Use registered `mcp__` tools for a ready persistent connection, or returned operation references with `mcp_call_once` for `one-shot-discovery`. For ambiguous selection, choose only necessary scopes from `availableScopes`, not every advertised scope or a global configuration change.
4. Verify a denied operation sends no business request, and correlate an allowed test write with its response/readback. Never retry unknown writes. Retain protected history when `credentialRevocation` is unconfirmed. Disable adapters before downgrading; older builds cannot enforce the shared settings file.
