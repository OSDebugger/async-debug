## Async Rust Debugger - Debug Adapter (DA) 使用方法
本项目是一款针对 Async Rust 协程执行流设计的调试适配器（Debug Adapter）。它通过对接 VS Code Debug Adapter Protocol (DAP) 与后端 GDB 脚本，实现了异步调用栈的深度解析与可视化渲染。

#### 1.环境配置 (launch.json)
在需要调试的 Rust 项目根目录下，创建 .vscode/launch.json 并使用以下标准配置。该配置会自动调用插件注册的 ardb 调试引擎。
```JSON
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Rust (ARD)",
      "type": "ardb",
      "request": "launch",
      "program": "${workspaceFolder}/target/debug/${workspaceFolderBasename}",
      "args": [],
      "cwd": "${workspaceFolder}",
      "stopOnEntry": false,
      "console": "internalConsole",
      "preLaunchTask": "cargo build"
    }
  ]
}
```
#### 2. 标准调试流程
为了保证调试上下文与 GDB 状态的同步，请严格遵循以下操作顺序：

###### 第一步：启动插件环境
- 在插件工程源代码中，进入“运行和调试”面板。

- 选择 Extension Development Host 配置并按下 F5。

- 系统将启动一个集成该插件的新 VS Code 窗口。

###### 第二步：激活调试会话
- 在弹出的新窗口中打开待调试的 Rust 项目。

- 按下 F5 启动 Debug Rust (ARD) 配置。

- 系统将自动弹出 Async Inspector 调试面板。

###### 第三步：初始化与白名单配置
- 环境重置 (Reset)：首先点击面板顶部的 Reset 按钮。此操作将初始化后端 GDB 运行环境并同步寄存器状态。

- 生成白名单 (Gen Whitelist)：点击 Gen Whitelist 按钮。插件将自动扫描二进制文件的符号表，识别异步 poll 函数，并自动弹出生成的 poll_functions.txt 文件。

- 设置根追踪点 (Trace)：

1. 检查弹出的白名单文件，可以根据需求手动修改并保存。

2. 在面板右侧的候选列表中选择根函数，点击 Trace 设置异步入口(可设置多个)。

3. 执行追踪：完成上述配置后，通过 VS Code 调试工具栏进行单步跳过或继续运行，即可在左侧实时观察生成的 Async Execution Tree。
