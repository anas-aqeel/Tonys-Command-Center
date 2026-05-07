// /settings/models — Three tier cards (Basic / Medium / Complex). Each lets
// you pick a provider, type any model id (combobox with curated suggestions),
// paste an API key (encrypted on save), test the connection, and save.
//
// Backend writes to ai_provider_settings via PATCH /ai-settings/:tier and
// invalidates the in-memory tier cache so changes take effect immediately.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { get, patch, post } from "@/lib/api";
import { C, F, FS } from "@/components/tcc/constants";

type Tier = "basic" | "medium" | "complex";
type Provider = "anthropic" | "openai" | "google" | "openrouter";

const TIER_META: Record<Tier, { label: string; emoji: string; blurb: string }> = {
  basic: {
    label: "Basic Tasks",
    emoji: "⚡",
    blurb: "Single-shot classification, scoring, and template fills. Cheap, fast, deterministic — Haiku-class.",
  },
  medium: {
    label: "Medium Tasks",
    emoji: "🛠",
    blurb: "Synthesis, drafting, summarization with context. Most of the app's interactive surfaces — Sonnet-class.",
  },
  complex: {
    label: "Complex Tasks",
    emoji: "🧠",
    blurb: "Multi-turn agent loops, deep reasoning, tool-orchestrated workflows. Coach + agent runtime — Sonnet/Opus-class.",
  },
};

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google Vertex AI / Gemini",
  openrouter: "OpenRouter",
};

interface TierRow {
  tier: Tier;
  provider: Provider;
  model: string;
  keyConfigured: boolean;
  baseUrl: string | null;
  extraOptions: Record<string, unknown>;
  updatedAt: string;
}

interface SettingsResponse {
  tiers: TierRow[];
  providers: Provider[];
}

interface ModelSuggestion {
  id: string;
  name: string;
  tier_hint: Tier;
}

interface SuggestionsResponse {
  provider: Provider;
  suggestions: ModelSuggestion[];
}

interface CatalogModelRow {
  provider: Provider;
  modelId: string;
  inputPerM: number;
  outputPerM: number;
  displayName: string | null;
  lastSyncedAt: string;
}

interface TestResponse {
  ok: boolean;
  provider: Provider;
  model: string;
  durationMs?: number;
  preview?: string;
  usage?: unknown;
  error?: string;
}

export function ModelSettingsView({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<TierRow[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const data = await get<SettingsResponse>("/ai-settings");
      setRows(data.tiers);
      setProviders(data.providers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "20px 24px", fontFamily: F }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.sub, fontSize: 14 }}>← Back</button>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.tx, margin: 0, fontFamily: FS }}>Model Settings</h1>
      </div>

      <p style={{ fontSize: 13, color: C.sub, marginBottom: 20, lineHeight: 1.5 }}>
        Every AI call in the app is bucketed into one of three tiers. Configure the provider, model, and API key per tier. Changes take effect within ~30 seconds (no server restart needed).
      </p>

      {error && (
        <div style={{ padding: 12, background: C.redBg, color: C.red, borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{error}</div>
      )}

      {loading && rows.length === 0 ? (
        <div style={{ padding: 24, color: C.mut, textAlign: "center" }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(["basic", "medium", "complex"] as Tier[]).map((t) => {
            const row = rows.find((r) => r.tier === t);
            if (!row) return null;
            return (
              <TierCard
                key={t}
                row={row}
                providers={providers}
                onSaved={reload}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function TierCard({ row, providers, onSaved }: { row: TierRow; providers: Provider[]; onSaved: () => void }) {
  const meta = TIER_META[row.tier];
  const [provider, setProvider] = useState<Provider>(row.provider);
  const [model, setModel] = useState<string>(row.model);
  const [apiKey, setApiKey] = useState<string>("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string>(row.baseUrl ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [suggestions, setSuggestions] = useState<ModelSuggestion[]>([]);
  const [catalog, setCatalog] = useState<CatalogModelRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResponse | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Curated suggestions (fallback when catalog is empty)
  useEffect(() => {
    let cancelled = false;
    get<SuggestionsResponse>(`/ai-settings/models/${provider}`)
      .then((d) => { if (!cancelled) setSuggestions(d.suggestions); })
      .catch(() => { if (!cancelled) setSuggestions([]); });
    return () => { cancelled = true; };
  }, [provider]);

  // Live catalog from model_catalog table — preferred datalist source.
  // Empty list = no sync has run yet; the Refresh button below populates it.
  const loadCatalog = async (p: Provider) => {
    try {
      const rows = await get<CatalogModelRow[]>(`/ai-settings/models?provider=${p}`);
      setCatalog(rows);
    } catch {
      setCatalog([]);
    }
  };

  useEffect(() => {
    void loadCatalog(provider);
  }, [provider]);

  const onRefreshModels = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await post<{ ok: boolean; results: Record<string, { added: number; updated: number; errors: string[] }> }>(
        `/ai-settings/sync-models`,
        { provider },
      );
      const result = r.results[provider];
      const errs = result?.errors ?? [];
      if (errs.length > 0) {
        setRefreshMsg(`Refreshed with errors: ${errs[0]}`);
      } else {
        setRefreshMsg(`Refreshed (${(result?.added ?? 0) + (result?.updated ?? 0)} models).`);
      }
      await loadCatalog(provider);
      setTimeout(() => setRefreshMsg(null), 3500);
    } catch (err) {
      setRefreshMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  // Datalist combines live catalog + curated. Catalog wins on duplicate ids.
  const datalistOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; label: string }> = [];
    for (const r of catalog) {
      if (seen.has(r.modelId)) continue;
      seen.add(r.modelId);
      out.push({ id: r.modelId, label: r.displayName ?? r.modelId });
    }
    for (const s of suggestions) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ id: s.id, label: s.name });
    }
    return out;
  }, [catalog, suggestions]);

  const dirty = useMemo(() => (
    provider !== row.provider ||
    model !== row.model ||
    (baseUrl || null) !== row.baseUrl ||
    apiKey !== ""
  ), [provider, model, baseUrl, apiKey, row]);

  const onSave = async () => {
    setErrMsg(null);
    setSaveMsg(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = { provider, model };
      if (baseUrl !== (row.baseUrl ?? "")) body.baseUrl = baseUrl || null;
      if (apiKey) body.apiKey = apiKey;
      await patch(`/ai-settings/${row.tier}`, body);
      setApiKey("");
      setSaveMsg("Saved.");
      onSaved();
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setErrMsg(null);
    setTestResult(null);
    setTesting(true);
    try {
      const body: Record<string, unknown> = { provider, model };
      if (apiKey) body.apiKey = apiKey;     // test the unsaved key
      if (baseUrl) body.baseUrl = baseUrl;
      const res = await post<TestResponse>(`/ai-settings/${row.tier}/test`, body);
      setTestResult(res);
    } catch (err) {
      setTestResult({
        ok: false,
        provider,
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const cardStyle: CSSProperties = {
    background: C.card,
    border: `1px solid ${C.brd}`,
    borderRadius: 10,
    padding: 20,
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  };

  const lbl: CSSProperties = {
    fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase",
    letterSpacing: 0.5, marginBottom: 4, display: "block",
  };
  const inp: CSSProperties = {
    width: "100%", padding: "8px 10px", borderRadius: 6,
    border: `1px solid ${C.brd}`, fontSize: 13, fontFamily: F, background: "#fff",
    boxSizing: "border-box",
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 24, lineHeight: 1 }}>{meta.emoji}</div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.tx, fontFamily: FS }}>{meta.label}</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.sub, lineHeight: 1.5 }}>{meta.blurb}</p>
        </div>
        <div style={{ fontSize: 11, color: row.keyConfigured ? C.grn : C.amb, fontWeight: 600 }}>
          {row.keyConfigured ? "✓ Key saved" : "⚠ Using env fallback"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={lbl}>Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            style={inp}
          >
            {providers.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={lbl}>Model (type any model id, or pick a suggestion)</label>
          <input
            list={`models-${row.tier}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={inp}
            placeholder="e.g. claude-sonnet-4-6 / gpt-4o / gemini-2.5-pro"
            spellCheck={false}
          />
          <datalist id={`models-${row.tier}`}>
            {datalistOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </datalist>
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={onRefreshModels}
              disabled={refreshing}
              style={{
                padding: "4px 10px", border: `1px solid ${C.brd}`, background: C.card,
                borderRadius: 6, cursor: refreshing ? "default" : "pointer", fontSize: 11, color: C.sub,
              }}
              title="Pull the live model list from the provider into model_catalog."
            >
              {refreshing ? "Refreshing…" : "↻ Refresh models"}
            </button>
            <span style={{ fontSize: 11, color: C.mut }}>
              {catalog.length > 0 ? `${catalog.length} models in catalog` : "No models synced yet"}
            </span>
            {refreshMsg && <span style={{ fontSize: 11, color: C.sub }}>{refreshMsg}</span>}
          </div>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={lbl}>API key {row.keyConfigured ? "(leave blank to keep current)" : ""}</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ ...inp, flex: 1 }}
              placeholder={row.keyConfigured ? "•••••••••••• (saved)" : "Paste provider API key"}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              style={{
                padding: "6px 12px", border: `1px solid ${C.brd}`, background: C.card,
                borderRadius: 6, cursor: "pointer", fontSize: 12, color: C.sub,
              }}
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      </div>

      {/* Advanced */}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{ background: "none", border: "none", color: C.sub, fontSize: 12, cursor: "pointer", padding: 0 }}
        >
          {showAdvanced ? "▼" : "▶"} Advanced (base URL, region)
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 8 }}>
            <label style={lbl}>Base URL (override — for self-hosted OpenAI-compatible / Vertex region)</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              style={inp}
              placeholder="(leave blank for provider default)"
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
        <button
          onClick={onTest}
          disabled={testing || saving}
          style={{
            padding: "8px 14px", border: `1px solid ${C.brd}`, background: C.card,
            color: C.tx, borderRadius: 6, cursor: testing ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600,
          }}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button
          onClick={onSave}
          disabled={!dirty || saving || testing}
          style={{
            padding: "8px 14px", border: "none",
            background: !dirty || saving ? C.mut : "#F97316",
            color: "#fff", borderRadius: 6,
            cursor: !dirty || saving ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saveMsg && <span style={{ fontSize: 12, color: C.grn }}>{saveMsg}</span>}
        {errMsg && <span style={{ fontSize: 12, color: C.red }}>{errMsg}</span>}
      </div>

      {testResult && (
        <div
          style={{
            marginTop: 12, padding: 10, borderRadius: 6, fontSize: 12,
            background: testResult.ok ? C.grnBg : C.redBg,
            color: testResult.ok ? C.grn : C.red,
            lineHeight: 1.5,
          }}
        >
          {testResult.ok ? (
            <>
              <strong>✓ Connection OK</strong> — {testResult.provider}/{testResult.model} · {testResult.durationMs} ms
              {testResult.preview && <div style={{ marginTop: 4, color: C.sub, fontFamily: "monospace" }}>"{testResult.preview}"</div>}
            </>
          ) : (
            <>
              <strong>✗ Test failed</strong> — {testResult.error}
            </>
          )}
        </div>
      )}
    </div>
  );
}
