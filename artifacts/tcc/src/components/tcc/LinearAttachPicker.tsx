import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "@/lib/api";
import { C, F } from "./constants";
import type { LinearItem } from "./types";

// C7 (Tony's 2026-05-16): typeahead picker for attaching Linear issues to a
// task. Replaces the manual comma-separated text field; lets Tony search by
// identifier (e.g. "COM-341") or title fragment and click to attach. Removes
// via × on each chip. The committed value is still a comma-separated string
// so the parent's existing PATCH /plan/item shape stays unchanged.

export interface LinearAttachPickerProps {
  /** Comma-separated identifiers, e.g. "COM-341, FLI-9". */
  value: string;
  /** Replace the full attachment list. */
  onChange: (next: string) => void;
  /** Optional label override. */
  label?: string;
}

// Split helper matches BusinessView's existing splitLinearIds behavior.
function splitIds(raw: string): string[] {
  return raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

export function LinearAttachPicker({ value, onChange, label = "Linear issues" }: LinearAttachPickerProps) {
  const [items, setItems] = useState<LinearItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const attached = useMemo(() => splitIds(value), [value]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    get<LinearItem[]>("/linear/live")
      .then(d => { if (!cancelled && Array.isArray(d)) setItems(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Click-outside to close suggestion dropdown
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const attachedSet = useMemo(() => new Set(attached.map(s => s.toLowerCase())), [attached]);
  const q = query.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!items.length) return [];
    const filtered = items.filter(i => {
      if (attachedSet.has(i.identifier?.toLowerCase() ?? "")) return false;
      if (!q) return true;
      return (
        i.identifier?.toLowerCase().includes(q) ||
        i.task?.toLowerCase().includes(q) ||
        i.who?.toLowerCase().includes(q)
      );
    });
    return filtered.slice(0, 10);
  }, [items, q, attachedSet]);

  // Map identifier → metadata for rendering attached chips with title/state.
  const metaByIdentifier = useMemo(() => {
    const m = new Map<string, LinearItem>();
    for (const i of items) if (i.identifier) m.set(i.identifier.toLowerCase(), i);
    return m;
  }, [items]);

  const attach = (identifier: string) => {
    const next = attached.includes(identifier) ? attached : [...attached, identifier];
    onChange(next.join(", "));
    setQuery("");
    setOpen(false);
  };

  const detach = (identifier: string) => {
    onChange(attached.filter(id => id !== identifier).join(", "));
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <label style={{ fontSize: 10, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>
        {label}
      </label>

      {/* Attached chips */}
      {attached.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {attached.map(id => {
            const meta = metaByIdentifier.get(id.toLowerCase());
            return (
              <div key={id} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 4px 4px 8px", borderRadius: 6,
                background: C.bluBg, border: `1px solid ${C.blu}33`,
                fontSize: 12, color: C.blu, fontFamily: F,
              }}>
                {meta?.url ? (
                  <a href={meta.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none", fontWeight: 700 }}>
                    {id}
                  </a>
                ) : (
                  <span style={{ fontWeight: 700 }}>{id}</span>
                )}
                {meta?.task && (
                  <span style={{ color: C.mut, fontWeight: 400, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    — {meta.task}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => detach(id)}
                  title="Remove"
                  style={{
                    border: "none", background: "transparent", color: C.mut, cursor: "pointer",
                    padding: "2px 4px", fontSize: 13, lineHeight: 1, borderRadius: 4,
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={loading ? "Loading Linear issues…" : "Search by identifier or title (e.g. COM-341 or 'AWS')"}
        style={{
          width: "100%", padding: "8px 10px", borderRadius: 7, border: `1px solid ${C.brd}`,
          fontFamily: F, fontSize: 13, background: "#fafafa", boxSizing: "border-box", outline: "none",
        }}
        disabled={loading}
      />

      {/* Suggestion dropdown */}
      {open && (suggestions.length > 0 || query.trim()) && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 50,
          maxHeight: 280, overflowY: "auto",
          background: "#fff", border: `1px solid ${C.brd}`, borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        }}>
          {suggestions.length === 0 && query.trim() && (
            <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 12, color: C.mut }}>No match. Attach anyway?</span>
              <button
                type="button"
                onClick={() => attach(query.trim())}
                style={{
                  padding: "3px 10px", borderRadius: 6, border: `1px solid ${C.blu}33`,
                  background: C.bluBg, color: C.blu, fontSize: 11, fontFamily: F, cursor: "pointer", fontWeight: 700,
                }}
              >
                Add "{query.trim()}"
              </button>
            </div>
          )}
          {suggestions.map(s => (
            <div
              key={s.identifier ?? s.task}
              onClick={() => s.identifier && attach(s.identifier)}
              style={{
                padding: "8px 12px", cursor: s.identifier ? "pointer" : "default",
                borderBottom: `1px solid ${C.brd}`,
                fontSize: 12, fontFamily: F,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#F3F4F6"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, color: C.blu, minWidth: 64 }}>{s.identifier}</span>
                <span style={{ color: C.tx, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.task}</span>
                {s.state && (
                  <span style={{ fontSize: 10, color: C.mut, padding: "1px 5px", border: `1px solid ${C.brd}`, borderRadius: 4 }}>
                    {s.state}
                  </span>
                )}
              </div>
              {s.who && s.who !== "Unassigned" && (
                <div style={{ fontSize: 10, color: C.mut, marginTop: 2 }}>{s.who}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
