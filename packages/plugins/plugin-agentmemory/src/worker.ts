import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";

function readStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function readNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

interface PluginConfig {
  agentmemoryUrl: string;
  agentmemorySecret: string;
  tokenBudget: number;
  memoryTokens: number;
  codegraphHttpUrl: string;
  teamId: string;
}

function readConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    agentmemoryUrl: readStr(raw.agentmemoryUrl) || "http://localhost:3111",
    agentmemorySecret: readStr(raw.agentmemorySecret),
    tokenBudget: readNum(raw.tokenBudget, 2000),
    memoryTokens: readNum(raw.memoryTokens, 1200),
    codegraphHttpUrl: readStr(raw.codegraphHttpUrl),
    teamId: readStr(raw.teamId),
  };
}

function buildHeaders(cfg: PluginConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.agentmemorySecret) h["Authorization"] = `Bearer ${cfg.agentmemorySecret}`;
  return h;
}

async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  timeoutMs = 5000,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("AgentMemory plugin starting up", { pluginId: PLUGIN_ID });

    ctx.tools.register(
      "memory_health",
      {
        displayName: "AgentMemory: Health Check",
        description: "Check whether the agentmemory server is reachable and return its status.",
        parametersSchema: { type: "object", properties: {}, required: [] },
      },
      async (_params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const cfg = readConfig(await ctx.config.get());
        const result = await fetchJson<unknown>(`${cfg.agentmemoryUrl}/agentmemory/health`, {
          method: "GET",
          headers: buildHeaders(cfg),
        });
        if (!result.ok) {
          return { content: `agentmemory unreachable at ${cfg.agentmemoryUrl}: ${result.error}`, error: result.error };
        }
        const detail = JSON.stringify(result.data, null, 2);
        return { content: `agentmemory OK at ${cfg.agentmemoryUrl}\n${detail}`, data: result.data };
      },
    );

    ctx.tools.register(
      "memory_smart_search",
      {
        displayName: "AgentMemory: Smart Search",
        description: "Search agentmemory for past observations, decisions, and patterns relevant to a given query.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (issue title, topic, keywords)" },
            limit: { type: "number", description: "Max results to return (default 5)" },
          },
          required: ["query"],
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const cfg = readConfig(await ctx.config.get());
        const query = readStr(p.query);
        const limit = readNum(p.limit, 5);
        const body: Record<string, unknown> = { query, project: runCtx.companyId, limit };
        if (cfg.teamId) body.teamId = cfg.teamId;
        const result = await fetchJson<unknown>(`${cfg.agentmemoryUrl}/agentmemory/smart-search`, {
          method: "POST",
          headers: buildHeaders(cfg),
          body: JSON.stringify(body),
        });
        if (!result.ok) return { error: result.error };
        return { content: JSON.stringify(result.data, null, 2), data: result.data };
      },
    );

    ctx.tools.register(
      "memory_save",
      {
        displayName: "AgentMemory: Save Observation",
        description: "Manually store a factual observation or decision into agentmemory for future recall.",
        parametersSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The observation text to store" },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
          },
          required: ["content"],
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const cfg = readConfig(await ctx.config.get());
        const content = readStr(p.content);
        if (!content) return { error: "content is required" };
        const tags = Array.isArray(p.tags)
          ? (p.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        const body: Record<string, unknown> = { project: runCtx.companyId, content, tags, source: "manual-plugin-save" };
        if (cfg.teamId) body.teamId = cfg.teamId;
        const result = await fetchJson<unknown>(`${cfg.agentmemoryUrl}/agentmemory/remember`, {
          method: "POST",
          headers: buildHeaders(cfg),
          body: JSON.stringify(body),
        });
        if (!result.ok) return { error: result.error };
        return { content: "Observation saved to agentmemory.", data: result.data };
      },
    );

    ctx.tools.register(
      "memory_sessions",
      {
        displayName: "AgentMemory: Recent Sessions",
        description: "List recent agentmemory sessions for this project.",
        parametersSchema: {
          type: "object",
          properties: { limit: { type: "number", description: "Max sessions to list (default 10)" } },
          required: [],
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const cfg = readConfig(await ctx.config.get());
        const limit = readNum(p.limit, 10);
        const url = `${cfg.agentmemoryUrl}/agentmemory/sessions?project=${encodeURIComponent(runCtx.companyId)}&limit=${limit}`;
        const result = await fetchJson<unknown>(url, { method: "GET", headers: buildHeaders(cfg) });
        if (!result.ok) return { error: result.error };
        return { content: JSON.stringify(result.data, null, 2), data: result.data };
      },
    );

    ctx.logger.info("AgentMemory plugin ready", { pluginId: PLUGIN_ID });
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
