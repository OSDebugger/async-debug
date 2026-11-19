# Async Debugger 开发日志

OSDebugger 异步调试器开发过程的周记录。记录每周的目标、产出、关键问题排查与知识沉淀。

## 目录

| 周次 | 日期 | 状态 | 摘要 |
|---|---|---|---|
| [2026-W47](./2026-W47.md) | 2026-11-16 ~ 2026-11-19 | solved | 打通 async-os 跨特权级异步调试；修复两个内核寄存器/初始化缺陷 + 一个白名单扫描缺陷 |

## 状态说明

| 状态 | 含义 |
|---|---|
| `solved` | 问题已定位并修复，验证通过 |
| `investigating` | 已定位方向，仍在排查中 |
| `ongoing` | 正常推进，无阻塞问题 |
| `blocked` | 存在外部依赖阻塞，需要协作方确认 |

## 记录规范

- 每个文件按 `YYYY-Wnn.md` 命名（ISO 周）
- 文件头使用 YAML front matter，字段见 [TEMPLATE.md](./TEMPLATE.md)
- 「关键问题」一节按 **现象 → 排查 → 根因 → 解决 → 验证** 五段式展开
- 排查过程要记录**假设、实验、观察**，不只写最终结论
- 「知识沉淀」记录可复用的经验，避免下次重复踩坑

## 相关仓库

| 项目 | 地址 |
|---|---|
| 调试器扩展 | `https://github.com/OSDebugger/async-debug` |
| 调试目标 OS | `https://github.com/AsyncModules/async-os` |
