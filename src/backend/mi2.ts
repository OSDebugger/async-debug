// Ported from code-debug (os-debug) src/backend/mi2/mi2.ts
// Removed: SSH support, linux/console, prettyPrint utils, IBackend interface
// Adapted for ardb: no SSH, focused on GDB process management + MI parsing + EventEmitter

import { Breakpoint, Thread, Stack, Variable, RegisterValue, VariableObject, MIError, Register } from "./backend";
import * as ChildProcess from "child_process";
import { EventEmitter } from "events";
import { parseMI, MINode } from './mi_parse';
import * as fs from "fs";
import * as path from "path";

export function escape(str: string) {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Read the virtual address of the .text section from an ELF file on disk.
 * Returns undefined if the file can't be read or has no .text section.
 *
 * ELF layout (64-bit little-endian, which covers all RISC-V 64 binaries):
 *   Offset 0x10 (2 bytes): e_type
 *   Offset 0x20 (8 bytes): e_shoff — file offset of section header table
 *   Offset 0x3A (2 bytes): e_shentsize — size of each section header entry
 *   Offset 0x3C (2 bytes): e_shnum    — number of section header entries
 *   Offset 0x3E (2 bytes): e_shstrndx — index of section name string table
 * Each 64-bit section header entry (64 bytes):
 *   +0x00 (4): sh_name   — byte offset into shstrtab
 *   +0x18 (8): sh_addr   — virtual address
 */
function readElfTextAddr(filepath: string): string | undefined {
	try {
		// Read enough of the file to access the header and all section headers.
		// We read up to 1 MiB which is far more than enough for any OS ELF header.
		const fd = fs.openSync(filepath, 'r');
		const headerBuf = Buffer.alloc(64);
		fs.readSync(fd, headerBuf, 0, 64, 0);

		// Check ELF magic
		if (headerBuf[0] !== 0x7F || headerBuf[1] !== 0x45 ||
			headerBuf[2] !== 0x4C || headerBuf[3] !== 0x46) {
			fs.closeSync(fd);
			return undefined;
		}
		const is64bit = headerBuf[4] === 2;
		const isLittleEndian = headerBuf[5] === 1;
		if (!is64bit || !isLittleEndian) {
			// Only handle 64-bit LE (RISC-V 64)
			fs.closeSync(fd);
			return undefined;
		}

		const shoff = Number(headerBuf.readBigUInt64LE(0x28));
		const shentsize = headerBuf.readUInt16LE(0x3A);
		const shnum = headerBuf.readUInt16LE(0x3C);
		const shstrndx = headerBuf.readUInt16LE(0x3E);

		if (shoff === 0 || shnum === 0) { fs.closeSync(fd); return undefined; }

		// Read all section headers
		const shBuf = Buffer.alloc(shentsize * shnum);
		fs.readSync(fd, shBuf, 0, shBuf.length, shoff);

		// Find shstrtab section to resolve names
		const shstrOffset = shoff + shstrndx * shentsize;
		const shstrBuf = Buffer.alloc(shentsize);
		fs.readSync(fd, shstrBuf, 0, shentsize, shstrOffset);
		const shstrFileOffset = Number(shstrBuf.readBigUInt64LE(0x18));
		const shstrSize = Number(shstrBuf.readBigUInt64LE(0x20));
		const shstrData = Buffer.alloc(shstrSize);
		fs.readSync(fd, shstrData, 0, shstrSize, shstrFileOffset);
		fs.closeSync(fd);

		// Find section named ".text"
		for (let i = 0; i < shnum; i++) {
			const base = i * shentsize;
			const nameIdx = shBuf.readUInt32LE(base);
			// Read null-terminated string from shstrData
			let name = '';
			for (let j = nameIdx; j < shstrData.length && shstrData[j] !== 0; j++) {
				name += String.fromCharCode(shstrData[j]);
			}
			if (name === '.text') {
				// sh_addr is at offset 0x10 within each Elf64_Shdr entry
				const vaddr = shBuf.readBigUInt64LE(base + 0x10);
				return '0x' + vaddr.toString(16);
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

const nonOutput = /^(?:\d*|undefined)[\*\+\=]|[\~\@\&\^]/;
const gdbMatch = /(?:\d*|undefined)\(gdb\)/;
const numRegex = /\d+/;

function couldBeOutput(line: string) {
	if (nonOutput.exec(line)) return false;
	return true;
}

export class MI2 extends EventEmitter {
	constructor(
		public application: string,
		public preargs: string[],
		public extraargs: string[],
		procEnv: any,
		public extraCommands: string[] = []
	) {
		super();

		if (procEnv) {
			const env: { [key: string]: string } = {};
			for (const key in process.env)
				if (process.env.hasOwnProperty(key)) env[key] = process.env[key]!;
			for (const key in procEnv) {
				if (procEnv.hasOwnProperty(key)) {
					if (procEnv[key] === undefined) delete env[key];
					else env[key] = procEnv[key];
				}
			}
			this.procEnv = env;
		}
	}

	load(cwd: string, target: string, procArgs: string, autorun: string[] = []): Promise<any> {
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
	attach(cwd: string, executable: string, target: string, autorun: string[] = []): Promise<any> {
		return new Promise((resolve, reject) => {
			if (executable && !path.isAbsolute(executable)) executable = path.join(cwd, executable);
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
	connect(cwd: string, executable: string, target: string, autorun: string[] = []): Promise<any> {
		return new Promise((resolve, reject) => {
			if (executable && !path.isAbsolute(executable)) executable = path.join(cwd, executable);
			const args = this.preargs.concat(this.extraargs || []);
			this.process = ChildProcess.spawn(this.application, args, { cwd: cwd, env: this.procEnv });
			this.process.stdout?.on("data", this.stdout.bind(this));
			this.process.stderr?.on("data", this.stderr.bind(this));
			this.process.on("exit", () => this.emit("quit"));
			this.process.on("error", err => this.emit("launcherror", err));
			// First run init commands (gdb-set, list-features, extraCommands) in parallel,
			// then load symbols, then connect to the remote stub, then run autorun commands.
			// This order is required: symbols must be loaded before "target remote" so GDB
			// knows the architecture and can resolve breakpoint locations immediately.
			Promise.all(this.initCommands(target, cwd, true)).then(() => {
				const seq: Promise<any>[] = [];
				if (executable)
					seq.push(this.sendCommand('file-exec-and-symbols "' + escape(executable) + '"'));
				return seq.reduce((p, cmd) => p.then(() => cmd), Promise.resolve() as Promise<any>);
			}).then(() => {
				return this.sendCommand("target-select remote " + target);
			}).then(() => {
				return Promise.all(autorun.map(value => this.sendUserInput(value)));
			}).then(() => {
				this.emit("debug-ready");
				resolve(undefined);
			}).catch(reject);
		});
	}

	protected initCommands(target: string, cwd: string, attach: boolean = false) {
		const debuggerPath = path.posix.isAbsolute(cwd) ? path.posix : path.win32;
		if (!debuggerPath.isAbsolute(target)) target = debuggerPath.join(cwd, target);

		const cmds = [
			this.sendCommand("gdb-set target-async on", true),
			// Disable GDB's interactive confirmation prompts so that commands like
			// "add-symbol-file" don't block waiting for user input in MI mode.
			this.sendCommand("gdb-set confirm off", true),
			new Promise<void>((resolve) => {
				this.sendCommand("list-features").then(
					(done) => {
						this.features = done.result("features");
						resolve();
					},
					() => {
						this.features = [];
						resolve();
					}
				);
			}),
		];
		if (!attach)
			cmds.push(this.sendCommand("file-exec-and-symbols \"" + escape(target) + "\""));
		for (const cmd of this.extraCommands) {
			cmds.push(this.sendCommand(cmd));
		}
		return cmds;
	}

	stdout(data: any) {
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

	stderr(data: any) {
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

	onOutputStderr(str: string) {
		const lines = str.split('\n');
		lines.forEach(line => {
			this.log("stderr", line);
		});
	}

	onOutputPartial(line: string) {
		if (couldBeOutput(line)) {
			this.logNoNewLine("stdout", line);
			return true;
		}
		return false;
	}

	onOutput(str: string) {
		const lines = str.split('\n');
		lines.forEach(line => {
			if (couldBeOutput(line)) {
				if (!gdbMatch.exec(line)) this.log("stdout", line);
			} else {
				console.log(`[<- GDB] ${line}`);
				const parsed = parseMI(line);
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
				} else {
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
						} else {
							if (record.type == "exec") {
								this.emit("exec-async-output", parsed);
								if (record.asyncClass == "running") this.emit("running", parsed);
								else if (record.asyncClass == "stopped") {
									const reason = parsed.record("reason");
									if (reason === undefined) {
										this.emit("step-other", parsed);
									} else {
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
								} else this.log("log", JSON.stringify(parsed));
							} else if (record.type == "notify") {
								if (record.asyncClass == "thread-created") {
									this.emit("thread-created", parsed);
								} else if (record.asyncClass == "thread-exited") {
									this.emit("thread-exited", parsed);
								}
							}
						}
					});
					handled = true;
				}
				if (
					parsed.token == undefined &&
					parsed.resultRecords == undefined &&
					parsed.outOfBandRecord.length == 0
				)
					handled = true;
				if (!handled) this.log("log", "Unhandled: " + JSON.stringify(parsed));
			}
		});
	}

	start(runToStart: boolean): Promise<boolean> {
		const options: string[] = [];
		if (runToStart) options.push("--start");
		const startCommand: string = ["exec-run"].concat(options).join(" ");
		return new Promise((resolve, reject) => {
			this.log("console", "Running executable");
			this.sendCommand(startCommand).then((info) => {
				if (info.resultRecords?.resultClass == "running") resolve(true);
				else reject();
			}, reject);
		});
	}

	stop() {
		const proc = this.process;
		const to = setTimeout(() => {
			if (proc.pid) process.kill(-proc.pid);
		}, 1000);
		this.process.on("exit", function () {
			clearTimeout(to);
		});
		this.sendRaw("-gdb-exit");
	}

	interrupt(): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this.sendCommand("exec-interrupt").then((info) => {
				resolve(info.resultRecords?.resultClass == "done");
			}, reject);
		});
	}

	continue(reverse: boolean = false): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this.sendCommand("exec-continue" + (reverse ? " --reverse" : "")).then((info) => {
				resolve(info.resultRecords?.resultClass == "running");
			}, reject);
		});
	}

	next(reverse: boolean = false): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this.sendCommand("exec-next" + (reverse ? " --reverse" : "")).then((info) => {
				resolve(info.resultRecords?.resultClass == "running");
			}, reject);
		});
	}

	step(reverse: boolean = false): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this.sendCommand("exec-step" + (reverse ? " --reverse" : "")).then((info) => {
				resolve(info.resultRecords?.resultClass == "running");
			}, reject);
		});
	}

	stepOut(reverse: boolean = false): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this.sendCommand("exec-finish" + (reverse ? " --reverse" : "")).then((info) => {
				resolve(info.resultRecords?.resultClass == "running");
			}, reject);
		});
	}

	stepInstruction(reverse: boolean = false): Promise<boolean> {
		return new Promise((resolve, reject) => {
			this.sendCommand("exec-step-instruction" + (reverse ? " --reverse" : "")).then((info) => {
				resolve(info.resultRecords?.resultClass == "running");
			}, reject);
		});
	}

	goto(filename: string, line: number): Promise<Boolean> {
		return new Promise((resolve, reject) => {
			const target: string = '"' + (filename ? escape(filename) + ":" : "") + line + '"';
			this.sendCommand("break-insert -t " + target).then(() => {
				this.sendCommand("exec-jump " + target).then((info) => {
					resolve(info.resultRecords?.resultClass == "running");
				}, reject);
			}, reject);
		});
	}

	changeVariable(name: string, rawValue: string): Promise<any> {
		return this.sendCommand("gdb-set var " + name + "=" + rawValue);
	}

	setBreakPointCondition(bkptNum: number, condition: string): Promise<any> {
		return this.sendCommand("break-condition " + bkptNum + " " + condition);
	}

	addBreakPoint(breakpoint: Breakpoint): Promise<[boolean, Breakpoint]> {
		return new Promise((resolve, reject) => {
			if (this.breakpoints.has(breakpoint)) return resolve([false, undefined as any]);
			let location = "";
			if (breakpoint.countCondition) {
				if (breakpoint.countCondition[0] == ">")
					location += "-i " + numRegex.exec(breakpoint.countCondition.substring(1))![0] + " ";
				else {
					const match = numRegex.exec(breakpoint.countCondition)![0];
					if (match.length != breakpoint.countCondition.length) {
						this.log("stderr", "Unsupported break count expression: '" + breakpoint.countCondition + "'.");
						location += "-t ";
					} else if (parseInt(match) != 0) location += "-t -i " + parseInt(match) + " ";
				}
			}
			if (breakpoint.raw) location += '"' + escape(breakpoint.raw) + '"';
			else location += '"' + escape(breakpoint.file!) + ":" + breakpoint.line + '"';
			this.sendCommand("break-insert -f " + location).then((result) => {
				if (result.resultRecords?.resultClass == "done") {
					const bkptNum = parseInt(result.result("bkpt.number"));
					const newBrk: Breakpoint = {
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
							} else {
								resolve([false, undefined as any]);
							}
						}, reject);
					} else {
						this.breakpoints.set(newBrk, bkptNum);
						resolve([true, newBrk]);
					}
				} else {
					reject(result);
				}
			}, reject);
		});
	}

	removeBreakPoint(breakpoint: Breakpoint): Promise<boolean> {
		return new Promise((resolve, reject) => {
			if (!this.breakpoints.has(breakpoint)) return resolve(false);
			this.sendCommand("break-delete " + this.breakpoints.get(breakpoint)).then((result) => {
				if (result.resultRecords?.resultClass == "done") {
					this.breakpoints.delete(breakpoint);
					resolve(true);
				} else resolve(false);
			});
		});
	}

	clearBreakPoints(source?: string): Promise<any> {
		return new Promise((resolve, reject) => {
			const promises: Promise<void | MINode>[] = [];
			const breakpoints = this.breakpoints;
			this.breakpoints = new Map();
			breakpoints.forEach((k, index) => {
				if (!source || index.file === source) {
					promises.push(
						this.sendCommand("break-delete " + k).then((result) => {
							if (result.resultRecords?.resultClass == "done") resolve(true);
							else resolve(false);
						})
					);
				} else {
					this.breakpoints.set(index, k);
				}
			});
			Promise.all(promises).then(resolve, reject);
		});
	}

	async getThreads(): Promise<Thread[]> {
		const result = await this.sendCommand("thread-info");
		const threads = result.result("threads");
		const ret: Thread[] = [];
		if (!Array.isArray(threads)) return ret;
		return threads.map(element => ({
			id: parseInt(MINode.valueOf(element, "id")),
			targetId: MINode.valueOf(element, "target-id"),
			name: MINode.valueOf(element, "name") || MINode.valueOf(element, "details"),
		}));
	}

	async getStack(startFrame: number, maxLevels: number, thread: number): Promise<Stack[]> {
		const options: string[] = [];
		if (thread != 0) options.push("--thread " + thread);
		const depth: number = (await this.sendCommand(["stack-info-depth"].concat(options).join(" "))).result("depth").valueOf();
		const lowFrame: number = startFrame ? startFrame : 0;
		const highFrame: number = (maxLevels ? Math.min(depth, lowFrame + maxLevels) : depth) - 1;
		if (highFrame < lowFrame) return [];
		options.push(lowFrame.toString());
		options.push(highFrame.toString());
		const result = await this.sendCommand(["stack-list-frames"].concat(options).join(" "));
		const stack = result.result("stack");
		return stack.map((element: any) => {
			const level = MINode.valueOf(element, "@frame.level");
			const addr = MINode.valueOf(element, "@frame.addr");
			const func = MINode.valueOf(element, "@frame.func");
			const filename = MINode.valueOf(element, "@frame.file");
			let file: string = MINode.valueOf(element, "@frame.fullname");
			if (!file) file = MINode.valueOf(element, "@frame.file");
			if (file) file = path.normalize(file);
			let line = 0;
			const lnstr = MINode.valueOf(element, "@frame.line");
			if (lnstr) line = parseInt(lnstr);
			const from = parseInt(MINode.valueOf(element, "@frame.from"));
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

	async getStackVariables(thread: number, frame: number): Promise<Variable[]> {
		const result = await this.sendCommand(
			`stack-list-variables --thread ${thread} --frame ${frame} --simple-values`
		);
		const variables = result.result("variables");
		const ret: Variable[] = [];
		for (const element of variables) {
			ret.push({
				name: MINode.valueOf(element, "name"),
				valueStr: MINode.valueOf(element, "value"),
				type: MINode.valueOf(element, "type"),
				raw: element,
			});
		}
		return ret;
	}

	async getRegisterNames(): Promise<string[]> {
		const result = await this.sendCommand("data-list-register-names");
		const names = result.result('register-names');
		if (!Array.isArray(names)) throw new Error('Failed to retrieve register names.');
		return names.map(name => name.toString());
	}

	async getSomeRegisterValues(register_ids: number[]): Promise<RegisterValue[]> {
		const mi_string = "data-list-register-values x " + register_ids.join(" ");
		const result = await this.sendCommand(mi_string);
		const nodes = result.result('register-values');
		if (!Array.isArray(nodes)) {
			console.warn("[ardb] getSomeRegisterValues: no register data returned, returning []");
			return [];
		}
		return nodes.map(node => ({
			index: parseInt(MINode.valueOf(node, "number")),
			value: MINode.valueOf(node, "value"),
		}));
	}

	async getSomeRegisters(register_ids: number[]): Promise<Variable[]> {
		const names = await this.getRegisterNames();
		const values = await this.getSomeRegisterValues(register_ids);
		return values.map(val => ({
			name: names[val.index],
			valueStr: val.value,
			type: "string",
		}));
	}

	async getRegisterValues(): Promise<RegisterValue[]> {
		const result = await this.sendCommand("data-list-register-values --skip-unavailable N " + (this.registerLimit || ""));
		const nodes = result.result('register-values');
		if (!Array.isArray(nodes)) throw new Error('Failed to retrieve register values.');
		return nodes.map(node => ({
			index: parseInt(MINode.valueOf(node, "number")),
			value: MINode.valueOf(node, "value"),
		}));
	}

	async getRegisters(): Promise<Variable[]> {
		const names = await this.getRegisterNames();
		const values = await this.getRegisterValues();
		return values.map(val => ({
			name: names[val.index],
			valueStr: val.value,
			type: "string",
		}));
	}

	examineMemory(addr: number | string, length: number): Promise<any> {
		return new Promise((resolve, reject) => {
			this.sendCommand("data-read-memory-bytes " + addr + " " + length).then(
				(result) => {
					resolve({
						contents: result.result("memory[0].contents"),
						begin: result.result("memory[0].begin"),
					});
				},
				reject
			);
		});
	}

	async evalExpression(name: string, thread: number, frame: number): Promise<MINode> {
		let command = "data-evaluate-expression ";
		if (thread != 0) command += `--thread ${thread} --frame ${frame} `;
		command += name;
		return await this.sendCommand(command);
	}

	async varCreate(threadId: number, frameLevel: number, expression: string, name: string = "-", frame: string = "@"): Promise<VariableObject> {
		let miCommand = "var-create ";
		if (threadId != 0) miCommand += `--thread ${threadId} --frame ${frameLevel}`;
		const res = await this.sendCommand(`${miCommand} ${this.quote(name)} ${frame} "${expression}"`);
		return new VariableObject(res.result(""));
	}

	async varEvalExpression(name: string): Promise<MINode> {
		return this.sendCommand(`var-evaluate-expression ${this.quote(name)}`);
	}

	async varListChildren(name: string): Promise<VariableObject[]> {
		const res = await this.sendCommand(`var-list-children --all-values ${this.quote(name)}`);
		const children = res.result("children") || [];
		return children.map((child: any) => new VariableObject(child[1]));
	}

	async varUpdate(name: string = "*"): Promise<MINode> {
		return this.sendCommand(`var-update --all-values ${this.quote(name)}`);
	}

	async varAssign(name: string, rawValue: string): Promise<MINode> {
		return this.sendCommand(`var-assign ${this.quote(name)} ${rawValue}`);
	}

	logNoNewLine(type: string, msg: string) {
		this.emit("msg", type, msg);
	}

	log(type: string, msg: string) {
		this.emit("msg", type, msg[msg.length - 1] == "\n" ? msg : msg + "\n");
	}

	sendUserInput(command: string, threadId: number = 0, frameLevel: number = 0): Promise<MINode> {
		if (command.startsWith("-")) {
			return this.sendCommand(command.substring(1));
		} else {
			return this.sendCliCommand(command, threadId, frameLevel);
		}
	}

	sendRaw(raw: string) {
		if (this.process && this.process.stdin) {
			this.process.stdin.write(raw + "\n");
		}
	}

	sendCliCommand(command: string, threadId: number = 0, frameLevel: number = 0): Promise<MINode> {
		let miCommand = "interpreter-exec ";
		if (threadId != 0) miCommand += `--thread ${threadId} --frame ${frameLevel} `;
		miCommand += `console "${command.replace(/[\\"']/g, "\\$&")}"`;
		return this.sendCommand(miCommand);
	}

	addSymbolFile(filepath: string, textAddr?: string): Promise<any> {
		return new Promise((resolve, reject) => {
			// GDB requires a .text load address for add-symbol-file.
			// Use the caller-supplied address, or auto-detect it from the ELF header.
			// If neither is available, skip silently — the kernel ELF is already loaded
			// via file-exec-and-symbols, and a user-space ELF with an unknown address
			// would only corrupt symbol resolution.
			const addr = textAddr ?? readElfTextAddr(filepath);
			if (!addr) {
				resolve(false);
				return;
			}
			this.sendCliCommand(`add-symbol-file ${filepath} ${addr}`).then((result) => {
				if (result.resultRecords?.resultClass == "done") resolve(true);
				else resolve(false);
			}, reject);
		});
	}

	removeSymbolFile(filepath: string): Promise<any> {
		return new Promise((resolve, reject) => {
			this.sendCliCommand("remove-symbol-file " + filepath).then((result) => {
				if (result.resultRecords?.resultClass == "done") resolve(true);
				else resolve(false);
			}, reject);
		});
	}

	sendCommand(command: string, suppressFailure: boolean = false): Promise<MINode> {
		const sel = this.currentToken++;
		return new Promise((resolve, reject) => {
			this.handlers[sel] = (node: MINode) => {
				if (node && node.resultRecords && node.resultRecords?.resultClass === "error") {
					if (suppressFailure) {
						this.log("stderr", `WARNING: Error executing command '${command}'`);
						resolve(node);
					} else reject(new MIError(node.result("msg") || "Internal error", command));
				} else resolve(node);
			};
			this.sendRaw(sel + "-" + command);
			console.log(`[GDB ->] ${sel}-${command}`);
		});
	}

	isReady(): boolean {
		return !!this.process;
	}

	protected quote(text: string): string {
		return /^-|[^\w\d\/_\-\.]/g.test(text) ? '"' + escape(text) + '"' : text;
	}

	getOriginallyNoTokenMINodes(num: number): Array<MINode> {
		const info = [];
		for (let i = this.originallyNoTokenMINodes.length - 1; i >= 0; i--) {
			if (this.originallyNoTokenMINodes[i].token == num) {
				info.push(this.originallyNoTokenMINodes[i]);
				this.originallyNoTokenMINodes.splice(i, 1);
			}
		}
		return info;
	}

	public features: string[] = [];
	public procEnv: any;
	public registerLimit: string = "";
	protected currentToken: number = 1;
	protected handlers: { [index: number]: (info: MINode) => any } = {};
	protected breakpoints: Map<Breakpoint, Number> = new Map();
	protected buffer: string = "";
	protected errbuf: string = "";
	protected process!: ChildProcess.ChildProcess;
	protected originallyNoTokenMINodes: MINode[] = [];
	protected tokenCount: number = 0;
}
