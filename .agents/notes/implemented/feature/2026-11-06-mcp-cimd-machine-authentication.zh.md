# Agent Note: MCP 的显式 CIMD 机器认证

Status: implemented

[English](2026-11-06-mcp-cimd-machine-authentication.md) | 中文

## Problem

静态 MCP Header 无法向陌生 CIMD AS 取得可续期且绑定资源的机器凭据，也不能协调本地身份许可与连接释放。

## Decision

[MCP 客户端](../../../../packages/mcp/mcp-client/README.zh.md)增加显式 client-credentials 模式，先验证公开发现，再由公共身份服务授予目标绑定的本地 signer lease。SDK 只接收 fetch adapter，不接收 OAuth provider，因此此模式不会进入浏览器、授权码、DCR 或 refresh 流程。stdio 与已有显式 Header 保持独立入口。

每个 Token flight 固定同一个 target、lease、generation、partition，签名、Token 交换、加密提交和实际资源发送均复核该快照。凭据隔离包含发布 key/version 与政策代次。Linux 内核锁串行化持久变更；持锁 worker 执行写入及原子 rename，其死亡使延迟的父操作不能覆盖更新的禁用 fence。重启重新申请 Token，不信任旧墙钟寿命。

私有持锁 worker 使用当前 Host 的可执行程序。在 Electron 中，worker 检查 `process.versions.electron` 后在自己的环境显式设置 RunAsNode；Desktop 清除继承标志也不影响 holder 启动。该环境仅用于内部 worker，系统提供 `flock` 的前提仍明确保留。

全 Host connectionId 是持久逻辑连接身份。版本化 globalThis Symbol.for registry 在任何 scope、root、state目录或 package 副本中拒绝重复 id，opaque owner token 仅能释放自身；重启不生成新 id 绕过持久禁用。既有 Agent scoped serverName 和附件实现保持独立。机器 direct profile 在发请求或签名前查询既有 proxyRouteFor；需要代理时明确 unsupported，不暗中绕代理。

显式启用的 Host 服务把认证 Session 与 SDK supervisor 作为一个生命周期管理。独立加载的用户 Remote 经既有受保护 Gateway 调用；服务只绑定运营 allowlist 内实际安装的 manager Context，当前 MCP Context 仍是 C 的独立 signer 权限主体。模型工具不接受管理动作或 consumer 名称。省略 HTTP 认证和显式 none 选择既有 Header transport；可选 union 不用 object 默认值生成不完整机器配置。

断开先持久化禁用 fence，再等待 Token flight、SDK transport 和工具停止；普通卸载保留状态。重新启用先重新发现并取得当前 C lease，再以 CAS 替换观察到的禁用代次且不保留旧密文。唯一 activation id 允许本地写入结果不确定时条件回滚，不会禁用另一进程成功的新 activation。管理权限跨 await 检查至 SDK 初始化和工具同步完成；脱敏状态区分 binding、Token 与实际 supervisor ready。专用 UI 不属于这些 Host/Remote 入口。

## Alternatives considered

**读取 opaque scopeKey 的 id 或继承 initiator** 无法证明当前新建 Agent 的身份：setup 期间 initiator 可能是父 Agent，scopeKey 也不承诺属性。连接采用明确的 Host 全局标识和实际 constructor 所有权。

**静态 Authorization Header** 无法续期，也无法绑定独立验证的发现与许可代次。

**SDK OAuth provider** 包含超出机器模式范围的交互及动态注册流程。自定义 fetch 保留 SDK MCP 处理而不启用这些流程。

**按时间判过期的目录锁** 无法证明旧 writer 已停止。独立 holder 加父进程写入同样允许 holder 死后旧父写入，因此 rename 由 holder 自己执行。

## Verification

包测试覆盖 Token flight 不可变代次、签名中撤销、断开 admission、进程或 holder 死亡及真实 DNS/TLS socket。[headless 机器场景](../../../../snapshots/session/mcp-machine/snapshot.yml)启动生产插件、SDK 与 agent loop，固定 keyless 会话 transcript，并验证资源 401 不自动重放。外部身份与 AS/RS fixture 和产品 E2E、部署证据分别记录。

显式 Electron 43.3 / ABI148 源码回归在移除继承的 RunAsNode 标志后执行真实加密 Store 写入、禁用 fence 重启、父进程 SIGKILL 恢复及持锁 worker 死亡。它验证私有进程启动，不冒称已完成安装包 Desktop profile 或 native 身份 provider 验收。

## Consequences

实际 wire 是 SDK 1.29.0 的 Streamable HTTP initialize，包括 2025-11-25。现代 server/discover 和无 Linux flock 平台的机器凭据存储尚未实现。本地断开 fence 与远端 Token 撤销分别处理，撤销结果独立报告 confirmed 或 remote_revocation_unconfirmed，专用设置 UI 尚待实现。公开发现及加密存储不向模型添加文本或凭据。
