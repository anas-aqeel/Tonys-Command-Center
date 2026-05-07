// Layered prompt composition with explicit Anthropic prompt-cache markers.
// Three layers, each gets its own cache_control: ephemeral block:
//   L1 global: rows where agent='_shared'
//   L2 agent:  rows where agent=<x> AND kind IN ('soul','user')
//   L3 skill:  the skill body (kind='skill') + declared memory_sections
//
// Returns blocks in Anthropic system-array form, ready to pass as
// `system: blocks` to messages.create().

import { db, agentMemoryEntriesTable, agentSkillsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { decryptKeyFromString, type Tier } from "@workspace/integrations-anthropic-ai";

export interface CachedSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

const VALID_TIERS: ReadonlySet<Tier> = new Set(["basic", "medium", "complex"]);

// Narrow the DB column (`text`) to the runtime Tier union. Returns null when
// the row's tier is missing or unrecognised — caller falls back to the
// featureName-based default in that case.
function narrowTier(raw: string | null): Tier | null {
  if (raw && VALID_TIERS.has(raw as Tier)) return raw as Tier;
  return null;
}

export interface SkillRecord {
  agent: string;
  skillName: string;
  model: string;
  maxTokens: number;
  tools: string[];
  memorySections: string[];
  modelOverride: string | null;
  providerOverride: string | null;
  tier: Tier | null;
  /** Already-decrypted skill API key (agent_skills.api_key_cipher). Null when
   *  not configured — runtime then falls back to the provider's tier-row key. */
  apiKeyOverride: string | null;
  /** Optional base URL paired with apiKeyOverride (agent_skills.base_url). */
  baseUrl: string | null;
}

export async function loadSkill(agent: string, skillName: string): Promise<SkillRecord | null> {
  const rows = await db.select().from(agentSkillsTable)
    .where(and(eq(agentSkillsTable.agent, agent), eq(agentSkillsTable.skillName, skillName)))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];

  // Decrypt the skill's own API key if present. Failures here are non-fatal —
  // we log and fall through to tier-default behavior so a misconfigured key
  // never bricks an agent.
  const cipherBlob = (r as { apiKeyCipher?: string | null }).apiKeyCipher ?? null;
  let apiKeyOverride: string | null = null;
  if (cipherBlob) {
    try {
      apiKeyOverride = decryptKeyFromString(cipherBlob);
    } catch (err) {
      console.warn(
        `[prompt-builder] decrypt failed for ${agent}.${skillName}; ignoring skill key:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    agent: r.agent,
    skillName: r.skillName,
    model: r.modelOverride || r.model,
    maxTokens: r.maxTokens,
    tools: Array.isArray(r.tools) ? r.tools as string[] : [],
    memorySections: Array.isArray(r.memorySections) ? r.memorySections as string[] : [],
    modelOverride: r.modelOverride,
    providerOverride: (r as { providerOverride?: string | null }).providerOverride ?? null,
    tier: narrowTier(r.tier),
    apiKeyOverride,
    baseUrl: (r as { baseUrl?: string | null }).baseUrl ?? null,
  };
}

async function loadGlobalLayer(): Promise<string> {
  const rows = await db.select().from(agentMemoryEntriesTable)
    .where(eq(agentMemoryEntriesTable.agent, "_shared"));
  if (rows.length === 0) return "";
  return rows.map(r => `# ${r.kind.toUpperCase()} — ${r.sectionName}\n\n${r.content}`).join("\n\n---\n\n");
}

async function loadAgentLayer(agent: string): Promise<string> {
  // L2 loads behavior content: SOUL (voice) + USER (context/preferences).
  //
  // Intentionally excluded:
  //   - 'agents' (AGENTS.md): documented as "slim INDEX. NOT loaded into prompts
  //     at runtime" by every AGENTS.md file itself. Skill routing happens via the
  //     `agent_skills` registry, not via the markdown index.
  //   - 'tools' (TOOLS.md): tool specs (name + description + input_schema) are
  //     passed via Anthropic's `params.tools` parameter — the model receives them
  //     as STRUCTURED data, not text. Including TOOLS.md in the system prompt
  //     duplicates that information in prose. Tool-use guidelines (the small
  //     "## Tool-use guidelines" section in each TOOLS.md) are common-sense
  //     behaviors the model already follows; if any agent needs a specific
  //     critical guideline, append it to that skill's body file (loaded as L3).
  //   - 'identity' (IDENTITY.md): registration metadata (model name, version,
  //     owner, status) consumed by the agent registry at boot, plus commentary
  //     "Notes" sections that don't shape runtime behavior. Keeping IDENTITY
  //     rows in the DB for the Settings dashboard, but not loading them into
  //     the per-call system prompt — saves ~390 tok/call across every agent.
  const rows = await db.select().from(agentMemoryEntriesTable)
    .where(and(
      eq(agentMemoryEntriesTable.agent, agent),
      inArray(agentMemoryEntriesTable.kind, ["soul", "user"]),
    ));
  if (rows.length === 0) return "";
  return rows.map(r => `# ${r.kind.toUpperCase()}\n\n${r.content}`).join("\n\n---\n\n");
}

async function loadSkillLayer(agent: string, skillName: string, memorySections: string[]): Promise<string> {
  // Skill body
  const skillBody = await db.select().from(agentMemoryEntriesTable)
    .where(and(
      eq(agentMemoryEntriesTable.agent, agent),
      eq(agentMemoryEntriesTable.kind, "skill"),
      eq(agentMemoryEntriesTable.sectionName, skillName),
    )).limit(1);

  const parts: string[] = [];
  if (skillBody[0]) parts.push(`# SKILL — ${skillName}\n\n${skillBody[0].content}`);

  // Declared memory sections
  if (memorySections.length > 0) {
    const memRows = await db.select().from(agentMemoryEntriesTable)
      .where(and(
        eq(agentMemoryEntriesTable.agent, agent),
        eq(agentMemoryEntriesTable.kind, "memory"),
        inArray(agentMemoryEntriesTable.sectionName, memorySections),
      ));
    for (const m of memRows) {
      parts.push(`# MEMORY — ${m.sectionName}\n\n${m.content}`);
    }
  }
  return parts.join("\n\n---\n\n");
}

export interface BuiltPrompt {
  systemBlocks: CachedSystemBlock[];
  model: string;
  maxTokens: number;
  toolNames: string[];
  /** Skill's declared tier — runtime passes this as tierOverride so the
   *  wrapper bypasses the agent_* default in feature-tiers.ts. Null when
   *  the DB row's tier column is missing/unrecognised. */
  tier: Tier | null;
  /** Skill's per-provider override (agent_skills.provider_override). Runtime
   *  passes this as providerOverride so the resolver re-reads ai_provider_settings
   *  for the chosen provider, switching API key + model accordingly. Null when
   *  the column is empty (default tier-based provider applies). */
  providerOverride: string | null;
  /** Skill's own API key (already decrypted from agent_skills.api_key_cipher).
   *  When set, runtime forwards as apiKeyOverride so the resolver uses this
   *  key directly — first-class skill config. Null = inherit from tier provider. */
  apiKeyOverride: string | null;
  /** Skill's own base URL (agent_skills.base_url). Paired with apiKeyOverride. */
  baseUrl: string | null;
}

export async function buildPrompt(agent: string, skillName: string): Promise<BuiltPrompt> {
  const skill = await loadSkill(agent, skillName);
  if (!skill) throw new Error(`Unknown skill: ${agent}.${skillName}`);

  const [global, agentLayer, skillLayer] = await Promise.all([
    loadGlobalLayer(),
    loadAgentLayer(agent),
    loadSkillLayer(agent, skillName, skill.memorySections),
  ]);

  const systemBlocks: CachedSystemBlock[] = [];
  if (global) {
    systemBlocks.push({ type: "text", text: global, cache_control: { type: "ephemeral" } });
  }
  if (agentLayer) {
    systemBlocks.push({ type: "text", text: agentLayer, cache_control: { type: "ephemeral" } });
  }
  if (skillLayer) {
    systemBlocks.push({ type: "text", text: skillLayer, cache_control: { type: "ephemeral" } });
  }

  return {
    systemBlocks,
    model: skill.model,
    maxTokens: skill.maxTokens,
    toolNames: skill.tools,
    tier: skill.tier,
    providerOverride: skill.providerOverride,
    apiKeyOverride: skill.apiKeyOverride,
    baseUrl: skill.baseUrl,
  };
}
