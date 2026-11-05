# Agent Note：Electron 中的物理文件系统 IO

Status: implemented

[English](2026-11-06-electron-physical-filesystem.md) | 中文

## Problem

Electron 将 ASAR 路径视为虚拟目录。在 Electron 43.3 中，这些路径的 bigint 元数据请求返回合成的 number Stats，既没有纳秒时间戳，inode 值也不稳定。本地文件系统后端依赖 realpath 身份与物理元数据生成版本标识；将虚拟元数据与内核写入混合会破坏该合同，并可能在目录列举完成前抛错。

## Decision

[本地后端](../../../../packages/fs/fs-local/README.zh.md)仅在实际进程具有 `process.versions.electron` 时选择 Electron 内置 `original-fs`。回调流和全部基于 Promise 的 IO 操作使用同一物理实现；缺失 `original-fs` 则明确失败。普通 Node 继续使用既有 `node:fs` 与 `node:fs/promises` 实现。

对此提供方而言，ASAR 归档是物理普通文件，虚拟成员不能解析为宿主路径。不改变全局文件系统方法或 `process.noAsar`。Electron 常规模块和资产加载器保留虚拟归档访问，相关语义见[官方 ASAR 文档](https://www.electronjs.org/docs/latest/tutorial/asar-archives)。

## Alternatives considered

**仅把 mode 转成 number** 仍会将缺失时间戳和合成 inode 的变化写进版本标识。虚构纳秒不能恢复物理身份。

**忽略某个 stock 归档或全局关闭 ASAR**，要么使其他宿主归档继续失败，要么改变提供方之外的模块和资产加载。

## Verification

显式 Linux Electron 43.3 / ABI148 源码回归复现原始 BigInt/number 错误，检查物理归档元数据与重复版本、父目录列举、虚拟成员不存在、有界字节流、符号链接身份、原子条件写入和旧版本写入拒绝。并行断言通过常规 Node fs 与 require 读取同一虚拟成员，确认 `process.noAsar` 不变。既有 Node 文件系统、IO 故障和原生边界单位测试保留独立覆盖。

## Consequences

此修改恢复物理 IO 的选择，不增强既有进程本地写锁，也不消除外部 writer 替换竞态。包文档中的元数据及跨进程限制继续保留。Electron 安装包仍须通过所属制品 smoke，源码提供方证据不替代该检查。
