// Ported from code-debug src/mibase.ts (BreakpointGroups class + supporting types)
// Decoupled from MI2DebugSession: uses IDebuggerBackend interface instead of direct session reference.
// SSH support removed (not needed for rust-debugger-DA).

import { DebugProtocol } from "@vscode/debugprotocol";
import { Breakpoint } from "./backend/backend";

export type FunctionString = string;

// Injected interface — only the methods BreakpointGroups actually needs from the session/debugger
export interface IDebuggerBackend {
	clearBreakPoints(source?: string): Promise<any>;
	addBreakPoint(breakpoint: Breakpoint): Promise<[boolean, Breakpoint]>;
	// textAddr: optional load address for the .text section (required by GDB for user-space ELFs)
	addSymbolFile(filepath: string, textAddr?: string): Promise<any>;
	removeSymbolFile(filepath: string): Promise<any>;
	continue(reverse?: boolean): Promise<boolean>;
}

// Entry returned by breakpointGroupNameToDebugFilePaths.
// Accepts either a plain path string (backward compat) or an object with an optional textAddr.
export type SymbolFileEntry = string | { path: string; textAddr?: string };

export interface IBreakpointGroupsSession {
	miDebugger: IDebuggerBackend;
	filePathToBreakpointGroupNames: FunctionString;
	breakpointGroupNameToDebugFilePaths: FunctionString;
	showInformationMessage(msg: string): void;
	// Called after all breakpoints for the new group have been (re-)inserted into GDB.
	// The caller should send BreakpointEvent('changed') for each restored breakpoint.
	onBreakpointsRestored(results: Array<[boolean, Breakpoint]>): void;
}

export class Border {
	filepath: string;
	line: number;
	constructor(filepath: string, line: number) {
		this.filepath = filepath;
		this.line = line;
	}
}

export class HookBreakpointJSONFriendly {
	breakpoint!: Breakpoint;
	behavior!: ObjectAsFunction;
}

export type ObjectAsFunction = { body: string; args: string[] };

export function toFunctionString(obj: ObjectAsFunction): FunctionString {
	return `(function(${obj.args.join(",")}) { ${obj.body} })`;
}

export function toHookBreakpoint(h: HookBreakpointJSONFriendly): HookBreakpoint {
	return new HookBreakpoint(h.breakpoint, toFunctionString(h.behavior));
}

export class HookBreakpoint {
	breakpoint: Breakpoint;
	behavior: FunctionString;
	constructor(breakpoint: Breakpoint, behavior: FunctionString) {
		this.breakpoint = breakpoint;
		this.behavior = behavior;
	}
}

// use this to get next process name
export class HookBreakpoints {
	private hooks: HookBreakpoint[];
	constructor(hooks: HookBreakpoint[]) {
		this.hooks = hooks;
	}
	// we cannot compare functions so we always override them
	public set(newHook: HookBreakpoint) {
		let hookPositionAlreadyExists = false;
		for (const hook of this.hooks) {
			if (hook.breakpoint.file === newHook.breakpoint.file && hook.breakpoint.line === newHook.breakpoint.line) {
				hookPositionAlreadyExists = true;
				hook.behavior = newHook.behavior;
			}
		}
		if (hookPositionAlreadyExists === false) {
			this.hooks.push(new HookBreakpoint(newHook.breakpoint, newHook.behavior));
		}
	}
	// again, we cannot compare functions, so if linenumber and filepath are the same, the hook will be removed
	public remove(breakpointOfHook: Breakpoint) {
		this.hooks = this.hooks.filter(b => (b.breakpoint.file !== breakpointOfHook.file || b.breakpoint.line !== breakpointOfHook.line));
	}
	[Symbol.iterator](): Iterator<HookBreakpoint> {
		let index = 0;
		const hooks = this.hooks;
		return {
			next(): IteratorResult<HookBreakpoint> {
				if (index < hooks.length) {
					return { done: false, value: hooks[index++] };
				} else {
					return { done: true, value: undefined as any };
				}
			}
		};
	}
}

// we recommend the name of BreakpointGroup to be the full file path of the debugged file
// when one file is sufficient for one BreakpointGroup
class BreakpointGroup {
	name: string;
	setBreakpointsArguments: DebugProtocol.SetBreakpointsArguments[];
	borders?: Border[];
	hooks: HookBreakpoints;
	constructor(name: string, setBreakpointsArguments: DebugProtocol.SetBreakpointsArguments[], hooks: HookBreakpoints, borders?: Border[]) {
		this.name = name;
		this.setBreakpointsArguments = setBreakpointsArguments;
		this.hooks = hooks;
		this.borders = borders;
	}
}

// Manages breakpoint caching, switching symbol files, and breakpoint group transitions.
export class BreakpointGroups {
	protected groups: BreakpointGroup[];
	protected currentBreakpointGroupName: string;
	protected nextBreakpointGroup: string;
	protected readonly session: IBreakpointGroupsSession;
	// Tracks symbol files already loaded into GDB via add-symbol-file.
	// We never unload them so that breakpoints from all groups stay active simultaneously.
	private loadedSymbolFiles: Set<string> = new Set();

	constructor(currentBreakpointGroupName: string, session: IBreakpointGroupsSession, nextBreakpointGroup: string) {
		this.session = session;
		this.groups = [];
		this.groups.push(new BreakpointGroup(currentBreakpointGroupName, [], new HookBreakpoints([]), []));
		this.currentBreakpointGroupName = currentBreakpointGroupName;
		this.nextBreakpointGroup = nextBreakpointGroup;
	}

	// Let GDB remove breakpoints of current breakpoint group
	// but the breakpoints info in current breakpoint group remains unchanged
	public disableCurrentBreakpointGroupBreakpoints() {
		let currentIndex = -1;
		for (let j = 0; j < this.groups.length; j++) {
			if (this.groups[j].name === this.getCurrentBreakpointGroupName()) {
				currentIndex = j;
			}
		}
		if (currentIndex === -1) {
			return;
		}
		this.groups[currentIndex].setBreakpointsArguments.forEach((e) => {
			this.session.miDebugger.clearBreakPoints(e.source.path);
			this.session.showInformationMessage("disableCurrentBreakpointGroupBreakpoints successed. index= " + currentIndex);
		});
	}

	// When a breakpoint is triggered and the address space changes (e.g. kernel => user process),
	// cache the old group's breakpoints, clear them from GDB, unload old symbol files,
	// load new symbol files, and restore new group's breakpoints.
	public updateCurrentBreakpointGroup(updateTo: string, continueAfterUpdate: boolean = false) {
		let newIndex = -1;
		for (let i = 0; i < this.groups.length; i++) {
			if (this.groups[i].name === updateTo) {
				newIndex = i;
			}
		}
		if (newIndex === -1) {
			this.groups.push(new BreakpointGroup(updateTo, [], new HookBreakpoints([]), []));
			newIndex = this.groups.length - 1;
		}
		let oldIndex = -1;
		for (let j = 0; j < this.groups.length; j++) {
			if (this.groups[j].name === this.getCurrentBreakpointGroupName()) {
				oldIndex = j;
			}
		}
		if (oldIndex === -1) {
			this.groups.push(new BreakpointGroup(this.getCurrentBreakpointGroupName(), [], new HookBreakpoints([]), []));
			oldIndex = this.groups.length - 1;
		}

		// Update name immediately so callers see the new group right away.
		this.currentBreakpointGroupName = this.groups[newIndex].name;
		this.session.showInformationMessage("breakpoint group changed to " + updateTo);

		// 1. Clear old group's breakpoints from GDB (parallel, order doesn't matter)
		const clearOldPromises = this.groups[oldIndex].setBreakpointsArguments.map(
			(e) => this.session.miDebugger.clearBreakPoints(e.source.path)
		);

		// 2. Unload old symbol files, load new symbol files — must complete before
		//    re-inserting breakpoints so GDB can resolve source locations correctly.
		const oldSymbolFiles: SymbolFileEntry[] = eval(this.session.breakpointGroupNameToDebugFilePaths)(this.groups[oldIndex].name);
		const newSymbolFiles: SymbolFileEntry[] = eval(this.session.breakpointGroupNameToDebugFilePaths)(this.groups[newIndex].name);

		const toPath = (e: SymbolFileEntry) => typeof e === 'string' ? e : e.path;
		const toTextAddr = (e: SymbolFileEntry) => typeof e === 'string' ? undefined : e.textAddr;

		Promise.all(clearOldPromises)
			.then(() => Promise.all(oldSymbolFiles.map(f => this.session.miDebugger.removeSymbolFile(toPath(f)).catch(err => { console.error('[ardb] removeSymbolFile failed:', err); }))))
			.then(() => Promise.all(newSymbolFiles.map(f => this.session.miDebugger.addSymbolFile(toPath(f), toTextAddr(f)).catch(err => { console.error('[ardb] addSymbolFile failed:', err); }))))
			.then(() => {
				// 3. Re-insert new group's breakpoints
				const breakpointPromises = this.groups[newIndex].setBreakpointsArguments.map((args) => {
					return this.session.miDebugger.clearBreakPoints(args.source.path).then(
						() => {
							const path = args.source.path;
							const all = args.breakpoints!.map((brk) => {
								return this.session.miDebugger.addBreakPoint({
									file: path,
									line: brk.line,
									condition: brk.condition ?? "",
									countCondition: brk.hitCondition,
									logMessage: brk.logMessage
								});
							});
							return Promise.all(all);
						},
						(_msg) => [] as Array<[boolean, Breakpoint]>
					);
				});
				return Promise.all(breakpointPromises);
			})
			.then((nestedResults) => {
				// 4. Notify session to send BreakpointEvent('changed') for each restored BP
				const flat = (nestedResults as Array<Array<[boolean, Breakpoint]>>).flat();
				this.session.onBreakpointsRestored(flat);
				// 5. Now safe to continue execution
				if (continueAfterUpdate) {
					this.session.miDebugger.continue();
				}
			})
			.catch(err => {
				console.error('[ardb] updateCurrentBreakpointGroup failed:', err);
				if (continueAfterUpdate) {
					this.session.miDebugger.continue();
				}
			});
	}

	// there should NOT be a `setCurrentBreakpointGroupName()` because changing the name also
	// requires changing the breakpoint group itself — that's what `updateCurrentBreakpointGroup()` does.
	public getCurrentBreakpointGroupName(): string {
		return this.currentBreakpointGroupName;
	}

	// notice it can return undefined
	public getBreakpointGroupByName(groupName: string): BreakpointGroup | undefined {
		for (const k of this.groups) {
			if (k.name === groupName) {
				return k;
			}
		}
		return undefined;
	}

	// notice it can return undefined
	public getCurrentBreakpointGroup(): BreakpointGroup | undefined {
		const groupName = this.getCurrentBreakpointGroupName();
		for (const k of this.groups) {
			if (k.name === groupName) {
				return k;
			}
		}
		return undefined;
	}

	public getNextBreakpointGroup(): string {
		return this.nextBreakpointGroup;
	}

	public setNextBreakpointGroup(groupName: string) {
		this.nextBreakpointGroup = groupName;
	}

	public getAllBreakpointGroups(): readonly BreakpointGroup[] {
		return this.groups;
	}

	/** Returns true if the named group has at least one user-set breakpoint. */
	public groupHasBreakpoints(groupName: string): boolean {
		const group = this.getBreakpointGroupByName(groupName);
		if (!group) return false;
		return group.setBreakpointsArguments.some(
			args => (args.breakpoints ?? []).length > 0
		);
	}

	// save breakpoint information into a breakpoint group, but NOT let GDB set those breakpoints yet
	public saveBreakpointsToBreakpointGroup(args: DebugProtocol.SetBreakpointsArguments, groupName: string) {
		let found = -1;
		for (let i = 0; i < this.groups.length; i++) {
			if (this.groups[i].name === groupName) {
				found = i;
			}
		}
		if (found === -1) {
			this.groups.push(new BreakpointGroup(groupName, [], new HookBreakpoints([]), []));
			found = this.groups.length - 1;
		}
		let alreadyThere = -1;
		for (let i = 0; i < this.groups[found].setBreakpointsArguments.length; i++) {
			if (this.groups[found].setBreakpointsArguments[i].source.path === args.source.path) {
				this.groups[found].setBreakpointsArguments[i] = args;
				alreadyThere = i;
			}
		}
		if (alreadyThere === -1) {
			this.groups[found].setBreakpointsArguments.push(args);
		}
	}

	public updateBorder(border: Border) {
		const groupNamesOfBorder: string[] = eval(this.session.filePathToBreakpointGroupNames)(border.filepath);
		for (const groupNameOfBorder of groupNamesOfBorder) {
			let groupExists = false;
			for (const group of this.groups) {
				if (group.name === groupNameOfBorder) {
					groupExists = true;
					group.borders = group.borders ?? [];
					group.borders.push(border);
				}
			}
			if (groupExists === false) {
				this.groups.push(new BreakpointGroup(groupNameOfBorder, [], new HookBreakpoints([]), [border]));
			}
		}
	}

	// breakpoints are still there but they are no longer borders
	public disableBorder(border: Border) {
		const groupNamesOfBorder: string[] = eval(this.session.filePathToBreakpointGroupNames)(border.filepath);
		for (const groupNameOfBorder of groupNamesOfBorder) {
			for (const group of this.groups) {
				if (group.name === groupNameOfBorder) {
					group.borders = [];
				}
			}
		}
	}

	public updateHookBreakpoint(hook: HookBreakpointJSONFriendly) {
		const groupNames: string[] = eval(this.session.filePathToBreakpointGroupNames)(hook.breakpoint.file);
		for (const groupName of groupNames) {
			let groupExists = false;
			for (const existingGroup of this.groups) {
				if (existingGroup.name === groupName) {
					groupExists = true;
					existingGroup.hooks.set(toHookBreakpoint(hook));
				}
			}
			if (groupExists === false) {
				this.groups.push(new BreakpointGroup(groupName, [], new HookBreakpoints([toHookBreakpoint(hook)]), undefined));
			}
		}
	}

	// the breakpoints are still set, but they will no longer trigger user-defined behavior.
	public disableHookBreakpoint(hook: HookBreakpointJSONFriendly) {
		const groupNames: string[] = eval(this.session.filePathToBreakpointGroupNames)(hook.breakpoint.file);
		for (const groupName of groupNames) {
			for (const existingGroup of this.groups) {
				if (existingGroup.name === groupName) {
					existingGroup.hooks.remove(hook.breakpoint);
				}
			}
		}
	}

	// only used for reset
	public removeAllBreakpoints() {
		this.groups = [];
	}
}
