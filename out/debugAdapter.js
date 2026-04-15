"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARDDebugAdapterFactory = void 0;
//src/debugAdapter.ts
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const gdbDebugSession_1 = require("./gdbDebugSession");
class ARDDebugAdapterFactory {
    constructor(context) {
        this.context = context;
        this.gdbSession = new gdbDebugSession_1.GDBDebugSession(context);
    }
    createDebugAdapterDescriptor(session, executable) {
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
        return new vscode.DebugAdapterExecutable('node', [adapterScript], {
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
        });
    }
    getActiveSession() {
        return this.gdbSession;
    }
    dispose() {
        this.gdbSession.dispose();
    }
}
exports.ARDDebugAdapterFactory = ARDDebugAdapterFactory;
//# sourceMappingURL=debugAdapter.js.map