import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type SnapshotKind = "premium_interactions" | "premium_models" | "chat" | "completions";

type CopilotCredentials = {
	refreshToken: string;
	enterpriseUrl?: string;
};

type QuotaSnapshot = {
	entitlement?: number;
	percent_remaining?: number;
	quota_remaining?: number;
	remaining?: number;
	unlimited?: boolean;
	overage_count?: number;
	overage_permitted?: boolean;
};

type QuotaSnapshots = Partial<Record<SnapshotKind, QuotaSnapshot>>;

type CopilotUsageResponse = {
	copilot_plan?: string;
	quota_reset_date?: string;
	quota_snapshots?: QuotaSnapshots;
};

type UsageState =
	| {
		status: "loading";
	}
	| {
		status: "ok";
		plan?: string;
		kind: SnapshotKind;
		used: number | null;
		total: number | null;
		remaining: number | null;
		percentRemaining: number | null;
		resetDate?: string;
		unlimited: boolean;
		overageEnabled: boolean;
	}
	| {
		status: "missing-auth";
	}
	| {
		status: "error";
		message: string;
	};

const STATUS_KEY = "github-copilot-usage";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 20 * 1000;
const USER_AGENT = "GitHubCopilotChat/0.35.0";
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const COPILOT_INTEGRATION_ID = "vscode-chat";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

async function readCopilotCredentials(): Promise<CopilotCredentials | null> {
	const authPath = join(homedir(), ".pi/agent/auth.json");
	const authText = await readFile(authPath, "utf8");
	const parsed = JSON.parse(authText) as unknown;
	if (!isRecord(parsed)) return null;

	const copilotEntry = parsed["github-copilot"];
	if (!isRecord(copilotEntry)) return null;

	const refreshToken = getString(copilotEntry, "refresh");
	if (!refreshToken) return null;

	return {
		refreshToken,
		enterpriseUrl: getString(copilotEntry, "enterpriseUrl"),
	};
}

function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getUserInfoUrl(enterpriseUrl?: string): string {
	const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : null;
	return domain ? `https://api.${domain}/copilot_internal/user` : "https://api.github.com/copilot_internal/user";
}

function parseQuotaSnapshot(value: unknown): QuotaSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	return {
		entitlement: getNumber(value, "entitlement"),
		percent_remaining: getNumber(value, "percent_remaining"),
		quota_remaining: getNumber(value, "quota_remaining"),
		remaining: getNumber(value, "remaining"),
		unlimited: getBoolean(value, "unlimited"),
		overage_count: getNumber(value, "overage_count"),
		overage_permitted: getBoolean(value, "overage_permitted"),
	};
}

function parseUsageResponse(value: unknown): CopilotUsageResponse | null {
	if (!isRecord(value)) return null;

	const snapshotsValue = value.quota_snapshots;
	let quotaSnapshots: QuotaSnapshots | undefined;
	if (isRecord(snapshotsValue)) {
		quotaSnapshots = {
			premium_interactions: parseQuotaSnapshot(snapshotsValue.premium_interactions),
			premium_models: parseQuotaSnapshot(snapshotsValue.premium_models),
			chat: parseQuotaSnapshot(snapshotsValue.chat),
			completions: parseQuotaSnapshot(snapshotsValue.completions),
		};
	}

	return {
		copilot_plan: getString(value, "copilot_plan"),
		quota_reset_date: getString(value, "quota_reset_date"),
		quota_snapshots: quotaSnapshots,
	};
}

function chooseSnapshot(snapshots: QuotaSnapshots | undefined): { kind: SnapshotKind; snapshot: QuotaSnapshot } | null {
	if (!snapshots) return null;

	const order: SnapshotKind[] = ["premium_interactions", "premium_models", "chat", "completions"];
	for (const kind of order) {
		const snapshot = snapshots[kind];
		if (!snapshot) continue;
		if (
			typeof snapshot.entitlement === "number" ||
			typeof snapshot.percent_remaining === "number" ||
			typeof snapshot.quota_remaining === "number" ||
			typeof snapshot.remaining === "number" ||
			snapshot.unlimited === true
		) {
			return { kind, snapshot };
		}
	}

	return null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function toUsageState(response: CopilotUsageResponse): UsageState {
	const selected = chooseSnapshot(response.quota_snapshots);
	if (!selected) {
		return { status: "error", message: "No GitHub Copilot quota data was returned." };
	}

	const { kind, snapshot } = selected;
	const unlimited = snapshot.unlimited === true;
	const total = typeof snapshot.entitlement === "number" && snapshot.entitlement > 0 ? snapshot.entitlement : null;

	let remaining: number | null = null;
	if (typeof snapshot.quota_remaining === "number") {
		remaining = snapshot.quota_remaining;
	} else if (typeof snapshot.remaining === "number") {
		remaining = snapshot.remaining;
	} else if (total !== null && typeof snapshot.percent_remaining === "number") {
		remaining = (total * snapshot.percent_remaining) / 100;
	}

	if (total !== null && remaining !== null) {
		remaining = clamp(remaining, 0, total);
	}

	let used: number | null = null;
	if (total !== null && remaining !== null) {
		used = total - remaining;
	} else if (total !== null && typeof snapshot.percent_remaining === "number") {
		used = total * (1 - snapshot.percent_remaining / 100);
	}

	const percentRemaining =
		typeof snapshot.percent_remaining === "number"
			? clamp(snapshot.percent_remaining, 0, 100)
			: total !== null && remaining !== null
				? clamp((remaining / total) * 100, 0, 100)
				: null;

	return {
		status: "ok",
		plan: response.copilot_plan,
		kind,
		used,
		total,
		remaining,
		percentRemaining,
		resetDate: response.quota_reset_date,
		unlimited,
		overageEnabled: snapshot.overage_permitted === true,
	};
}

function getErrorCode(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

async function fetchUsage(): Promise<UsageState> {
	let credentials: CopilotCredentials | null;
	try {
		credentials = await readCopilotCredentials();
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			return { status: "missing-auth" };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { status: "error", message: `Unable to read pi auth.json: ${message}` };
	}

	if (!credentials) {
		return { status: "missing-auth" };
	}

	const response = await fetch(getUserInfoUrl(credentials.enterpriseUrl), {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${credentials.refreshToken}`,
			"User-Agent": USER_AGENT,
			"Editor-Version": EDITOR_VERSION,
			"Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
			"Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
		},
	});

	const body = (await response.json()) as unknown;
	if (!response.ok) {
		const errorMessage = isRecord(body) ? getString(body, "message") : undefined;
		return {
			status: "error",
			message: errorMessage ? `GitHub returned ${response.status}: ${errorMessage}` : `GitHub returned ${response.status}`,
		};
	}

	const usageResponse = parseUsageResponse(body);
	if (!usageResponse) {
		return { status: "error", message: "GitHub returned an unexpected Copilot usage payload." };
	}

	return toUsageState(usageResponse);
}

function formatNumber(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "?";
	const rounded = Math.round(value * 10) / 10;
	const abs = Math.abs(rounded);

	if (abs >= 1000) {
		const compact = Math.round((rounded / 1000) * 10) / 10;
		return Number.isInteger(compact) ? `${compact.toFixed(0)}k` : `${compact.toFixed(1)}k`;
	}

	return Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
}

function formatKind(kind: SnapshotKind): string {
	switch (kind) {
		case "premium_interactions":
			return "premium";
		case "premium_models":
			return "models";
		case "chat":
			return "chat";
		case "completions":
			return "completions";
	}
}

function formatResetDate(date: string | undefined): string | null {
	if (!date) return null;
	const parsed = new Date(date);
	if (Number.isNaN(parsed.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	}).format(parsed);
}

function statusText(ctx: ExtensionContext, usage: UsageState): string | undefined {
	const theme = ctx.ui.theme;

	if (usage.status === "loading") {
		return undefined;
	}

	if (usage.status === "missing-auth") {
		return theme.fg("dim", "🐙 Copilot /login");
	}

	if (usage.status === "error") {
		return theme.fg("warning", "🐙 Copilot unavailable");
	}

	const total = usage.unlimited ? "∞" : formatNumber(usage.total);
	const ratio = `${formatNumber(usage.used)}/${total}`;
	return (
		theme.fg("accent", "🐙") +
		theme.fg("dim", " Copilot ") +
		theme.fg("text", ratio) +
		theme.fg("dim", ` ${formatKind(usage.kind)}`)
	);
}

function summaryText(usage: UsageState): string {
	if (usage.status === "loading") {
		return "GitHub Copilot usage is loading.";
	}

	if (usage.status === "missing-auth") {
		return "GitHub Copilot is not logged in. Run /login and choose GitHub Copilot.";
	}

	if (usage.status === "error") {
		return usage.message;
	}

	const total = usage.unlimited ? "∞" : formatNumber(usage.total);
	const remaining = usage.unlimited ? "∞" : formatNumber(usage.remaining);
	const reset = formatResetDate(usage.resetDate);
	const parts = [
		`GitHub Copilot ${usage.plan ?? ""}`.trim(),
		`${formatKind(usage.kind)} used ${formatNumber(usage.used)}/${total}`,
		`remaining ${remaining}`,
	];

	if (usage.percentRemaining !== null) {
		parts.push(`${Math.round(usage.percentRemaining)}% left`);
	}
	if (reset) {
		parts.push(`resets ${reset}`);
	}
	if (usage.overageEnabled) {
		parts.push("overages enabled");
	}

	return parts.join(" · ");
}

function notificationLevel(usage: UsageState): "info" | "error" {
	return usage.status === "error" ? "error" : "info";
}

export default function githubCopilotUsageExtension(pi: ExtensionAPI) {
	let currentUsage: UsageState = { status: "loading" };
	let refreshPromise: Promise<void> | null = null;
	let lastRefreshAt = 0;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx, currentUsage));
	};

	const refresh = async (
		ctx: ExtensionContext,
		options?: { force?: boolean; announce?: boolean },
	): Promise<void> => {
		const now = Date.now();
		if (!options?.force && now - lastRefreshAt < MIN_REFRESH_INTERVAL_MS && currentUsage.status === "ok") {
			updateStatus(ctx);
			if (options?.announce && ctx.hasUI) {
				ctx.ui.notify(summaryText(currentUsage), "info");
			}
			return;
		}

		if (refreshPromise) {
			await refreshPromise;
			if (options?.announce && ctx.hasUI) {
				ctx.ui.notify(summaryText(currentUsage), notificationLevel(currentUsage));
			}
			return;
		}

		if (currentUsage.status !== "ok") {
			currentUsage = { status: "loading" };
			updateStatus(ctx);
		}

		refreshPromise = (async () => {
			try {
				currentUsage = await fetchUsage();
				lastRefreshAt = Date.now();
				updateStatus(ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				currentUsage = { status: "error", message };
				lastRefreshAt = Date.now();
				updateStatus(ctx);
			}
		})();

		try {
			await refreshPromise;
		} finally {
			refreshPromise = null;
		}

		if (options?.announce && ctx.hasUI) {
			ctx.ui.notify(summaryText(currentUsage), notificationLevel(currentUsage));
		}
	};

	const startTimer = (ctx: ExtensionContext): void => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			void refresh(ctx);
		}, REFRESH_INTERVAL_MS);
	};

	pi.registerCommand("copilot-usage", {
		description: "Refresh and show GitHub Copilot plan usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await refresh(ctx, { force: true, announce: true });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
		startTimer(ctx);
		await refresh(ctx, { force: true });
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model?.provider !== "github-copilot") return;
		await refresh(ctx, { force: true });
	});

	pi.on("model_select", async (event, ctx) => {
		updateStatus(ctx);
		if (event.model.provider === "github-copilot") {
			await refresh(ctx, { force: true });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
