/**
 * 任务进度条扩展 (Task Progress Bar Extension)
 *
 * 只要有任务在执行，就在输入框上方显示一条进度条：
 *   - 工具调用（bash / powershell 命令、文件读写等）执行期间
 *   - 模型生成回复期间
 *
 * 进度条是 0% 到 100% 的填充式进度条，例如 [███████░░░░░░░░░░░░░] 35% 12s：
 *   - 命令输出里出现百分比（curl / wget / pip / npm / huggingface 等都会打印
 *     "45%"/"45.6%"）时，直接用该百分比。
 *   - 给了 timeout（bash 工具参数，单位秒）时，按 已用时间 / timeout 换算。
 *   - 两者都没有时按已运行时间平滑增长，最多到 99%，避免空闲时假报完成。
 *   - 任务结束瞬间补满到 100%，停留 0.5 秒后消失，让用户看到走完一条完整的条。
 *
 * 安装位置：~/.pi/agent/extensions/progress-bar.ts
 *
 * 实现说明：
 *   - 定时器不在工厂函数里启动（工厂可能在不启动会话的调用中执行），改为第一个任务
 *     开始时启动、空闲和 session_shutdown 时清理。
 *   - 组件工厂每次刷新都会重建，和 image-upload.ts 的做法一致；只有动画帧由
 *     requestRender 驱动，不会重建组件。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "progress-bar";
const FRAME_MS = 120;
const BAR_WIDTH = 20;
/** 无百分比信息时的估算进度增长时间常数（毫秒），越大增长越慢 */
const GROWTH_MS = 8000;
/** 完成后补满 100% 的停留时间（毫秒） */
const DONE_LINGER_MS = 500;

/** 下载类命令：标签显示“下载”，其余显示“执行” */
const DOWNLOAD_RE = /\b(curl|wget|aria2c|pip3?|npm|pnpm|yarn|bun|git\s+clone|hf|huggingface|ollama)\b/i;

interface RunningTask {
	label: string;
	percent?: number;
	startedAt: number;
	/** 已知超时时间（毫秒），用于按时间换算进度 */
	timeoutMs?: number;
}

const running = new Map<string, RunningTask>();
let streamingSince: number | null = null;
let widgetCtx: ExtensionContext | null = null;
let activeTui: { requestRender(): void } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const doneTimers = new Set<ReturnType<typeof setTimeout>>();

function stopTimer(): void {
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
}

/** 从命令输出里抓最后一个百分比 */
function lastPercent(text: string): number | undefined {
	const re = /(\d{1,3}(?:\.\d+)?)%/g;
	const tail = text.slice(-4000);
	let last: number | undefined;
	for (let m = re.exec(tail); m; m = re.exec(tail)) {
		const n = Number(m[1]);
		if (n >= 0 && n <= 100) last = n;
	}
	return last;
}

function partialText(result: unknown): string {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => (c as { type?: string })?.type === "text")
		.map((c) => String((c as { text?: string }).text ?? ""))
		.join("");
}

function describe(tool: string, args: unknown): string {
	const a = (args ?? {}) as { command?: string; path?: string; file_path?: string };
	if (tool === "bash" || tool === "powershell") {
		const cmd = String(a.command ?? "").split("\n")[0]!.trim();
		const verb = DOWNLOAD_RE.test(cmd) ? "下载" : "执行";
		return `${verb} ${truncateToWidth(cmd, 48)}`;
	}
	const target = a.path ?? a.file_path ?? "";
	return `${tool} ${truncateToWidth(String(target), 48)}`.trim();
}

function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** 当前进度（0-100）。任务未结束时不超过 99%，避免假报完成 */
function currentPercent(task: RunningTask, now: number): number {
	if (task.percent !== undefined) return Math.min(100, task.percent);
	const elapsed = now - task.startedAt;
	if (task.timeoutMs) return Math.min(99, (elapsed / task.timeoutMs) * 100);
	return Math.min(99, 100 * (1 - Math.exp(-elapsed / GROWTH_MS)));
}

function bar(theme: ExtensionContext["ui"]["theme"], percent: number): string {
	const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH);
	const color = percent >= 100 ? "success" : "accent";
	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
}

function renderLine(theme: ExtensionContext["ui"]["theme"]): string {
	const now = Date.now();
	const tasks = [...running.values()];
	const pending = tasks.filter((t) => t.percent !== 100);
	// 未完成的优先；其次生成回复；最后才是刷满 100% 等待消失的任务
	const task = pending[0] ?? (streamingSince !== null ? { label: "生成回复中", startedAt: streamingSince } : tasks[0]);
	if (!task) return "";
	const percent = currentPercent(task, now);
	const extra = pending.length > 1 ? theme.fg("dim", ` +${pending.length - 1}`) : "";
	const right = `${percent.toFixed(0)}% ${fmtDuration(now - task.startedAt)}`;
	return `${theme.fg("muted", task.label)}${extra} ${bar(theme, percent)} ${theme.fg("dim", right)}`;
}

function idle(): boolean {
	return running.size === 0 && streamingSince === null;
}

/** 任务集合变化后刷新进度条控件 */
function refresh(): void {
	if (!widgetCtx?.hasUI) return;
	if (idle()) {
		stopTimer();
		activeTui = null;
		widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (timer === null) {
		timer = setInterval(() => activeTui?.requestRender(), FRAME_MS);
	}
	widgetCtx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;
			return { render: (w: number) => [truncateToWidth(renderLine(theme), w)], invalidate: () => {} };
		},
		{ placement: "aboveEditor" },
	);
	activeTui?.requestRender();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		widgetCtx = ctx;
	});

	pi.on("agent_start", async (_event, ctx) => {
		widgetCtx = ctx;
		streamingSince = Date.now();
		refresh();
	});

	pi.on("agent_end", async () => {
		streamingSince = null;
		refresh();
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		widgetCtx = ctx;
		const timeout = Number((event.args as { timeout?: number })?.timeout);
		running.set(event.toolCallId, {
			label: describe(event.toolName, event.args),
			startedAt: Date.now(),
			timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : undefined,
		});
		refresh();
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		widgetCtx = ctx;
		const task = running.get(event.toolCallId);
		if (!task) return;
		const percent = lastPercent(partialText(event.partialResult));
		if (percent === undefined) return;
		task.percent = percent;
		refresh();
	});

	pi.on("tool_execution_end", async (event) => {
		const task = running.get(event.toolCallId);
		if (!task) {
			refresh();
			return;
		}
		task.percent = 100;
		refresh();
		const done = setTimeout(() => {
			doneTimers.delete(done);
			running.delete(event.toolCallId);
			refresh();
		}, DONE_LINGER_MS);
		doneTimers.add(done);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		running.clear();
		streamingSince = null;
		for (const t of doneTimers) clearTimeout(t);
		doneTimers.clear();
		stopTimer();
		activeTui = null;
		widgetCtx = null;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
