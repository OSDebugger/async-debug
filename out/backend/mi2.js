"use strict";
// Ported from code-debug (os-debug) src/backend/mi2/mi2.ts
// Removed: SSH support, linux/console, prettyPrint utils, IBackend interface
// Adapted for ardb: no SSH, focused on GDB process management + MI parsing + EventEmitter
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
exports.MI2 = void 0;
exports.escape = escape;
const backend_1 = require("./backend");
const ChildProcess = __importStar(require("child_process"));
const events_1 = require("events");
const mi_parse_1 = require("./mi_parse");
const path = __importStar(require("path"));
function escape(str) {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
const nonOutput = /^(?:\d*|undefined)[\*\+\=]|[\~\@\&\^]/;
const gdbMatch = /(?:\d*|undefined)\(gdb\)/;
const numRegex = /\d+/;
function couldBeOutput(line) {
    if (nonOutput.exec(line))
        return false;
    return true;
}
class MI2 extends events_1.EventEmitter {
    constructor(application, preargs, extraargs, procEnv, extraCommands = []) {
        super();
        this.application = application;
        this.preargs = preargs;
        this.extraargs = extraargs;
        this.extraCommands = extraCommands;
        this.features = [];
        this.registerLimit = "";
        this.currentToken = 1;
        this.handlers = {};
        this.breakpoints = new Map();
        this.buffer = "";
        this.errbuf = "";
        this.originallyNoTokenMINodes = [];
        this.tokenCount = 0;
        if (procEnv) {
            const env = {};
            for (const key in process.env)
                if (process.env.hasOwnProperty(key))
                    env[key] = process.env[key];
            for (const key in procEnv) {
                if (procEnv.hasOwnProperty(key)) {
                    if (procEnv[key] === undefined)
                        delete env[key];
                    else
                        env[key] = procEnv[key];
                }
            }
            this.procEnv = env;
        }
    }
    load(cwd, target, procArgs, autorun = []) {
        if (!path.isAbsolute(target))
            target = path.join(cwd, target);
        return new Promise((resolve, reject) => {
            const args = this.preargs.concat(this.extraargs || []);
            this.process = ChildProcess.spawn(this.application, args, { cwd: cwd, env: this.procEnv });
            this.process.stdout?.on("data", this.stdout.bind(this));
            this.process.stderr?.on("data", this.stderr.bind(this));
            this.process.on("exit", () => this.emit("quit"));
            this.process.on("error", err => this.emit("launcherror", err));
            const promises = this.initCommands(target, cwd);
            if (procArgs && procArgs.length)
                promises.push(this.sendCommand("exec-arguments " + procArgs));
            promises.push(...autorun.map(value => this.sendUserInput(value)));
            Promise.all(promises).then(() => {
                this.emit("debug-ready");
                resolve(undefined);
            }, reject);
        });
    }
    // Attach to a running local process (by PID or process name)
    attach(cwd, executable, target, autorun = []) {
        return new Promise((resolve, reject) => {
            if (executable && !path.isAbsolute(executable))
                executable = path.join(cwd, executable);
            const args = this.preargs.concat(this.extraargs || []);
            this.process = ChildProcess.spawn(this.application, args, { cwd: cwd, env: this.procEnv });
            this.process.stdout?.on("data", this.stdout.bind(this));
            this.process.stderr?.on("data", this.stderr.bind(this));
            this.process.on("exit", () => this.emit("quit"));
            this.process.on("error", err => this.emit("launcherror", err));
            const promises = this.initCommands(target, cwd, true);
            if (executable)
                promises.push(this.sendCommand('file-exec-and-symbols "' + escape(executable) + '"'));
            promises.push(this.sendCommand("target-attach " + target));
            promises.push(...autorun.map(value => this.sendUserInput(value)));
            Promise.all(promises).then(() => {
                this.emit("debug-ready");
                resolve(undefined);
            }, reject);
        });
    }
    // Connect to a GDB remote stub (e.g. QEMU gdbserver via "target remote :port")
    connect(cwd, executable, target, autorun = []) {
        return new Promise((resolve, reject) => {
            if (executable && !path.isAbsolute(executable))
                executable = path.join(cwd, executable);
            const args = this.preargs.concat(this.extraargs || []);
            this.process = ChildProcess.spawn(this.application, args, { cwd: cwd, env: this.procEnv });
            this.process.stdout?.on("data", this.stdout.bind(this));
            this.process.stderr?.on("data", this.stderr.bind(this));
            this.process.on("exit", () => this.emit("quit"));
            this.process.on("error", err => this.emit("launcherror", err));
            const promises = this.initCommands(target, cwd, true);
            promises.push(this.sendCommand("target-select remote " + target));
            promises.push(...autorun.map(value => this.sendUserInput(value)));
            Promise.all(promises).then(() => {
                this.emit("debug-ready");
                resolve(undefined);
            }, reject);
        });
    }
    initCommands(target, cwd, attach = false) {
        const debuggerPath = path.posix.isAbsolute(cwd) ? path.posix : path.win32;
        if (!debuggerPath.isAbsolute(target))
            target = debuggerPath.join(cwd, target);
        const cmds = [
            this.sendCommand("gdb-set target-async on", true),
            new Promise((resolve) => {
                this.sendCommand("list-features").then((done) => {
                    this.features = done.result("features");
                    resolve();
                }, () => {
                    this.features = [];
                    resolve();
                });
            }),
        ];
        if (!attach)
            cmds.push(this.sendCommand("file-exec-and-symbols \"" + escape(target) + "\""));
        for (const cmd of this.extraCommands) {
            cmds.push(this.sendCommand(cmd));
        }
        return cmds;
    }
    stdout(data) {
        if (typeof data == "string")
            this.buffer += data;
        else
            this.buffer += data.toString("utf8");
        const end = this.buffer.lastIndexOf('\n');
        if (end != -1) {
            this.onOutput(this.buffer.substring(0, end));
            this.buffer = this.buffer.substring(end + 1);
        }
        if (this.buffer.length) {
            if (this.onOutputPartial(this.buffer)) {
                this.buffer = "";
            }
        }
    }
    stderr(data) {
        if (typeof data == "string")
            this.errbuf += data;
        else
            this.errbuf += data.toString("utf8");
        const end = this.errbuf.lastIndexOf('\n');
        if (end != -1) {
            this.onOutputStderr(this.errbuf.substring(0, end));
            this.errbuf = this.errbuf.substring(end + 1);
        }
        if (this.errbuf.length) {
            this.logNoNewLine("stderr", this.errbuf);
            this.errbuf = "";
        }
    }
    onOutputStderr(str) {
        const lines = str.split('\n');
        lines.forEach(line => {
            this.log("stderr", line);
        });
    }
    onOutputPartial(line) {
        if (couldBeOutput(line)) {
            this.logNoNewLine("stdout", line);
            return true;
        }
        return false;
    }
    onOutput(str) {
        const lines = str.split('\n');
        lines.forEach(line => {
            if (couldBeOutput(line)) {
                if (!gdbMatch.exec(line))
                    this.log("stdout", line);
            }
            else {
                const parsed = (0, mi_parse_1.parseMI)(line);
                let handled = false;
                if (parsed.token !== undefined) {
                    if (this.handlers[parsed.token]) {
                        if (parsed.resultRecords && parsed.resultRecords.resultClass == "error") {
                            const msg = parsed.result("msg");
                            if (msg && msg.toLowerCase().indexOf("thread is running") !== -1) {
                                console.log("[ardb] intercepted 'thread is running' error: " + msg);
                                parsed.resultRecords.resultClass = 'done';
                            }
                        }
                        this.handlers[parsed.token](parsed);
                        delete this.handlers[parsed.token];
                        handled = true;
                    }
                    this.tokenCount = this.tokenCount + 1;
                    parsed.token = this.tokenCount;
                }
                else {
                    parsed.token = this.tokenCount + 1;
                    this.originallyNoTokenMINodes.push(parsed);
                    if (this.originallyNoTokenMINodes.length >= 100) {
                        this.originallyNoTokenMINodes.splice(0, 90);
                        const rest = this.originallyNoTokenMINodes.splice(89);
                        this.originallyNoTokenMINodes = rest;
                    }
                }
                if (!handled && parsed.resultRecords && parsed.resultRecords?.resultClass == "error") {
                    this.log("stderr", parsed.result("msg") || line);
                }
                if (parsed.outOfBandRecord) {
                    parsed.outOfBandRecord.forEach((record) => {
                        if (record.isStream) {
                            this.log(record.type, record.content);
                        }
                        else {
                            if (record.type == "exec") {
                                this.emit("exec-async-output", parsed);
                                if (record.asyncClass == "running")
                                    this.emit("running", parsed);
                                else if (record.asyncClass == "stopped") {
                                    const reason = parsed.record("reason");
                                    if (reason === undefined) {
                                        this.emit("step-other", parsed);
                                    }
                                    else {
                                        switch (reason) {
                                            case "breakpoint-hit":
                                                this.emit("breakpoint", parsed);
                                                break;
                                            case "watchpoint-trigger":
                                            case "read-watchpoint-trigger":
                                            case "access-watchpoint-trigger":
                                                this.emit("watchpoint", parsed);
                                                break;
                                            case "function-finished":
                                            case "location-reached":
                                            case "end-stepping-range":
                                                this.emit("step-end", parsed);
                                                break;
                                            case "watchpoint-scope":
                                            case "solib-event":
                                            case "syscall-entry":
                                            case "syscall-return":
                                            case "fork":
                                            case "vfork":
                                            case "exec":
                                                this.emit("step-end", parsed);
                                                break;
                                            case "signal-received":
                                                this.emit("signal-stop", parsed);
                                                break;
                                            case "exited-normally":
                                                this.emit("exited-normally", parsed);
                                                break;
                                            case "exited":
                                                this.log("stderr", "Program exited with code " + parsed.record("exit-code"));
                                                this.emit("exited-normally", parsed);
                                                break;
                                            default:
                                                this.log("console", "Not implemented stop reason (assuming exception): " + reason);
                                                this.emit("stopped", parsed);
                                                break;
                                        }
                                    }
                                }
                                else
                                    this.log("log", JSON.stringify(parsed));
                            }
                            else if (record.type == "notify") {
                                if (record.asyncClass == "thread-created") {
                                    this.emit("thread-created", parsed);
                                }
                                else if (record.asyncClass == "thread-exited") {
                                    this.emit("thread-exited", parsed);
                                }
                            }
                        }
                    });
                    handled = true;
                }
                if (parsed.token == undefined &&
                    parsed.resultRecords == undefined &&
                    parsed.outOfBandRecord.length == 0)
                    handled = true;
                if (!handled)
                    this.log("log", "Unhandled: " + JSON.stringify(parsed));
            }
        });
    }
    start(runToStart) {
        const options = [];
        if (runToStart)
            options.push("--start");
        const startCommand = ["exec-run"].concat(options).join(" ");
        return new Promise((resolve, reject) => {
            this.log("console", "Running executable");
            this.sendCommand(startCommand).then((info) => {
                if (info.resultRecords?.resultClass == "running")
                    resolve(true);
                else
                    reject();
            }, reject);
        });
    }
    stop() {
        const proc = this.process;
        const to = setTimeout(() => {
            if (proc.pid)
                process.kill(-proc.pid);
        }, 1000);
        this.process.on("exit", function () {
            clearTimeout(to);
        });
        this.sendRaw("-gdb-exit");
    }
    interrupt() {
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-interrupt").then((info) => {
                resolve(info.resultRecords?.resultClass == "done");
            }, reject);
        });
    }
    continue(reverse = false) {
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-continue" + (reverse ? " --reverse" : "")).then((info) => {
                resolve(info.resultRecords?.resultClass == "running");
            }, reject);
        });
    }
    next(reverse = false) {
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-next" + (reverse ? " --reverse" : "")).then((info) => {
                resolve(info.resultRecords?.resultClass == "running");
            }, reject);
        });
    }
    step(reverse = false) {
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-step" + (reverse ? " --reverse" : "")).then((info) => {
                resolve(info.resultRecords?.resultClass == "running");
            }, reject);
        });
    }
    stepOut(reverse = false) {
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-finish" + (reverse ? " --reverse" : "")).then((info) => {
                resolve(info.resultRecords?.resultClass == "running");
            }, reject);
        });
    }
    stepInstruction(reverse = false) {
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-step-instruction" + (reverse ? " --reverse" : "")).then((info) => {
                resolve(info.resultRecords?.resultClass == "running");
            }, reject);
        });
    }
    goto(filename, line) {
        return new Promise((resolve, reject) => {
            const target = '"' + (filename ? escape(filename) + ":" : "") + line + '"';
            this.sendCommand("break-insert -t " + target).then(() => {
                this.sendCommand("exec-jump " + target).then((info) => {
                    resolve(info.resultRecords?.resultClass == "running");
                }, reject);
            }, reject);
        });
    }
    changeVariable(name, rawValue) {
        return this.sendCommand("gdb-set var " + name + "=" + rawValue);
    }
    setBreakPointCondition(bkptNum, condition) {
        return this.sendCommand("break-condition " + bkptNum + " " + condition);
    }
    addBreakPoint(breakpoint) {
        return new Promise((resolve, reject) => {
            if (this.breakpoints.has(breakpoint))
                return resolve([false, undefined]);
            let location = "";
            if (breakpoint.countCondition) {
                if (breakpoint.countCondition[0] == ">")
                    location += "-i " + numRegex.exec(breakpoint.countCondition.substring(1))[0] + " ";
                else {
                    const match = numRegex.exec(breakpoint.countCondition)[0];
                    if (match.length != breakpoint.countCondition.length) {
                        this.log("stderr", "Unsupported break count expression: '" + breakpoint.countCondition + "'.");
                        location += "-t ";
                    }
                    else if (parseInt(match) != 0)
                        location += "-t -i " + parseInt(match) + " ";
                }
            }
            if (breakpoint.raw)
                location += '"' + escape(breakpoint.raw) + '"';
            else
                location += '"' + escape(breakpoint.file) + ":" + breakpoint.line + '"';
            this.sendCommand("break-insert -f " + location).then((result) => {
                if (result.resultRecords?.resultClass == "done") {
                    const bkptNum = parseInt(result.result("bkpt.number"));
                    const newBrk = {
                        id: bkptNum,
                        file: breakpoint.file ? breakpoint.file : result.result("bkpt.file"),
                        raw: breakpoint.raw,
                        line: parseInt(result.result("bkpt.line")),
                        condition: breakpoint.condition,
                    };
                    if (breakpoint.condition) {
                        this.setBreakPointCondition(bkptNum, breakpoint.condition).then((result) => {
                            if (result.resultRecords?.resultClass == "done") {
                                this.breakpoints.set(newBrk, bkptNum);
                                resolve([true, newBrk]);
                            }
                            else {
                                resolve([false, undefined]);
                            }
                        }, reject);
                    }
                    else {
                        this.breakpoints.set(newBrk, bkptNum);
                        resolve([true, newBrk]);
                    }
                }
                else {
                    reject(result);
                }
            }, reject);
        });
    }
    removeBreakPoint(breakpoint) {
        return new Promise((resolve, reject) => {
            if (!this.breakpoints.has(breakpoint))
                return resolve(false);
            this.sendCommand("break-delete " + this.breakpoints.get(breakpoint)).then((result) => {
                if (result.resultRecords?.resultClass == "done") {
                    this.breakpoints.delete(breakpoint);
                    resolve(true);
                }
                else
                    resolve(false);
            });
        });
    }
    clearBreakPoints(source) {
        return new Promise((resolve, reject) => {
            const promises = [];
            const breakpoints = this.breakpoints;
            this.breakpoints = new Map();
            breakpoints.forEach((k, index) => {
                if (!source || index.file === source) {
                    promises.push(this.sendCommand("break-delete " + k).then((result) => {
                        if (result.resultRecords?.resultClass == "done")
                            resolve(true);
                        else
                            resolve(false);
                    }));
                }
                else {
                    this.breakpoints.set(index, k);
                }
            });
            Promise.all(promises).then(resolve, reject);
        });
    }
    async getThreads() {
        const result = await this.sendCommand("thread-info");
        const threads = result.result("threads");
        const ret = [];
        if (!Array.isArray(threads))
            return ret;
        return threads.map(element => ({
            id: parseInt(mi_parse_1.MINode.valueOf(element, "id")),
            targetId: mi_parse_1.MINode.valueOf(element, "target-id"),
            name: mi_parse_1.MINode.valueOf(element, "name") || mi_parse_1.MINode.valueOf(element, "details"),
        }));
    }
    async getStack(startFrame, maxLevels, thread) {
        const options = [];
        if (thread != 0)
            options.push("--thread " + thread);
        const depth = (await this.sendCommand(["stack-info-depth"].concat(options).join(" "))).result("depth").valueOf();
        const lowFrame = startFrame ? startFrame : 0;
        const highFrame = (maxLevels ? Math.min(depth, lowFrame + maxLevels) : depth) - 1;
        if (highFrame < lowFrame)
            return [];
        options.push(lowFrame.toString());
        options.push(highFrame.toString());
        const result = await this.sendCommand(["stack-list-frames"].concat(options).join(" "));
        const stack = result.result("stack");
        return stack.map((element) => {
            const level = mi_parse_1.MINode.valueOf(element, "@frame.level");
            const addr = mi_parse_1.MINode.valueOf(element, "@frame.addr");
            const func = mi_parse_1.MINode.valueOf(element, "@frame.func");
            const filename = mi_parse_1.MINode.valueOf(element, "@frame.file");
            let file = mi_parse_1.MINode.valueOf(element, "@frame.fullname");
            if (!file)
                file = mi_parse_1.MINode.valueOf(element, "@frame.file");
            if (file)
                file = path.normalize(file);
            let line = 0;
            const lnstr = mi_parse_1.MINode.valueOf(element, "@frame.line");
            if (lnstr)
                line = parseInt(lnstr);
            const from = parseInt(mi_parse_1.MINode.valueOf(element, "@frame.from"));
            return {
                address: addr,
                fileName: filename,
                file: file,
                function: func || from,
                level: level,
                line: line,
            };
        });
    }
    async getStackVariables(thread, frame) {
        const result = await this.sendCommand(`stack-list-variables --thread ${thread} --frame ${frame} --simple-values`);
        const variables = result.result("variables");
        const ret = [];
        for (const element of variables) {
            ret.push({
                name: mi_parse_1.MINode.valueOf(element, "name"),
                valueStr: mi_parse_1.MINode.valueOf(element, "value"),
                type: mi_parse_1.MINode.valueOf(element, "type"),
                raw: element,
            });
        }
        return ret;
    }
    async getRegisterNames() {
        const result = await this.sendCommand("data-list-register-names");
        const names = result.result('register-names');
        if (!Array.isArray(names))
            throw new Error('Failed to retrieve register names.');
        return names.map(name => name.toString());
    }
    async getSomeRegisterValues(register_ids) {
        const mi_string = "data-list-register-values x " + register_ids.join(" ");
        const result = await this.sendCommand(mi_string);
        const nodes = result.result('register-values');
        if (!Array.isArray(nodes)) {
            console.warn("[ardb] getSomeRegisterValues: no register data returned, returning []");
            return [];
        }
        return nodes.map(node => ({
            index: parseInt(mi_parse_1.MINode.valueOf(node, "number")),
            value: mi_parse_1.MINode.valueOf(node, "value"),
        }));
    }
    async getSomeRegisters(register_ids) {
        const names = await this.getRegisterNames();
        const values = await this.getSomeRegisterValues(register_ids);
        return values.map(val => ({
            name: names[val.index],
            valueStr: val.value,
            type: "string",
        }));
    }
    async getRegisterValues() {
        const result = await this.sendCommand("data-list-register-values --skip-unavailable N " + (this.registerLimit || ""));
        const nodes = result.result('register-values');
        if (!Array.isArray(nodes))
            throw new Error('Failed to retrieve register values.');
        return nodes.map(node => ({
            index: parseInt(mi_parse_1.MINode.valueOf(node, "number")),
            value: mi_parse_1.MINode.valueOf(node, "value"),
        }));
    }
    async getRegisters() {
        const names = await this.getRegisterNames();
        const values = await this.getRegisterValues();
        return values.map(val => ({
            name: names[val.index],
            valueStr: val.value,
            type: "string",
        }));
    }
    examineMemory(addr, length) {
        return new Promise((resolve, reject) => {
            this.sendCommand("data-read-memory-bytes " + addr + " " + length).then((result) => {
                resolve({
                    contents: result.result("memory[0].contents"),
                    begin: result.result("memory[0].begin"),
                });
            }, reject);
        });
    }
    async evalExpression(name, thread, frame) {
        let command = "data-evaluate-expression ";
        if (thread != 0)
            command += `--thread ${thread} --frame ${frame} `;
        command += name;
        return await this.sendCommand(command);
    }
    async varCreate(threadId, frameLevel, expression, name = "-", frame = "@") {
        let miCommand = "var-create ";
        if (threadId != 0)
            miCommand += `--thread ${threadId} --frame ${frameLevel}`;
        const res = await this.sendCommand(`${miCommand} ${this.quote(name)} ${frame} "${expression}"`);
        return new backend_1.VariableObject(res.result(""));
    }
    async varEvalExpression(name) {
        return this.sendCommand(`var-evaluate-expression ${this.quote(name)}`);
    }
    async varListChildren(name) {
        const res = await this.sendCommand(`var-list-children --all-values ${this.quote(name)}`);
        const children = res.result("children") || [];
        return children.map((child) => new backend_1.VariableObject(child[1]));
    }
    async varUpdate(name = "*") {
        return this.sendCommand(`var-update --all-values ${this.quote(name)}`);
    }
    async varAssign(name, rawValue) {
        return this.sendCommand(`var-assign ${this.quote(name)} ${rawValue}`);
    }
    logNoNewLine(type, msg) {
        this.emit("msg", type, msg);
    }
    log(type, msg) {
        this.emit("msg", type, msg[msg.length - 1] == "\n" ? msg : msg + "\n");
    }
    sendUserInput(command, threadId = 0, frameLevel = 0) {
        if (command.startsWith("-")) {
            return this.sendCommand(command.substring(1));
        }
        else {
            return this.sendCliCommand(command, threadId, frameLevel);
        }
    }
    sendRaw(raw) {
        if (this.process && this.process.stdin) {
            this.process.stdin.write(raw + "\n");
        }
    }
    sendCliCommand(command, threadId = 0, frameLevel = 0) {
        let miCommand = "interpreter-exec ";
        if (threadId != 0)
            miCommand += `--thread ${threadId} --frame ${frameLevel} `;
        miCommand += `console "${command.replace(/[\\"']/g, "\\$&")}"`;
        return this.sendCommand(miCommand);
    }
    addSymbolFile(filepath) {
        return new Promise((resolve, reject) => {
            this.sendCliCommand("add-symbol-file " + filepath).then((result) => {
                if (result.resultRecords?.resultClass == "done")
                    resolve(true);
                else
                    resolve(false);
            }, reject);
        });
    }
    removeSymbolFile(filepath) {
        return new Promise((resolve, reject) => {
            this.sendCliCommand("remove-symbol-file " + filepath).then((result) => {
                if (result.resultRecords?.resultClass == "done")
                    resolve(true);
                else
                    resolve(false);
            }, reject);
        });
    }
    sendCommand(command, suppressFailure = false) {
        const sel = this.currentToken++;
        return new Promise((resolve, reject) => {
            this.handlers[sel] = (node) => {
                if (node && node.resultRecords && node.resultRecords?.resultClass === "error") {
                    if (suppressFailure) {
                        this.log("stderr", `WARNING: Error executing command '${command}'`);
                        resolve(node);
                    }
                    else
                        reject(new backend_1.MIError(node.result("msg") || "Internal error", command));
                }
                else
                    resolve(node);
            };
            this.sendRaw(sel + "-" + command);
        });
    }
    isReady() {
        return !!this.process;
    }
    quote(text) {
        return /^-|[^\w\d\/_\-\.]/g.test(text) ? '"' + escape(text) + '"' : text;
    }
    getOriginallyNoTokenMINodes(num) {
        const info = [];
        for (let i = this.originallyNoTokenMINodes.length - 1; i >= 0; i--) {
            if (this.originallyNoTokenMINodes[i].token == num) {
                info.push(this.originallyNoTokenMINodes[i]);
                this.originallyNoTokenMINodes.splice(i, 1);
            }
        }
        return info;
    }
}
exports.MI2 = MI2;
//# sourceMappingURL=mi2.js.map