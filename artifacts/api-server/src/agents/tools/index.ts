// Tool resolution contract — the single mechanism all agent tools use.
// Coach uses it first (Phase 1). Later phases reuse it for the 42 chat tools
// + each specialist's domain tools. Behavior must remain stable across
// migrations — this is the load-bearing seam between LLM and existing handlers.
//
// Three pieces fit together:
//   1. ToolHandler — async function called by the runtime when Anthropic emits tool_use.
//   2. agent_tools row — DB registry: tool_name → handler module path.
//   3. resolveTool() — dynamic-import resolver used by runtime.ts multi-turn loop.

import { personalDb, agentToolsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { HANDLER_REGISTRY } from "./registry.js";

// ── The handler contract — every tool wrapper exports a function of this shape ──
//
// `input` is the parsed JSON Anthropic returned in tool_use.input. Schema is
// validated against the registry's input_schema by the runtime BEFORE this runs.
//
// `ctx` carries cross-cutting context (caller, agent, skill, threadId, user).
// Wrappers ignore it unless they need to scope by user / log to a thread / etc.
//
// The return value is JSON-serializable. The runtime stringifies it into the
// next user-turn's tool_result content. Wrappers may return:
//   - a string  (passed through verbatim — used by legacy chat tools that
//                already format human-readable strings like "✓ Message posted")
//   - any JSON-serializable value (object/array/number — runtime JSON.stringify's it)
//
// Throwing is also valid; runtime catches and converts to a tool_result with
// `is_error: true`. Don't use throws for "expected failures" (auth missing,
// not connected) — return a string with a ⚠️ / ✗ prefix instead, matching
// today's chat-tool convention. See ai-outputs/audit/current-tools-audit.md.

export interface AgentContext {
  agent: string;
  skill: string;
  caller: "direct" | "orchestrator" | "coach" | "cron";
  callerThreadId?: string;
  user?: string;        // email when known
  // Training-run id when caller='coach' — submit_proposal etc. need this.
  trainingRunId?: string;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: AgentContext,
) => Promise<string | unknown>;

// ── Tool spec passed to Anthropic ────────────────────────────────────────────
// Custom tool spec — function tools we implement on our side.
export interface AnthropicCustomToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

// Anthropic-native tool spec — shape varies per native tool. For server-side
// execution, Anthropic expects `{ type: 'web_search_20250305', name: '...' }`
// (or similar) instead of input_schema. We pass these through opaquely.
export type AnthropicNativeToolSpec = { type: string; name: string; [k: string]: unknown };

export type AnthropicToolSpec = AnthropicCustomToolSpec | AnthropicNativeToolSpec;

// Map from is_native=1 tool_name → Anthropic-native spec. Update whenever we
// register a new native tool in agent_tools (these names are Anthropic-defined).
const NATIVE_SPEC_MAP: Record<string, AnthropicNativeToolSpec> = {
  web_search: { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  // browse_url has no Anthropic-native equivalent yet — Claude reads URLs
  // returned by web_search automatically. If a real fetch is needed, replace
  // is_native=1 with a custom handler at agents/tools/orchestrator/browse_url.ts.
};

// ── Resolver — registry-row → loaded handler ─────────────────────────────────
//
// We dynamic-import the handler module by path. Modules export a default
// ToolHandler:
//
//   // src/agents/tools/coach/read_feedback.ts
//   export default async function readFeedback(input, ctx) { ... }
//
// `handler_path` in the registry is relative to this file's directory:
//   handler_path = 'coach/read_feedback'  →  ./coach/read_feedback.js
//
// We cache resolved modules per-process — they're pure code, never change.

const CACHE = new Map<string, ToolHandler>();

export async function resolveTool(toolName: string): Promise<{ handler: ToolHandler; spec: AnthropicToolSpec } | null> {
  const cached = CACHE.get(toolName);
  if (cached) {
    // We still need the spec — pull it again (DB row, light query).
    const spec = await loadSpec(toolName);
    return spec ? { handler: cached, spec } : null;
  }

  const [row] = await personalDb.select().from(agentToolsTable)
    .where(eq(agentToolsTable.toolName, toolName))
    .limit(1);
  if (!row) return null;

  // Native Anthropic tools (web_search, etc.) have no JS handler — they're
  // executed server-side by Anthropic. is_native=1 short-circuits resolution.
  // The spec we pass to Anthropic must use the native format (type+name+...),
  // NOT the custom-tool input_schema shape — Anthropic returns 400 otherwise.
  if (row.isNative === 1) {
    const nativeSpec = NATIVE_SPEC_MAP[row.toolName];
    if (!nativeSpec) {
      // Unknown native tool — log and treat as missing so the skill keeps
      // working (model just doesn't see this tool).
      console.warn(`[resolveTool] native tool '${row.toolName}' has no entry in NATIVE_SPEC_MAP — skipping.`);
      return null;
    }
    const noopHandler: ToolHandler = async () => {
      throw new Error(`Tool '${toolName}' is native (Anthropic-side); should not be resolved locally.`);
    };
    CACHE.set(toolName, noopHandler);
    return { handler: noopHandler, spec: nativeSpec };
  }

  // Static registry first — bundle-safe, no dynamic resolution at runtime.
  // Falls back to dynamic import only if a tool is registered in the DB but
  // hasn't been added to the static registry yet (development convenience).
  let handler = HANDLER_REGISTRY.get(row.handlerPath);

  if (!handler) {
    const mod = await import(`./${row.handlerPath}.js`).catch((err) => {
      throw new Error(`Tool '${toolName}' handler not in static registry AND dynamic import failed (${row.handlerPath}): ${err instanceof Error ? err.message : err}. Add it to tools/registry.ts.`);
    });
    handler = (mod.default || mod[toolName]) as ToolHandler | undefined;
    if (typeof handler !== "function") {
      throw new Error(`Tool '${toolName}' module ${row.handlerPath} has no default export of type ToolHandler`);
    }
  }

  CACHE.set(toolName, handler);
  return {
    handler,
    spec: {
      name: row.toolName,
      description: row.description || "",
      input_schema: row.inputSchema as AnthropicCustomToolSpec["input_schema"],
    },
  };
}

async function loadSpec(toolName: string): Promise<AnthropicToolSpec | null> {
  const [row] = await personalDb.select().from(agentToolsTable)
    .where(eq(agentToolsTable.toolName, toolName))
    .limit(1);
  if (!row) return null;
  if (row.isNative === 1) {
    return NATIVE_SPEC_MAP[row.toolName] || null;
  }
  return {
    name: row.toolName,
    description: row.description || "",
    input_schema: row.inputSchema as AnthropicCustomToolSpec["input_schema"],
  };
}

// ── Bulk-resolve a skill's declared tools (used by runtime per-call) ─────────
export async function resolveTools(toolNames: string[]): Promise<{
  specs: AnthropicToolSpec[];
  handlers: Record<string, ToolHandler>;
}> {
  const specs: AnthropicToolSpec[] = [];
  const handlers: Record<string, ToolHandler> = {};
  for (const name of toolNames) {
    const r = await resolveTool(name);
    if (!r) {
      console.warn(`[resolveTools] tool '${name}' not in registry — skipping`);
      continue;
    }
    specs.push(r.spec);
    handlers[name] = r.handler;
  }
  return { specs, handlers };
}
