/**
 * AgentMemory integration service for Paperclip.
 *
 * Provides two capabilities:
 *  1. Pre-run context enrichment: queries agentmemory + CodeGraph before each agent run
 *     and appends the result to paperclipTaskMarkdown.
 *  2. Post-run observation: stores run outcomes into agentmemory for future recall.
 *
 * Configuration via environment variables (all optional — falls back to no-op):
 *   AGENTMEMORY_URL          agentmemory REST base URL (default: http://localhost:3111)
 *   AGENTMEMORY_SECRET       Bearer token for agentmemory (default: unset)
 *   AGENTMEMORY_ENABLED      "true" | "false"  (default: false — opt-in)
 *   AGENTMEMORY_TOKEN_BUDGET  max tokens to inject per run (default: 2000)
 *   AGENTMEMORY_MEMORY_TOKENS  portion of budget for memory results (default: 1200)
 *   AGENTMEMORY_TEAM_ID      TEAM_ID scope forwarded to agentmemory (optional)
 *   CODEGRAPH_MCP_ENABLED    "true" | "false" — include structural codegraph context (default: false)
 *   CODEGRAPH_HTTP_URL       base URL for a codegraph HTTP proxy (e.g. http://localhost:3200)
 */

import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENTMEMORY_URL = process.env.AGENTMEMORY_URL ?? "http://localhost:3111";
const AGENTMEMORY_SECRET = process.env.AGENTMEMORY_SECRET ?? "";
const AGENTMEMORY_ENABLED = process.env.AGENTMEMORY_ENABLED === "true";
const AGENTMEMORY_TOKEN_BUDGET = Number(process.env.AGENTMEMORY_TOKEN_BUDGET ?? "2000");
const AGENTMEMORY_MEMORY_TOKENS = Number(process.env.AGENTMEMORY_MEMORY_TOKENS ?? "1200");
const AGENTMEMORY_TEAM_ID = process.env.AGENTMEMORY_TEAM_ID ?? "";
const CODEGRAPH_HTTP_URL = process.env.CODEGRAPH_HTTP_URL ?? "";
const CODEGRAPH_MCP_ENABLED = process.env.CODEGRAPH_MCP_ENABLED === "true";

// Rough chars-per-token estimate (conservative for mixed prose+code)
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// SDLC Phase routing
// ---------------------------------------------------------------------------

/**
 * Maps a Paperclip AgentRole to agentmemory query strategy and memory focus.
 * AgentRole values: ceo | cto | cmo | cfo | security | engineer | designer | pm | qa | devops | researcher | general
 */
type SdlcPhase = "architect" | "developer" | "reviewer" | "tester" | "devops" | "default";

function detectSdlcPhase(agentRole: string | null | undefined): SdlcPhase {
  switch (agentRole) {
    case "cto":
    case "ceo":
    case "pm":
    case "designer":
    case "researcher":
      return "architect";
    case "engineer":
    case "cmo":
    case "cfo":
    case "security":
      return "developer";
    case "qa":
      return "tester";
    case "devops":
      return "devops";
    case "general":
    default:
      return "default";
  }
}

interface PhaseQueryStrategy {
  memoryLimit: number;
  memoryScopeMode: "shared" | "isolated";
  /** Additional keywords to append to the smart-search query */
  queryPrefix: string;
  codegraphTaskSuffix: string;
}

const PHASE_STRATEGIES: Record<SdlcPhase, PhaseQueryStrategy> = {
  architect: {
    memoryLimit: 5,
    memoryScopeMode: "shared",
    queryPrefix: "architecture design decision ADR pattern",
    codegraphTaskSuffix: "architecture overview",
  },
  developer: {
    memoryLimit: 5,
    memoryScopeMode: "shared",
    queryPrefix: "implementation file pattern bug fix",
    codegraphTaskSuffix: "implementation entry points",
  },
  reviewer: {
    memoryLimit: 4,
    memoryScopeMode: "isolated",
    queryPrefix: "review feedback quality issue pattern",
    codegraphTaskSuffix: "callers impact",
  },
  tester: {
    memoryLimit: 4,
    memoryScopeMode: "shared",
    queryPrefix: "test case failure regression known issue",
    codegraphTaskSuffix: "test coverage functions",
  },
  devops: {
    memoryLimit: 3,
    memoryScopeMode: "shared",
    queryPrefix: "deployment infrastructure CI CD pipeline",
    codegraphTaskSuffix: "infrastructure config",
  },
  default: {
    memoryLimit: 5,
    memoryScopeMode: "shared",
    queryPrefix: "",
    codegraphTaskSuffix: "",
  },
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function agentmemoryHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AGENTMEMORY_SECRET) {
    headers["Authorization"] = `Bearer ${AGENTMEMORY_SECRET}`;
  }
  return headers;
}

async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  timeoutMs = 3000,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// agentmemory smart-search
// ---------------------------------------------------------------------------

interface MemorySearchResult {
  memories: Array<{
    content?: string;
    summary?: string;
    tags?: string[];
    score?: number;
    sessionId?: string;
    createdAt?: string;
  }>;
}

async function queryMemories(opts: {
  query: string;
  project: string;
  agentId: string;
  limit: number;
  scopeMode: "shared" | "isolated";
}): Promise<MemorySearchResult | null> {
  const body: Record<string, unknown> = {
    query: opts.query,
    project: opts.project,
    limit: opts.limit,
  };
  if (AGENTMEMORY_TEAM_ID) body.teamId = AGENTMEMORY_TEAM_ID;
  if (opts.scopeMode === "isolated") body.agentId = opts.agentId;

  return fetchJson<MemorySearchResult>(
    `${AGENTMEMORY_URL}/agentmemory/smart-search`,
    {
      method: "POST",
      headers: agentmemoryHeaders(),
      body: JSON.stringify(body),
    },
    3000,
  );
}

// ---------------------------------------------------------------------------
// CodeGraph HTTP proxy (optional)
// ---------------------------------------------------------------------------

interface CodeGraphContextResult {
  symbols?: Array<{ name: string; kind: string; file: string; line?: number; signature?: string }>;
  summary?: string;
}

async function queryCodegraphContext(opts: {
  task: string;
  maxNodes?: number;
}): Promise<CodeGraphContextResult | null> {
  if (!CODEGRAPH_HTTP_URL || !CODEGRAPH_MCP_ENABLED) return null;
  return fetchJson<CodeGraphContextResult>(
    `${CODEGRAPH_HTTP_URL}/context`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: opts.task, maxNodes: opts.maxNodes ?? 8, includeCode: false }),
    },
    3000,
  );
}

// ---------------------------------------------------------------------------
// Token budget enforcement
// ---------------------------------------------------------------------------

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...(truncated)";
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatMemorySection(
  results: MemorySearchResult | null,
  maxTokens: number,
): string {
  const memories = results?.memories ?? [];
  if (memories.length === 0) return "";

  const lines: string[] = ["## Relevant Past Context"];
  for (const mem of memories) {
    const text = (mem.summary ?? mem.content ?? "").trim();
    if (!text) continue;
    const tags = mem.tags?.length ? ` [${mem.tags.slice(0, 3).join(", ")}]` : "";
    lines.push(`- ${text}${tags}`);
  }
  if (lines.length <= 1) return "";
  return truncateToTokenBudget(lines.join("\n"), maxTokens);
}

function formatCodegraphSection(
  result: CodeGraphContextResult | null,
  maxTokens: number,
): string {
  if (!result) return "";

  const symbols = result.symbols ?? [];
  if (symbols.length === 0 && !result.summary) return "";

  const lines: string[] = ["## Codebase Structure (key symbols)"];
  if (result.summary) {
    lines.push(result.summary.trim());
  }
  for (const sym of symbols.slice(0, 12)) {
    const loc = sym.line ? `${sym.file}:${sym.line}` : sym.file;
    const sig = sym.signature ? ` — ${sym.signature}` : "";
    lines.push(`- **${sym.name}** (${sym.kind}) ${loc}${sig}`);
  }
  if (lines.length <= 1) return "";
  return truncateToTokenBudget(lines.join("\n"), maxTokens);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AgentMemoryEnrichmentInput {
  companyId: string;
  agentId: string;
  agentRole: string | null | undefined;
  issueId: string | null | undefined;
  issueIdentifier: string | null | undefined;
  issueTitle: string | null | undefined;
  issueDescription: string | null | undefined;
}

/**
 * Returns a markdown block to append to paperclipTaskMarkdown, or null if
 * agentmemory is disabled / unreachable / returns nothing useful.
 */
export async function enrichTaskContextWithMemory(
  input: AgentMemoryEnrichmentInput,
): Promise<string | null> {
  if (!AGENTMEMORY_ENABLED) return null;
  if (!input.issueTitle && !input.issueId) return null;

  const phase = detectSdlcPhase(input.agentRole);
  const strategy = PHASE_STRATEGIES[phase];

  const queryText = [
    strategy.queryPrefix,
    input.issueTitle ?? "",
    input.issueDescription?.slice(0, 300) ?? "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!queryText) return null;

  const memoryTokenBudget = AGENTMEMORY_MEMORY_TOKENS;
  const codegraphTokenBudget = AGENTMEMORY_TOKEN_BUDGET - AGENTMEMORY_MEMORY_TOKENS;
  const codegraphTask = [input.issueTitle ?? "", strategy.codegraphTaskSuffix]
    .filter(Boolean)
    .join(" ");

  let [memoryResult, codegraphResult] = await Promise.allSettled([
    queryMemories({
      query: queryText,
      project: input.companyId,
      agentId: input.agentRole ?? input.agentId,
      limit: strategy.memoryLimit,
      scopeMode: strategy.memoryScopeMode,
    }),
    queryCodegraphContext({ task: codegraphTask, maxNodes: 8 }),
  ]).then((results) => results.map((r) => (r.status === "fulfilled" ? r.value : null)));

  const memorySectionText = formatMemorySection(
    memoryResult as MemorySearchResult | null,
    memoryTokenBudget,
  );
  const codegraphSectionText = formatCodegraphSection(
    codegraphResult as CodeGraphContextResult | null,
    codegraphTokenBudget,
  );

  const sections = [memorySectionText, codegraphSectionText].filter(Boolean);
  if (sections.length === 0) return null;

  const header =
    `\n\n---\n*Memory context injected by Paperclip AgentMemory (SDLC phase: ${phase})*`;
  const body = sections.join("\n\n");

  return `${header}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Post-run observation
// ---------------------------------------------------------------------------

export interface AgentMemoryRunObservation {
  companyId: string;
  agentId: string;
  agentRole: string | null | undefined;
  runId: string;
  issueId: string | null | undefined;
  issueIdentifier: string | null | undefined;
  issueTitle: string | null | undefined;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  summary: string | null | undefined;
  /** File paths touched during this run (from adapter result metadata) */
  touchedFiles?: string[];
}

/**
 * Fire-and-forget: stores run outcome into agentmemory for future recall.
 * Never throws — errors are logged as warnings only.
 */
export function observeRunCompletion(obs: AgentMemoryRunObservation): void {
  if (!AGENTMEMORY_ENABLED) return;

  const content = buildObservationContent(obs);
  const tags: string[] = [
    obs.outcome,
    obs.agentRole ?? "agent",
    obs.issueIdentifier ?? obs.issueId ?? "no-issue",
  ].filter(Boolean);

  const body: Record<string, unknown> = {
    project: obs.companyId,
    content,
    tags,
    source: "paperclip-run",
    runId: obs.runId,
  };
  if (obs.agentRole) body.agentId = obs.agentRole;
  if (AGENTMEMORY_TEAM_ID) body.teamId = AGENTMEMORY_TEAM_ID;

  // fire-and-forget with timeout
  fetchJson(
    `${AGENTMEMORY_URL}/agentmemory/remember`,
    {
      method: "POST",
      headers: agentmemoryHeaders(),
      body: JSON.stringify(body),
    },
    5000,
  ).catch((err) => {
    logger.warn({ err, runId: obs.runId }, "agentmemory: failed to store run observation");
  });
}

function buildObservationContent(obs: AgentMemoryRunObservation): string {
  const parts: string[] = [];
  const issue = obs.issueIdentifier
    ? `${obs.issueIdentifier}: ${obs.issueTitle ?? "untitled"}`
    : (obs.issueTitle ?? obs.issueId ?? "no issue");
  parts.push(`Run ${obs.runId} on issue ${issue} ${obs.outcome}.`);
  if (obs.summary) {
    parts.push(obs.summary.slice(0, 500));
  }
  if (obs.touchedFiles && obs.touchedFiles.length > 0) {
    parts.push(`Files touched: ${obs.touchedFiles.slice(0, 10).join(", ")}`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// MCP server config helper (for adapter adapterConfig injection)
// ---------------------------------------------------------------------------

/**
 * Returns the agentmemory MCP server block to merge into an adapter's
 * mcpServers config. Returns null when agentmemory is disabled.
 */
export function getAgentmemoryMcpBlock(): Record<string, unknown> | null {
  if (!AGENTMEMORY_ENABLED) return null;
  const env: Record<string, string> = {
    AGENTMEMORY_URL,
  };
  if (AGENTMEMORY_SECRET) env.AGENTMEMORY_SECRET = AGENTMEMORY_SECRET;
  if (AGENTMEMORY_TEAM_ID) env.TEAM_ID = AGENTMEMORY_TEAM_ID;
  return {
    command: "npx",
    args: ["-y", "@agentmemory/mcp"],
    env,
  };
}
