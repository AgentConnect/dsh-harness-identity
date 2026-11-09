---
kind: upgrade-guide
description: "域名 MCP 需要共享 Identity 策略 API，连接 ID 绑定原始发现源。"
---

# 域名 MCP 统一权限

[English](guide.md) | 中文

## 变更

可选域名连接器需要匹配的 Identity Host 策略方法，旧 Host 返回 `protocol_policy_required`。执行由读写和域名规则控制，不依赖固定 `protocol.read` 名称；省略 scopes 时选择唯一的服务端读取 scope。`mcp_call_once` 仍使用一次隔离 SDK 生命周期，但保存规则允许时不重复弹窗。未知效果、支付和额外权限仍单独确认。

连接 ID 包含原始发现源。旧加密记录和密钥不变，别名不会仅因发现相同地址而共享连接。原显式 MCP 服务器不自动受域名规则管理，除非其集成提供相应检查。

保存默认身份会推进准入版本。请显式重新连接后采用新版本；在途请求不能切换身份。Identity 管理器同时提供 Agent 配置工具，持久修改在会话内确认一次。持久断开和凭据历史边界仍然有效。

## 迁移

1. 正常停止旧 profile，让传输关闭并尝试撤销 token。保留 profile、凭据存储、身份和授权历史，不删除密文或替换缺失密钥。
2. 同步安装匹配的 Identity、PAP/ANP 与 Harness，保留一次性 `domainAccess` 和连接器 `enabled`。在“协议管理”配置读写规则和精确白名单，服务目录不授予许可。
3. 使用原始域名调用 `mcp_connect`；持久连接就绪时使用 `mcp__` 工具，返回 `one-shot-discovery` 时使用操作引用调用 `mcp_call_once`。有歧义时，从 `availableScopes` 选择必要权限，不申请全部 scope 或修改全局配置。
4. 验证禁止操作未发送业务请求，允许的测试写入可由响应和回读关联。未知写入不重试，`credentialRevocation` 未确认时保留受保护历史。降级前禁用适配器，旧构建不能执行共享设置文件。
