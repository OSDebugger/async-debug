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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const debugAdapter_1 = require("./debugAdapter");
const asyncInspectorPanel_1 = require("./webview/asyncInspectorPanel");
const breakpointGroups_1 = require("./breakpointGroups");
let inspectorPanel;
let whitelistWatcher;
// Substitute common VS Code variables in a string from launch.json.
// VS Code does not substitute variables when you read launch.json via the API.
function variablesSubstitution(str) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspace = workspaceFolders?.length ? workspaceFolders[0] : undefined;
    str = str.replace(/\${workspaceFolder}/g, workspace?.uri.fsPath ?? '');
    str = str.replace(/\${workspaceFolderBasename}/g, workspace?.name ?? '');
    str = str.replace(/\${userHome}/g, process.env.HOME ?? process.env.USERPROFILE ?? '');
    str = str.replace(/\${env:(.*?)}/g, (_, key) => process.env[key] ?? '');
    return str;
}
function activate(context) {
    console.log('ARD Debug Adapter extension is now active');
    // Create and register debug adapter factory
    const debugAdapterFactory = new debugAdapter_1.ARDDebugAdapterFactory(context);
    const disposable = vscode.debug.registerDebugAdapterDescriptorFactory('ardb', debugAdapterFactory);
    context.subscriptions.push(disposable, debugAdapterFactory);
    // Register DebugAdapterTracker EARLY — before any session starts —
    // so that stopped events from the very first session are captured.
    const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('ardb', {
        createDebugAdapterTracker: (_session) => {
            return {
                onDidSendMessage: (message) => {
                    if (message.type === 'event' && message.event === 'stopped') {
                        if (inspectorPanel) {
                            inspectorPanel.onDebugStopped(_session, message.body);
                        }
                    }
                    if (message.type === 'event' && message.event === 'showInformationMessage') {
                        vscode.window.showInformationMessage(message.body);
                    }
                    if (message.type === 'event' && message.event === 'showErrorMessage') {
                        vscode.window.showErrorMessage(message.body);
                    }
                }
            };
        }
    });
    context.subscriptions.push(trackerDisposable);
    // Register command to open async inspector
    const openInspectorCommand = vscode.commands.registerCommand('ardb.openInspector', () => {
        if (!inspectorPanel) {
            inspectorPanel = asyncInspectorPanel_1.AsyncInspectorPanel.createOrShow(context.extensionUri);
        }
        else {
            inspectorPanel.reveal();
        }
    });
    // Register command to trace function from editor
    const traceFunctionCommand = vscode.commands.registerCommand('ardb.traceFunction', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }
        const selection = editor.selection;
        const document = editor.document;
        const wordRange = document.getWordRangeAtPosition(selection.active);
        if (!wordRange) {
            vscode.window.showWarningMessage('No symbol at cursor');
            return;
        }
        const symbol = document.getText(wordRange);
        const debugSession = vscode.debug.activeDebugSession;
        if (!debugSession || debugSession.type !== 'ardb') {
            vscode.window.showWarningMessage('No active ARD debug session');
            return;
        }
        try {
            await debugSession.customRequest('ardb-trace', { symbol });
            vscode.window.showInformationMessage(`Tracing function: ${symbol}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to trace function: ${error}`);
        }
    });
    // -----------------------------------------------------------------------
    // OS debug commands
    // -----------------------------------------------------------------------
    // Read border_breakpoints from launch.json and set them in the debug session
    const setBorderBreakpointsCmd = vscode.commands.registerCommand('ardb.setBorderBreakpointsFromLaunchJSON', () => {
        const config = vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders?.[0].uri);
        const configurations = config.get('configurations') ?? [];
        const borders = configurations[0]?.border_breakpoints ?? [];
        for (const b of borders) {
            const border = new breakpointGroups_1.Border(variablesSubstitution(b.filepath), b.line);
            const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(border.filepath), new vscode.Position(border.line - 1, 0)), true);
            vscode.debug.addBreakpoints([bp]);
            vscode.debug.activeDebugSession?.customRequest('setBorder', border);
        }
        vscode.window.showInformationMessage('Border breakpoints from launch.json set.');
    });
    // Read hook_breakpoints from launch.json and set them in the debug session
    const setHookBreakpointsCmd = vscode.commands.registerCommand('ardb.setHookBreakpointsFromLaunchJSON', () => {
        const config = vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders?.[0].uri);
        const configurations = config.get('configurations') ?? [];
        const hooks = configurations[0]?.hook_breakpoints ?? [];
        for (const h of hooks) {
            const hook = {
                breakpoint: {
                    file: variablesSubstitution(h.breakpoint.file),
                    line: h.breakpoint.line,
                },
                behavior: {
                    functionArguments: variablesSubstitution(h.behavior.functionArguments ?? ''),
                    functionBody: variablesSubstitution(h.behavior.functionBody ?? ''),
                    isAsync: h.behavior.isAsync ?? false,
                },
            };
            const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(hook.breakpoint.file), new vscode.Position(hook.breakpoint.line - 1, 0)), true);
            vscode.debug.addBreakpoints([bp]);
            vscode.debug.activeDebugSession?.customRequest('setHookBreakpoint', hook);
        }
        vscode.window.showInformationMessage('Hook breakpoints from launch.json set.');
    });
    // Right-click a breakpoint in the editor gutter → set it as a border
    const setBreakpointAsBorderCmd = vscode.commands.registerCommand('ardb.setBreakpointAsBorder', (...args) => {
        const fullpath = args[0]?.uri?.fsPath;
        const lineNumber = args[0]?.lineNumber;
        if (!fullpath || !lineNumber)
            return;
        vscode.debug.activeDebugSession?.customRequest('setBorder', new breakpointGroups_1.Border(fullpath, lineNumber));
    });
    // Disable a border (breakpoint stays, just no longer acts as a border)
    const disableBorderCmd = vscode.commands.registerCommand('ardb.disableBorderOfThisBreakpointGroup', (...args) => {
        const fullpath = args[0]?.uri?.fsPath;
        const lineNumber = args[0]?.lineNumber;
        if (!fullpath || !lineNumber)
            return;
        vscode.debug.activeDebugSession?.customRequest('disableBorder', new breakpointGroups_1.Border(fullpath, lineNumber));
    });
    // Remove all breakpoints from both VS Code UI and GDB
    const removeAllBreakpointsCmd = vscode.commands.registerCommand('ardb.removeAllCliBreakpoints', () => {
        vscode.commands.executeCommand('workbench.debug.viewlet.action.removeAllBreakpoints');
        vscode.debug.activeDebugSession?.customRequest('removeAllCliBreakpoints');
        vscode.window.showInformationMessage('All breakpoints removed.');
    });
    context.subscriptions.push(openInspectorCommand, traceFunctionCommand, setBorderBreakpointsCmd, setHookBreakpointsCmd, setBreakpointAsBorderCmd, disableBorderCmd, removeAllBreakpointsCmd);
    // Open inspector automatically when debug session starts + setup whitelist watcher
    const onDidStartDebugSession = vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === 'ardb') {
            if (!inspectorPanel) {
                inspectorPanel = asyncInspectorPanel_1.AsyncInspectorPanel.createOrShow(context.extensionUri);
            }
            // Setup whitelist file watcher
            const workspaceFolder = session.workspaceFolder?.uri.fsPath;
            if (workspaceFolder) {
                const whitelistPath = path.join(workspaceFolder, 'temp', 'poll_functions.txt');
                whitelistWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(whitelistPath), path.basename(whitelistPath)));
                whitelistWatcher.onDidChange(async () => {
                    try {
                        await session.customRequest('ardb-execute-command', {
                            command: 'ardb-load-whitelist',
                        });
                    }
                    catch (error) {
                        console.error('Failed to reload whitelist:', error);
                    }
                });
            }
        }
    });
    context.subscriptions.push(onDidStartDebugSession);
    // Clean up when debug session ends
    const onDidTerminateDebugSession = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.type === 'ardb') {
            if (whitelistWatcher) {
                whitelistWatcher.dispose();
                whitelistWatcher = undefined;
            }
            if (inspectorPanel) {
                inspectorPanel.dispose();
                inspectorPanel = undefined;
            }
        }
    });
    context.subscriptions.push(onDidTerminateDebugSession);
}
function deactivate() {
    if (whitelistWatcher) {
        whitelistWatcher.dispose();
        whitelistWatcher = undefined;
    }
    if (inspectorPanel) {
        inspectorPanel.dispose();
        inspectorPanel = undefined;
    }
}
//# sourceMappingURL=extension.js.map