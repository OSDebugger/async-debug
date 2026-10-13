// ARD OS-mode profiling (experiment B):
// measures breakpoint-group switch cost and single-step cost during
// kernel <-> user transitions, on the host side (extension process).
//
// Enabled per launch config:  "profileTs": true
// Optional log file:          "profileTsLog": "<path>"
// Every switch / single-step run prints one [ARD-PROFILE-TS] line to the
// debug console; a cumulative report is printed on disconnect.

import * as fs from 'fs';

export interface ProfileConfig {
    enabled: boolean;
    logPath?: string;
}

// Handle for one group-switch operation; step durations accumulate here.
export interface SwitchCtx {
    from: string;
    to: string;
    steps: Record<string, number>;   // step name -> ms
    tStart: number;
    tLast: number;
}

// Handle for one consecutive-single-step run.
export interface SingleStepCtx {
    direction: string;   // "kernel_to_user" or "user_to_kernel"
    steps: number;
    tStart: number;
}

interface SwitchSample {
    from: string;
    to: string;
    steps: Record<string, number>;
    totalMs: number;
}

interface SingleStepSample {
    direction: string;
    steps: number;
    totalMs: number;
}

export class OsProfiler {
    private enabled: boolean;
    private logPath: string | undefined;
    private switchSamples: SwitchSample[] = [];
    private singleStepSamples: SingleStepSample[] = [];

    constructor(cfg: ProfileConfig) {
        this.enabled = cfg.enabled;
        this.logPath = cfg.logPath;
    }

    private nowMs(): number {
        return Number(process.hrtime.bigint()) / 1e6;
    }

    private emit(line: string): void {
        console.log(`[ARD-PROFILE-TS] ${line}`);
        if (this.logPath) {
            try {
                fs.appendFileSync(this.logPath, line + '\n');
            } catch (e) {
                /* best-effort */
            }
        }
    }

    // ---- group switch ---------------------------------------------------

    beginSwitch(from: string, to: string): SwitchCtx | null {
        if (!this.enabled) { return null; }
        const t = this.nowMs();
        return { from, to, steps: {}, tStart: t, tLast: t };
    }

    markStep(ctx: SwitchCtx | null, name: string): void {
        if (!ctx) { return; }
        const now = this.nowMs();
        ctx.steps[name] = (ctx.steps[name] ?? 0) + (now - ctx.tLast);
        ctx.tLast = now;
    }

    endSwitch(ctx: SwitchCtx | null): void {
        if (!ctx) { return; }
        const totalMs = this.nowMs() - ctx.tStart;
        const parts = Object.entries(ctx.steps)
            .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
            .join(' ');
        this.emit(`switch ${ctx.from}->${ctx.to}: total=${totalMs.toFixed(1)}ms ${parts}`);
        this.switchSamples.push({ from: ctx.from, to: ctx.to, steps: ctx.steps, totalMs });
    }

    // ---- single stepping ------------------------------------------------

    beginSingleStep(direction: string): SingleStepCtx | null {
        if (!this.enabled) { return null; }
        return { direction, steps: 0, tStart: this.nowMs() };
    }

    countStep(ctx: SingleStepCtx | null): void {
        if (ctx) { ctx.steps += 1; }
    }

    endSingleStep(ctx: SingleStepCtx | null): void {
        if (!ctx) { return; }
        const totalMs = this.nowMs() - ctx.tStart;
        this.emit(`single-step ${ctx.direction}: ${ctx.steps} steps, total=${totalMs.toFixed(1)}ms, avg=${ctx.steps > 0 ? (totalMs / ctx.steps).toFixed(1) : '0'}ms/step`);
        this.singleStepSamples.push({ direction: ctx.direction, steps: ctx.steps, totalMs });
    }

    // ---- cumulative report ----------------------------------------------

    report(): void {
        if (!this.enabled) { return; }
        const lines: string[] = ['=== OS profiling report ==='];

        const switchTotal = this.switchSamples.reduce((s, x) => s + x.totalMs, 0);
        lines.push(`group switches: ${this.switchSamples.length}, total=${switchTotal.toFixed(1)}ms`);
        const stepNames = new Set<string>();
        this.switchSamples.forEach(s => Object.keys(s.steps).forEach(k => stepNames.add(k)));
        stepNames.forEach(name => {
            const total = this.switchSamples.reduce((s, x) => s + (x.steps[name] ?? 0), 0);
            lines.push(`  ${name}: total=${total.toFixed(1)}ms`);
        });
        this.switchSamples.forEach(s => {
            const parts = Object.entries(s.steps).map(([k, v]) => `${k}=${v.toFixed(1)}ms`).join(' ');
            lines.push(`  [${s.from}->${s.to}] total=${s.totalMs.toFixed(1)}ms ${parts}`);
        });

        const ssTotal = this.singleStepSamples.reduce((s, x) => s + x.totalMs, 0);
        const ssSteps = this.singleStepSamples.reduce((s, x) => s + x.steps, 0);
        lines.push(`single-step runs: ${this.singleStepSamples.length}, steps=${ssSteps}, total=${ssTotal.toFixed(1)}ms`);
        this.singleStepSamples.forEach(s => {
            lines.push(`  [${s.direction}] ${s.steps} steps, total=${s.totalMs.toFixed(1)}ms`);
        });

        this.emit(lines.join('\n'));
        this.switchSamples = [];
        this.singleStepSamples = [];
    }
}
