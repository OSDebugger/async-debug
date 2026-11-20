# async-debug 项目约定

## 仓库结构

- `src/`：VS Code 扩展源码（TypeScript）。`src/backend/` 是 GDB/MI2 协议层，`src/webview/` 是 Async Inspector 面板。
- `async_rust_debugger/`：GDB 内嵌 Python 脚本。`runtime_trace.py` 是异步跟踪核心逻辑，`static_analysis/` 是符号白名单生成。
- `testcases/`：测试用 async-os 内核和用户程序。
- `docs/accepted_design/`：经过评审的稳定设计文档。
- `docs/design_proposals/`：设计提案，带状态字段。模板见 `docs/design_proposals/template.md`。

## 设计流程

新功能或重大改动走提案流程：

1. 在 `docs/design_proposals/` 下创建 `YYYY-MM-DD-<topic>.md`，从 `template.md` 复制模板，状态 Draft。
2. 写完方案后，用 AI 做基础 builder check（一致性、完整性、与现有代码的冲突检查）。AI 不评审方案合理性。
3. 人工 review 后状态改为 Accepted 或 Declined。
4. Accepted 的提案：设计方案提取到 `docs/accepted_design/`，提案保留为决策记录。

## 文档约定

- 稳定设计文档用中文，遵循中文技术文档写作规范（半角空格、全角标点、短句）。
- 提案的日期是原始提交日期，文件名、标题、状态字段三者统一。
- 每个目录下的 README 说明：该目录包含什么、怎么构建、和设计文档的对应关系。

## 提交约定

- commit message 用中文，前缀 `feat:`、`fix:`、`docs:` 等用半角冒号。
- 不提交"暂存"类 WIP commit。
- `.claude_docs/` 和 `.claude/` 目录已在 `.gitignore` 排除——AI 过程记录不入库。