import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-agentmemory";

export const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "AgentMemory",
  description: "Persistent memory for Paperclip SDLC agents. Injects relevant past context (memories + codebase structure) before each agent run and stores outcomes for future recall. Powered by agentmemory + CodeGraph.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: "memory_health",
      displayName: "AgentMemory: Health Check",
      description: "Check whether the agentmemory server is reachable and return its status.",
      parametersSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "memory_smart_search",
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
    {
      name: "memory_save",
      displayName: "AgentMemory: Save Observation",
      description: "Manually store a factual observation or decision into agentmemory for future recall.",
      parametersSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The observation text to store" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags e.g. ['architecture', 'auth', 'decision']" },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_sessions",
      displayName: "AgentMemory: Recent Sessions",
      description: "List recent agentmemory sessions for this project.",
      parametersSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max sessions to list (default 10)" } },
        required: [],
      },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      agentmemoryUrl: { type: "string", title: "AgentMemory Server URL", description: "Base URL of the running agentmemory server.", default: "http://localhost:3111" },
      agentmemorySecret: { type: "string", title: "AgentMemory Secret", description: "Bearer token (leave blank if unset).", default: "" },
      tokenBudget: { type: "number", title: "Token Budget", description: "Max tokens to inject per agent run.", default: 2000, minimum: 500, maximum: 8000 },
      memoryTokens: { type: "number", title: "Memory Token Allocation", description: "Portion of budget for agentmemory results.", default: 1200, minimum: 200, maximum: 6000 },
      codegraphHttpUrl: { type: "string", title: "CodeGraph HTTP Proxy URL", description: "Optional HTTP proxy for CodeGraph structural context. Leave blank to skip.", default: "" },
      teamId: { type: "string", title: "Team ID", description: "Optional team namespace forwarded to agentmemory.", default: "" },
    },
    required: [],
  },
};

export default manifest;
