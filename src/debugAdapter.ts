//src/debugAdapter.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { GDBDebugSession } from './gdbDebugSession';

export class ARDDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    private gdbSession: GDBDebugSession;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.gdbSession = new GDBDebugSession(context);
    }

    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const config = session.configuration;
        const workspaceFolder = session.workspaceFolder?.uri.fsPath || process.cwd();

        const extensionPath = this.context.extensionPath;
        const pythonPath = extensionPath;
        const tempDir = path.join(workspaceFolder, 'temp');
        const adapterScript = path.join(extensionPath, 'out', 'gdbAdapter.js');

        const gdbPath = config.gdbPath || 'gdb';
        const targetRemote = config.targetRemote || '';
        const gdbArch = config.gdbArch || '';
        const adapterCwd = config.cwd || workspaceFolder;

        return new vscode.DebugAdapterExecutable(
            'node',
            [adapterScript],
            {
                cwd: adapterCwd,
                env: {
                    ...process.env,
                    ARDB_PROGRAM: config.program,
                    ARDB_ARGS: JSON.stringify(config.args || []),
                    ARDB_CWD: adapterCwd,
                    PYTHONPATH: pythonPath,
                    ASYNC_RUST_DEBUGGER_TEMP_DIR: tempDir,
                    ARDB_GDB_PATH: gdbPath,
                    ARDB_TARGET_REMOTE: targetRemote,
                    ARDB_GDB_ARCH: gdbArch,
                }
            }
        );
    }

    getActiveSession(): GDBDebugSession {
        return this.gdbSession;
    }

    dispose() {
        this.gdbSession.dispose();
    }
}