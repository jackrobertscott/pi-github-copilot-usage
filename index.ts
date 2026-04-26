import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { readFile, readdir } from "node:fs/promises";
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

type CopilotModelRequestInfo = {
	modelId: string;
	modelName: string;
	requestsPerMessage: number | null;
};

type CopilotModelMultiplierRow = {
	name: string;
	paidRequestsPerMessage: number | null;
	freeRequestsPerMessage: number | null;
};

type CopilotClientVersionInfo = {
	pluginVersion: string | null;
	editorVersion: string | null;
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
			requestInfo: CopilotModelRequestInfo | null;
	  }
	| {
			status: "missing-auth";
	  }
	| {
			status: "error";
			message: string;
	  };

type UsageTableValueRow = {
	bucket: string;
	used: string;
	total: string;
	remaining: string;
	left: string;
	overage: string;
	reset: string;
};

type TableColumn = {
	key: keyof UsageTableValueRow;
	header: string;
	align?: "left" | "right";
};

const STATUS_KEY = "github-copilot-usage";
const REPORT_MESSAGE_TYPE = "github-copilot-usage-report";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 20 * 1000;
const USER_AGENT_FALLBACK = "pi-github-copilot-usage";
const COPILOT_CHAT_USER_AGENT_NAME = "GitHubCopilotChat";
const COPILOT_CHAT_PLUGIN_NAME = "copilot-chat";
const COPILOT_CHAT_EXTENSION_ID = "GitHub.copilot-chat";
const COPILOT_CHAT_EXTENSION_PREFIX = "github.copilot-chat-";
const COPILOT_INTEGRATION_ID = "vscode-chat";
const MARKETPLACE_EXTENSION_QUERY_URL = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const MARKETPLACE_MANIFEST_ASSET_TYPE = "Microsoft.VisualStudio.Code.Manifest";
const MARKETPLACE_QUERY_FLAGS = 103;
const CLIENT_VERSION_INFO_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LOCAL_COPILOT_EXTENSION_DIRS = [
	join(homedir(), ".vscode/extensions"),
	join(homedir(), ".vscode-insiders/extensions"),
	join(homedir(), ".cursor/extensions"),
	join(homedir(), ".windsurf/extensions"),
];
const SNAPSHOT_ORDER: SnapshotKind[] = ["premium_interactions", "premium_models", "chat", "completions"];
const MODEL_MULTIPLIERS_URL = "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/model-multipliers.yml";
const MODEL_MULTIPLIERS_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

let cachedModelMultiplierRows: CopilotModelMultiplierRow[] = [];
let cachedModelMultiplierLookup = new Map<string, CopilotModelMultiplierRow>();
let cachedModelMultiplierFetchedAt = 0;
let modelMultiplierRefreshPromise: Promise<void> | null = null;
let cachedCopilotClientVersionInfo: CopilotClientVersionInfo | null = null;
let cachedCopilotClientVersionInfoFetchedAt = 0;
let copilotClientVersionInfoRefreshPromise: Promise<CopilotClientVersionInfo | null> | null = null;

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

function getArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function compareVersionLike(a: string, b: string): number {
	const result = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
	return result < 0 ? -1 : result > 0 ? 1 : 0;
}

function parseVersionLike(value: string | undefined): string | null {
	if (!value) return null;
	const match = value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
	return match?.[0] ?? null;
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const text = await readFile(path, "utf8");
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function getCopilotEditorVersionFromManifest(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const engines = value.engines;
	if (!isRecord(engines)) return null;
	return parseVersionLike(getString(engines, "vscode"));
}

async function findInstalledCopilotClientVersionInfo(): Promise<CopilotClientVersionInfo | null> {
	let bestMatch: CopilotClientVersionInfo | null = null;

	for (const extensionsDir of LOCAL_COPILOT_EXTENSION_DIRS) {
		let entries;
		try {
			entries = await readdir(extensionsDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!entry.name.toLowerCase().startsWith(COPILOT_CHAT_EXTENSION_PREFIX)) continue;

			const packageJsonPath = join(extensionsDir, entry.name, "package.json");
			const packageJson = await readJsonFile(packageJsonPath);
			if (!isRecord(packageJson)) continue;

			const pluginVersion = parseVersionLike(getString(packageJson, "version") ?? entry.name);
			if (!pluginVersion) continue;

			const candidate: CopilotClientVersionInfo = {
				pluginVersion,
				editorVersion: getCopilotEditorVersionFromManifest(packageJson),
			};

			if (!bestMatch || compareVersionLike(candidate.pluginVersion ?? "", bestMatch.pluginVersion ?? "") > 0) {
				bestMatch = candidate;
			}
		}
	}

	return bestMatch;
}

function getMarketplaceManifestUrl(value: unknown): string | null {
	if (!isRecord(value)) return null;

	let bestMatch: { version: string; source: string } | null = null;

	for (const result of getArray(value.results)) {
		if (!isRecord(result)) continue;
		for (const extension of getArray(result.extensions)) {
			if (!isRecord(extension)) continue;
			for (const version of getArray(extension.versions)) {
				if (!isRecord(version)) continue;
				const versionNumber = parseVersionLike(getString(version, "version"));
				if (!versionNumber) continue;
				for (const file of getArray(version.files)) {
					if (!isRecord(file)) continue;
					if (getString(file, "assetType") !== MARKETPLACE_MANIFEST_ASSET_TYPE) continue;
					const source = getString(file, "source");
					if (!source) continue;
					if (!bestMatch || compareVersionLike(versionNumber, bestMatch.version) > 0) {
						bestMatch = { version: versionNumber, source };
					}
				}
			}
		}
	}

	return bestMatch?.source ?? null;
}

async function fetchLatestCopilotClientVersionInfo(): Promise<CopilotClientVersionInfo | null> {
	const response = await fetch(MARKETPLACE_EXTENSION_QUERY_URL, {
		method: "POST",
		headers: {
			Accept: "application/json;api-version=7.2-preview.1",
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT_FALLBACK,
		},
		body: JSON.stringify({
			filters: [{ criteria: [{ filterType: 7, value: COPILOT_CHAT_EXTENSION_ID }] }],
			flags: MARKETPLACE_QUERY_FLAGS,
		}),
	});

	if (!response.ok) {
		throw new Error(`Unable to fetch GitHub Copilot Chat marketplace metadata: ${response.status}`);
	}

	const metadata = (await response.json()) as unknown;
	const manifestUrl = getMarketplaceManifestUrl(metadata);
	if (!manifestUrl) {
		throw new Error("Unable to find the GitHub Copilot Chat manifest in marketplace metadata.");
	}

	const manifestResponse = await fetch(manifestUrl, {
		headers: {
			Accept: "application/json",
			"User-Agent": USER_AGENT_FALLBACK,
		},
	});

	if (!manifestResponse.ok) {
		throw new Error(`Unable to fetch the GitHub Copilot Chat manifest: ${manifestResponse.status}`);
	}

	const manifest = (await manifestResponse.json()) as unknown;
	if (!isRecord(manifest)) {
		throw new Error("Unable to parse the GitHub Copilot Chat manifest.");
	}

	const pluginVersion = parseVersionLike(getString(manifest, "version"));
	if (!pluginVersion) {
		throw new Error("GitHub Copilot Chat manifest did not include a usable version.");
	}

	return {
		pluginVersion,
		editorVersion: getCopilotEditorVersionFromManifest(manifest),
	};
}

async function resolveCopilotClientVersionInfo(options?: { force?: boolean }): Promise<CopilotClientVersionInfo | null> {
	const now = Date.now();
	if (
		!options?.force &&
		cachedCopilotClientVersionInfo &&
		now - cachedCopilotClientVersionInfoFetchedAt < CLIENT_VERSION_INFO_REFRESH_INTERVAL_MS
	) {
		return cachedCopilotClientVersionInfo;
	}

	if (copilotClientVersionInfoRefreshPromise) {
		return await copilotClientVersionInfoRefreshPromise;
	}

	copilotClientVersionInfoRefreshPromise = (async () => {
		const installed = await findInstalledCopilotClientVersionInfo();
		if (installed?.pluginVersion && installed.editorVersion) {
			cachedCopilotClientVersionInfo = installed;
			cachedCopilotClientVersionInfoFetchedAt = Date.now();
			return installed;
		}

		try {
			const latest = await fetchLatestCopilotClientVersionInfo();
			const merged = installed || latest
				? {
					pluginVersion: installed?.pluginVersion ?? latest?.pluginVersion ?? null,
					editorVersion: installed?.editorVersion ?? latest?.editorVersion ?? null,
				}
				: null;
			cachedCopilotClientVersionInfo = merged;
			cachedCopilotClientVersionInfoFetchedAt = Date.now();
			return merged;
		} catch {
			cachedCopilotClientVersionInfo = installed;
			cachedCopilotClientVersionInfoFetchedAt = Date.now();
			return installed;
		}
	})();

	try {
		return await copilotClientVersionInfoRefreshPromise;
	} finally {
		copilotClientVersionInfoRefreshPromise = null;
	}
}

function buildCopilotUsageRequestHeaders(refreshToken: string, versionInfo: CopilotClientVersionInfo | null): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${refreshToken}`,
		"Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
		"User-Agent": USER_AGENT_FALLBACK,
	};

	if (versionInfo?.pluginVersion) {
		headers["User-Agent"] = `${COPILOT_CHAT_USER_AGENT_NAME}/${versionInfo.pluginVersion}`;
		headers["Editor-Plugin-Version"] = `${COPILOT_CHAT_PLUGIN_NAME}/${versionInfo.pluginVersion}`;
	}

	if (versionInfo?.editorVersion) {
		headers["Editor-Version"] = `vscode/${versionInfo.editorVersion}`;
	}

	return headers;
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


function normalizeCopilotPlan(plan?: string): string | null {
	const normalized = plan?.trim().toLowerCase();
	return normalized ? normalized : null;
}

function isCopilotFreePlan(plan?: string): boolean {
	const normalizedPlan = normalizeCopilotPlan(plan);
	return normalizedPlan !== null && normalizedPlan.includes("free");
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function parseYamlScalar(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseModelMultiplierValue(value: string): number | null {
	const parsedValue = parseYamlScalar(value);
	if (!parsedValue || /^not applicable$/i.test(parsedValue)) return null;
	const numericValue = Number(parsedValue);
	return Number.isFinite(numericValue) ? numericValue : null;
}

function parseModelMultiplierRows(yamlText: string): CopilotModelMultiplierRow[] {
	const rows: CopilotModelMultiplierRow[] = [];
	let currentRow: Partial<CopilotModelMultiplierRow> | null = null;

	const pushCurrentRow = (): void => {
		if (!currentRow?.name) return;
		rows.push({
			name: currentRow.name,
			paidRequestsPerMessage: currentRow.paidRequestsPerMessage ?? null,
			freeRequestsPerMessage: currentRow.freeRequestsPerMessage ?? null,
		});
		currentRow = null;
	};

	for (const line of yamlText.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (trimmed.startsWith("- name:")) {
			pushCurrentRow();
			currentRow = { name: parseYamlScalar(trimmed.slice("- name:".length)) };
			continue;
		}

		if (!currentRow) continue;
		if (trimmed.startsWith("multiplier_paid:")) {
			currentRow.paidRequestsPerMessage = parseModelMultiplierValue(trimmed.slice("multiplier_paid:".length));
			continue;
		}
		if (trimmed.startsWith("multiplier_free:")) {
			currentRow.freeRequestsPerMessage = parseModelMultiplierValue(trimmed.slice("multiplier_free:".length));
		}
	}

	pushCurrentRow();
	return rows;
}

function getModelLookupKeys(...values: Array<string | undefined>): string[] {
	const normalizedKeys = new Set<string>();
	const transforms: Array<(value: string) => string> = [
		(value) => value.replace(/[-_]+/g, " "),
		(value) => value.replace(/\(preview\)/gi, " "),
		(value) => value.replace(/\bpublic preview\b/gi, " "),
		(value) => value.replace(/\bpreview\b/gi, " "),
		(value) => value.replace(/\bfast mode\b/gi, " fast "),
		(value) => value.replace(/\bmode\b/gi, " "),
	];

	for (const value of values) {
		const initial = normalizeWhitespace(value ?? "");
		if (!initial) continue;

		const variants = new Set<string>([initial]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const variant of Array.from(variants)) {
				for (const transform of transforms) {
					const nextVariant = normalizeWhitespace(transform(variant));
					if (nextVariant && !variants.has(nextVariant)) {
						variants.add(nextVariant);
						changed = true;
					}
				}
			}
		}

		for (const variant of variants) {
			const key = variant.toLowerCase().replace(/[^a-z0-9]+/g, "");
			if (key) normalizedKeys.add(key);
		}
	}

	return Array.from(normalizedKeys);
}

function buildModelMultiplierLookup(rows: CopilotModelMultiplierRow[]): Map<string, CopilotModelMultiplierRow> {
	const lookup = new Map<string, CopilotModelMultiplierRow>();
	for (const row of rows) {
		for (const key of getModelLookupKeys(row.name)) {
			if (!lookup.has(key)) {
				lookup.set(key, row);
			}
		}
	}
	return lookup;
}

async function fetchModelMultiplierRows(): Promise<CopilotModelMultiplierRow[]> {
	const response = await fetch(MODEL_MULTIPLIERS_URL, {
		headers: {
			Accept: "text/plain",
			"User-Agent": USER_AGENT_FALLBACK,
		},
	});

	if (!response.ok) {
		throw new Error(`Unable to fetch Copilot model multipliers: ${response.status}`);
	}

	const yamlText = await response.text();
	const rows = parseModelMultiplierRows(yamlText);
	if (rows.length === 0) {
		throw new Error("Unable to parse Copilot model multipliers from GitHub Docs.");
	}

	return rows;
}

async function refreshModelMultiplierCache(options?: { force?: boolean }): Promise<void> {
	const now = Date.now();
	if (
		!options?.force &&
		cachedModelMultiplierLookup.size > 0 &&
		now - cachedModelMultiplierFetchedAt < MODEL_MULTIPLIERS_REFRESH_INTERVAL_MS
	) {
		return;
	}

	if (modelMultiplierRefreshPromise) {
		await modelMultiplierRefreshPromise;
		return;
	}

	modelMultiplierRefreshPromise = (async () => {
		const rows = await fetchModelMultiplierRows();
		cachedModelMultiplierRows = rows;
		cachedModelMultiplierLookup = buildModelMultiplierLookup(rows);
		cachedModelMultiplierFetchedAt = Date.now();
	})();

	try {
		await modelMultiplierRefreshPromise;
	} finally {
		modelMultiplierRefreshPromise = null;
	}
}

function findModelMultiplierRow(model: ExtensionContext["model"]): CopilotModelMultiplierRow | null {
	if (!model || model.provider !== "github-copilot" || cachedModelMultiplierRows.length === 0) return null;
	for (const key of getModelLookupKeys(model.name, model.id)) {
		const row = cachedModelMultiplierLookup.get(key);
		if (row) return row;
	}
	return null;
}

function getRequestsPerMessageForModel(model: ExtensionContext["model"], plan?: string): number | null {
	const row = findModelMultiplierRow(model);
	if (!row) return null;
	return isCopilotFreePlan(plan) ? row.freeRequestsPerMessage : row.paidRequestsPerMessage;
}

function getCopilotModelRequestInfo(model: ExtensionContext["model"], plan?: string): CopilotModelRequestInfo | null {
	if (!model || model.provider !== "github-copilot") return null;
	if (cachedModelMultiplierLookup.size === 0) return null;
	return {
		modelId: model.id,
		modelName: model.name,
		requestsPerMessage: getRequestsPerMessageForModel(model, plan),
	};
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

	let clientVersionInfo: CopilotClientVersionInfo | null = null;
	try {
		clientVersionInfo = await resolveCopilotClientVersionInfo();
	} catch {
		clientVersionInfo = null;
	}

	const response = await fetch(getUserInfoUrl(credentials.enterpriseUrl), {
		headers: buildCopilotUsageRequestHeaders(credentials.refreshToken, clientVersionInfo),
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

function formatRequestValue(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "?";
	const rounded = Math.round(value * 100) / 100;
	if (Number.isInteger(rounded)) return `${rounded.toFixed(0)}`;
	if (Number.isInteger(rounded * 10)) return rounded.toFixed(1);
	return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatRequestRateCompact(value: number | null): string {
	return `${formatRequestValue(value)} req/msg`;
}

function formatRequestRateVerbose(value: number | null): string {
	return value === null ? "unknown" : `${formatRequestValue(value)} premium requests per user message`;
}

function getRequestRateTone(value: number | null): "dim" | "warning" {
	return value !== null && value > 1 ? "warning" : "dim";
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
	if (ctx.model?.provider !== "github-copilot") {
		return undefined;
	}

	const theme = ctx.ui.theme;
	const requestInfo = usage.status === "ok" ? getCopilotModelRequestInfo(ctx.model, usage.plan) : null;

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

	if (requestInfo) {
		parts.push(theme.fg("dim", " "));
		parts.push(theme.fg(getRequestRateTone(requestInfo.requestsPerMessage), formatRequestRateCompact(requestInfo.requestsPerMessage)));
	}

	return parts.join("");
}

function summaryText(usage: UsageState, model: ExtensionContext["model"]): string {
	if (usage.status === "loading") {
		return "GitHub Copilot usage is loading.";
	}

	if (usage.status === "missing-auth") {
		return "GitHub Copilot is not logged in. Run /login and choose GitHub Copilot.";
	}

	if (usage.status === "error") {
		return usage.message;
	}

	const requestInfo = getCopilotModelRequestInfo(model, usage.plan);
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
	if (requestInfo) {
		parts.push(`${requestInfo.modelName} ${formatRequestRateCompact(requestInfo.requestsPerMessage)}`);
	}

	return parts.join(" · ");
}

function toReportDetails(usage: UsageState, model: ExtensionContext["model"]): UsageReportMessageDetails {
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
		requestInfo: getCopilotModelRequestInfo(model, usage.plan),
	};
}

function toUsageTableValueRows(rows: UsageRow[]): UsageTableValueRow[] {
	return rows.map((row) => ({
		bucket: formatKind(row.kind),
		used: formatNumber(row.used),
		total: row.unlimited ? "∞" : formatNumber(row.total),
		remaining: row.unlimited ? "∞" : formatNumber(row.remaining),
		left: formatPercent(row.percentRemaining),
		overage: row.overageCount !== null ? `+${formatNumber(row.overageCount)}` : row.overageEnabled ? "allowed" : "—",
		reset: formatResetDate(row.resetDate) ?? "—",
	}));
}

function padToVisibleWidth(text: string, width: number, align: "left" | "right"): string {
	const padding = Math.max(0, width - visibleWidth(text));
	return align === "right" ? `${" ".repeat(padding)}${text}` : `${text}${" ".repeat(padding)}`;
}

function getTableWidths(columns: TableColumn[], rows: UsageTableValueRow[]): number[] {
	return columns.map((column) => {
		const rowWidths = rows.map((row) => visibleWidth(row[column.key]));
		return Math.max(visibleWidth(column.header), ...rowWidths);
	});
}

function getTableWidth(widths: number[]): number {
	return 1 + widths.reduce((sum, width) => sum + width + 3, 0);
}

function renderTableBorder(
	widths: number[],
	chars: { left: string; middle: string; right: string },
	theme: ExtensionContext["ui"]["theme"],
): string {
	return theme.fg("dim", `${chars.left}${widths.map((width) => "─".repeat(width + 2)).join(chars.middle)}${chars.right}`);
}

function styleTableCell(
	column: TableColumn,
	text: string,
	theme: ExtensionContext["ui"]["theme"],
	usageRow?: UsageRow,
	isHeader: boolean = false,
): string {
	if (isHeader) {
		return theme.fg("accent", theme.bold(text));
	}

	if (usageRow && column.key === "left" && usageRow.percentRemaining !== null) {
		return theme.fg(getFooterPercentTone(usageRow.percentRemaining), text);
	}

	if (usageRow && column.key === "overage" && usageRow.overageCount !== null) {
		return theme.fg("warning", text);
	}

	return text;
}

function renderTableRow(
	columns: TableColumn[],
	widths: number[],
	values: UsageTableValueRow,
	theme: ExtensionContext["ui"]["theme"],
	usageRow?: UsageRow,
	isHeader: boolean = false,
): string {
	const border = theme.fg("dim", "│");
	const cells = columns.map((column, index) => {
		const value = isHeader ? column.header : values[column.key];
		const padded = padToVisibleWidth(value, widths[index] ?? 0, column.align ?? "left");
		return ` ${styleTableCell(column, padded, theme, usageRow, isHeader)} `;
	});
	return `${border}${cells.join(border)}${border}`;
}

function renderUsageTable(
	rows: UsageRow[],
	width: number,
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	const valueRows = toUsageTableValueRows(rows);
	const layouts: TableColumn[][] = [
		[
			{ key: "bucket", header: "Bucket" },
			{ key: "used", header: "Used", align: "right" },
			{ key: "total", header: "Total", align: "right" },
			{ key: "remaining", header: "Remaining", align: "right" },
			{ key: "left", header: "Left", align: "right" },
			{ key: "overage", header: "Overage" },
			{ key: "reset", header: "Reset" },
		],
		[
			{ key: "bucket", header: "Bucket" },
			{ key: "used", header: "Used", align: "right" },
			{ key: "remaining", header: "Remaining", align: "right" },
			{ key: "left", header: "Left", align: "right" },
			{ key: "reset", header: "Reset" },
		],
		[
			{ key: "bucket", header: "Bucket" },
			{ key: "used", header: "Used", align: "right" },
			{ key: "left", header: "Left", align: "right" },
		],
	];

	for (const columns of layouts) {
		const widths = getTableWidths(columns, valueRows);
		if (getTableWidth(widths) > width) continue;

		const lines = [
			renderTableBorder(widths, { left: "┌", middle: "┬", right: "┐" }, theme),
			renderTableRow(
				columns,
				widths,
				{ bucket: "", used: "", total: "", remaining: "", left: "", overage: "", reset: "" },
				theme,
				undefined,
				true,
			),
			renderTableBorder(widths, { left: "├", middle: "┼", right: "┤" }, theme),
		];

		for (let index = 0; index < rows.length; index++) {
			const usageRow = rows[index];
			const valueRow = valueRows[index];
			if (!usageRow || !valueRow) continue;
			lines.push(renderTableRow(columns, widths, valueRow, theme, usageRow));
		}

		lines.push(renderTableBorder(widths, { left: "└", middle: "┴", right: "┘" }, theme));
		return lines;
	}

	const lines: string[] = [];
	const labelWidth = 9;
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const valueRow = valueRows[index];
		if (!row || !valueRow) continue;
		if (index > 0) {
			lines.push(theme.fg("dim", "─".repeat(Math.max(1, width))));
		}

		lines.push(truncateToWidth(theme.fg("accent", theme.bold(valueRow.bucket)), width));

		const fields: Array<{ label: string; value: string; tone?: "dim" | "warning" | "error" }> = [
			{ label: "Used", value: `${valueRow.used}/${valueRow.total}` },
			{ label: "Remain", value: valueRow.remaining },
			{ label: "Left", value: valueRow.left, tone: getFooterPercentTone(row.percentRemaining) },
			{
				label: "Overage",
				value: valueRow.overage,
				tone: row.overageCount !== null ? "warning" : undefined,
			},
			{ label: "Reset", value: valueRow.reset },
		];

		for (const field of fields) {
			const label = theme.fg("dim", `${field.label}:`.padEnd(labelWidth, " "));
			const valueText = field.tone ? theme.fg(field.tone, field.value) : field.value;
			const prefix = `  ${label} `;
			const availableWidth = Math.max(1, width - visibleWidth(prefix));
			lines.push(`${prefix}${truncateToWidth(valueText, availableWidth)}`);
		}
	}

	return lines;
}

function buildReportLines(
	details: UsageReportMessageDetails,
	theme: ExtensionContext["ui"]["theme"],
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const title = truncateToWidth(theme.fg("accent", theme.bold("GitHub Copilot Usage")), safeWidth);

	if (details.status === "missing-auth") {
		return [
			title,
			"",
			...wrapTextWithAnsi("GitHub Copilot is not logged in.", safeWidth),
			...wrapTextWithAnsi("Run /login and choose GitHub Copilot.", safeWidth),
		];
	}

	if (details.status === "error") {
		return [title, "", ...wrapTextWithAnsi(theme.fg("error", details.message), safeWidth)];
	}

	const lines = [title];
	if (details.plan) {
		lines.push(truncateToWidth(`${theme.fg("dim", "Plan:")} ${details.plan}`, safeWidth));
	}
	if (details.requestInfo) {
		lines.push(truncateToWidth(`${theme.fg("dim", "Model:")} ${details.requestInfo.modelName}`, safeWidth));
		lines.push(
			truncateToWidth(`${theme.fg("dim", "Per user msg:")} ${formatRequestRateVerbose(details.requestInfo.requestsPerMessage)}`, safeWidth),
		);
	}

	const updated = formatDateTime(details.updatedAt);
	if (updated) {
		lines.push(truncateToWidth(`${theme.fg("dim", "Updated:")} ${updated}`, safeWidth));
	}

	lines.push("", ...renderUsageTable(details.rows, safeWidth, theme));
	return lines;
}

class CopilotUsageReportComponent implements Component {
	constructor(
		private readonly details: UsageReportMessageDetails,
		private readonly theme: ExtensionContext["ui"]["theme"],
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return buildReportLines(this.details, this.theme, width);
	}
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
			const shouldRefreshMultipliers = ctx.model?.provider === "github-copilot";
			const multipliersPromise = shouldRefreshMultipliers
				? refreshModelMultiplierCache().catch(() => undefined)
				: Promise.resolve();

			try {
				currentUsage = await fetchUsage();
				lastRefreshAt = Date.now();
				updateStatus(ctx);
				await multipliersPromise;
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
		const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
		box.addChild(new CopilotUsageReportComponent(details ?? { status: "error", message: fallbackMessage }, theme));
		return box;
	});

	pi.registerCommand("copilot-usage", {
		description: "Refresh and show GitHub Copilot plan usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await refresh(ctx, { force: true });
			pi.sendMessage({
				customType: REPORT_MESSAGE_TYPE,
				content: summaryText(currentUsage, ctx.model),
				display: true,
				details: toReportDetails(currentUsage, ctx.model),
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
