import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
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
	quota_reset_at?: string;
	timestamp_utc?: string;
};

type QuotaSnapshots = Partial<Record<SnapshotKind, QuotaSnapshot>>;

type CopilotUsageResponse = {
	copilot_plan?: string;
	quota_reset_date?: string;
	quota_reset_date_utc?: string;
	quota_snapshots?: QuotaSnapshots;
};

type UsageRow = {
	kind: SnapshotKind;
	used: number | null;
	total: number | null;
	remaining: number | null;
	percentRemaining: number | null;
	overageCount: number | null;
	resetDate?: string;
	updatedAt?: string;
	unlimited: boolean;
	overageEnabled: boolean;
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
			overageCount: number | null;
			resetDate?: string;
			updatedAt?: string;
			unlimited: boolean;
			overageEnabled: boolean;
			rows: UsageRow[];
	  }
	| {
			status: "missing-auth";
	  }
	| {
			status: "error";
			message: string;
	  };

type UsageReportMessageDetails =
	| {
			status: "ok";
			plan?: string;
			updatedAt?: string;
			rows: UsageRow[];
	  }
	| {
			status: "missing-auth";
	  }
	| {
			status: "error";
			message: string;
	  };

type TableColumn = {
	header: string;
	align?: "left" | "right";
};

const STATUS_KEY = "github-copilot-usage";
const REPORT_MESSAGE_TYPE = "github-copilot-usage-report";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 20 * 1000;
const USER_AGENT = "GitHubCopilotChat/0.35.0";
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const COPILOT_INTEGRATION_ID = "vscode-chat";
const SNAPSHOT_ORDER: SnapshotKind[] = ["premium_interactions", "premium_models", "chat", "completions"];

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
		quota_reset_at: getString(value, "quota_reset_at"),
		timestamp_utc: getString(value, "timestamp_utc"),
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
		quota_reset_date_utc: getString(value, "quota_reset_date_utc"),
		quota_snapshots: quotaSnapshots,
	};
}

function hasQuotaData(snapshot: QuotaSnapshot): boolean {
	return (
		typeof snapshot.entitlement === "number" ||
		typeof snapshot.percent_remaining === "number" ||
		typeof snapshot.quota_remaining === "number" ||
		typeof snapshot.remaining === "number" ||
		typeof snapshot.overage_count === "number" ||
		snapshot.unlimited === true
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function toUsageRow(kind: SnapshotKind, snapshot: QuotaSnapshot, fallbackResetDate?: string): UsageRow {
	const unlimited = snapshot.unlimited === true;
	const total = typeof snapshot.entitlement === "number" && snapshot.entitlement > 0 ? snapshot.entitlement : null;
	const explicitOverageCount = typeof snapshot.overage_count === "number" && snapshot.overage_count > 0 ? snapshot.overage_count : 0;

	let rawRemaining: number | null = null;
	if (typeof snapshot.quota_remaining === "number") {
		rawRemaining = snapshot.quota_remaining;
	} else if (typeof snapshot.remaining === "number") {
		rawRemaining = snapshot.remaining;
	} else if (total !== null && typeof snapshot.percent_remaining === "number") {
		rawRemaining = (total * snapshot.percent_remaining) / 100;
	}

	const remaining = total !== null && rawRemaining !== null ? clamp(rawRemaining, 0, total) : rawRemaining;

	let rawUsed: number | null = null;
	if (total !== null && rawRemaining !== null) {
		rawUsed = total - rawRemaining;
	} else if (total !== null && typeof snapshot.percent_remaining === "number") {
		rawUsed = total * (1 - snapshot.percent_remaining / 100);
	}

	const normalizedRawUsed = rawUsed === null ? null : Math.max(0, rawUsed);
	const usedFromExplicitOverage = total !== null && explicitOverageCount > 0 ? total + explicitOverageCount : null;
	const used =
		normalizedRawUsed === null
			? usedFromExplicitOverage
			: usedFromExplicitOverage === null
				? normalizedRawUsed
				: Math.max(normalizedRawUsed, usedFromExplicitOverage);

	const derivedOverageCount = total !== null && used !== null ? Math.max(0, used - total) : explicitOverageCount;
	const overageCount = derivedOverageCount > 0 ? derivedOverageCount : null;
	const percentRemaining =
		overageCount !== null && total !== null
			? 0
			: typeof snapshot.percent_remaining === "number"
				? clamp(snapshot.percent_remaining, 0, 100)
				: total !== null && remaining !== null
					? clamp((remaining / total) * 100, 0, 100)
					: null;

	return {
		kind,
		used,
		total,
		remaining,
		percentRemaining,
		overageCount,
		resetDate: snapshot.quota_reset_at ?? fallbackResetDate,
		updatedAt: snapshot.timestamp_utc,
		unlimited,
		overageEnabled: snapshot.overage_permitted === true,
	};
}

function getUsageRows(snapshots: QuotaSnapshots | undefined, fallbackResetDate?: string): UsageRow[] {
	if (!snapshots) return [];

	const rows: UsageRow[] = [];
	for (const kind of SNAPSHOT_ORDER) {
		const snapshot = snapshots[kind];
		if (!snapshot || !hasQuotaData(snapshot)) continue;
		rows.push(toUsageRow(kind, snapshot, fallbackResetDate));
	}
	return rows;
}

function toUsageState(response: CopilotUsageResponse): UsageState {
	const fallbackResetDate = response.quota_reset_date_utc ?? response.quota_reset_date;
	const rows = getUsageRows(response.quota_snapshots, fallbackResetDate);
	if (rows.length === 0) {
		return { status: "error", message: "No GitHub Copilot quota data was returned." };
	}

	const primary = rows[0];
	return {
		status: "ok",
		plan: response.copilot_plan,
		kind: primary.kind,
		used: primary.used,
		total: primary.total,
		remaining: primary.remaining,
		percentRemaining: primary.percentRemaining,
		overageCount: primary.overageCount,
		resetDate: primary.resetDate,
		updatedAt: primary.updatedAt,
		unlimited: primary.unlimited,
		overageEnabled: primary.overageEnabled,
		rows,
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

function formatDateTime(date: string | undefined): string | null {
	if (!date) return null;
	const parsed = new Date(date);
	if (Number.isNaN(parsed.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(parsed);
}

function formatPercent(value: number | null): string {
	return value === null ? "—" : `${Math.round(value)}%`;
}

function getFooterPercentTone(percentRemaining: number | null): "dim" | "warning" | "error" {
	if (percentRemaining === null) return "dim";
	if (percentRemaining <= 10) return "error";
	if (percentRemaining <= 25) return "warning";
	return "dim";
}

function statusText(ctx: ExtensionContext, usage: UsageState): string | undefined {
	const theme = ctx.ui.theme;

	if (usage.status === "loading") {
		return undefined;
	}

	if (usage.status === "missing-auth") {
		return theme.fg("dim", "copilot /login");
	}

	if (usage.status === "error") {
		return theme.fg("dim", "copilot unavailable");
	}

	const total = usage.unlimited ? "∞" : formatNumber(usage.total);
	const ratio = `${formatNumber(usage.used)}/${total}`;
	const percent = usage.percentRemaining === null ? "" : `${formatPercent(usage.percentRemaining)} left`;
	const overage = usage.overageCount !== null ? `+${formatNumber(usage.overageCount)} over` : "";
	const parts = [theme.fg("dim", "copilot"), theme.fg("dim", ` ${ratio}`)];

	if (percent) {
		parts.push(theme.fg("dim", " "));
		parts.push(theme.fg(getFooterPercentTone(usage.percentRemaining), percent));
	}

	if (overage) {
		parts.push(theme.fg("dim", " "));
		parts.push(theme.fg("warning", overage));
	}

	return parts.join("");
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
	if (usage.overageCount !== null) {
		parts.push(`overage +${formatNumber(usage.overageCount)}`);
	}
	if (reset) {
		parts.push(`resets ${reset}`);
	}
	if (usage.overageEnabled) {
		parts.push("overages enabled");
	}

	return parts.join(" · ");
}

function toReportDetails(usage: UsageState): UsageReportMessageDetails {
	if (usage.status === "missing-auth") {
		return { status: "missing-auth" };
	}

	if (usage.status === "error") {
		return { status: "error", message: usage.message };
	}

	if (usage.status === "loading") {
		return { status: "error", message: "GitHub Copilot usage is still loading." };
	}

	const updatedAt = usage.updatedAt ?? usage.rows.find((row) => row.updatedAt)?.updatedAt;
	return {
		status: "ok",
		plan: usage.plan,
		updatedAt,
		rows: usage.rows,
	};
}

function padCell(text: string, width: number, align: "left" | "right"): string {
	return align === "right" ? text.padStart(width, " ") : text.padEnd(width, " ");
}

function renderAsciiTable(columns: TableColumn[], rows: string[][]): string {
	const widths = columns.map((column, index) => {
		const rowWidths = rows.map((row) => row[index]?.length ?? 0);
		return Math.max(column.header.length, ...rowWidths);
	});

	const horizontal = `+-${widths.map((width) => "-".repeat(width)).join("-+-")}-+`;
	const renderRow = (values: string[]) =>
		`| ${values
			.map((value, index) => padCell(value, widths[index], columns[index]?.align ?? "left"))
			.join(" | ")} |`;

	return [horizontal, renderRow(columns.map((column) => column.header)), horizontal, ...rows.map(renderRow), horizontal].join("\n");
}

function buildUsageTable(rows: UsageRow[]): string {
	const columns: TableColumn[] = [
		{ header: "Bucket" },
		{ header: "Used", align: "right" },
		{ header: "Total", align: "right" },
		{ header: "Remaining", align: "right" },
		{ header: "Left", align: "right" },
		{ header: "Overage" },
		{ header: "Reset" },
	];

	const values = rows.map((row) => [
		formatKind(row.kind),
		formatNumber(row.used),
		row.unlimited ? "∞" : formatNumber(row.total),
		row.unlimited ? "∞" : formatNumber(row.remaining),
		formatPercent(row.percentRemaining),
		row.overageCount !== null ? `+${formatNumber(row.overageCount)}` : row.overageEnabled ? "allowed" : "—",
		formatResetDate(row.resetDate) ?? "—",
	]);

	return renderAsciiTable(columns, values);
}

function buildReportText(details: UsageReportMessageDetails, theme: ExtensionContext["ui"]["theme"]): string {
	const title = theme.fg("accent", theme.bold("GitHub Copilot Usage"));

	if (details.status === "missing-auth") {
		return [title, "", "GitHub Copilot is not logged in.", "Run /login and choose GitHub Copilot."].join("\n");
	}

	if (details.status === "error") {
		return [title, "", theme.fg("error", details.message)].join("\n");
	}

	const lines = [title];
	if (details.plan) {
		lines.push(`${theme.fg("dim", "Plan:")} ${details.plan}`);
	}

	const updated = formatDateTime(details.updatedAt);
	if (updated) {
		lines.push(`${theme.fg("dim", "Updated:")} ${updated}`);
	}

	lines.push("", buildUsageTable(details.rows));
	return lines.join("\n");
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

	const refresh = async (ctx: ExtensionContext, options?: { force?: boolean }): Promise<void> => {
		const now = Date.now();
		if (!options?.force && now - lastRefreshAt < MIN_REFRESH_INTERVAL_MS && currentUsage.status === "ok") {
			updateStatus(ctx);
			return;
		}

		if (refreshPromise) {
			await refreshPromise;
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
	};

	const startTimer = (ctx: ExtensionContext): void => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			void refresh(ctx);
		}, REFRESH_INTERVAL_MS);
	};

	pi.registerMessageRenderer(REPORT_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as UsageReportMessageDetails | undefined;
		const fallbackMessage = typeof message.content === "string" ? message.content : "Unable to render GitHub Copilot usage report.";
		const text = buildReportText(details ?? { status: "error", message: fallbackMessage }, theme);
		const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerCommand("copilot-usage", {
		description: "Refresh and show GitHub Copilot plan usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await refresh(ctx, { force: true });
			pi.sendMessage({
				customType: REPORT_MESSAGE_TYPE,
				content: summaryText(currentUsage),
				display: true,
				details: toReportDetails(currentUsage),
			});
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
