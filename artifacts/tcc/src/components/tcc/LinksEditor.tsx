import { useState } from "react";
import { C, F } from "./constants";

// Links feature (Tony's 2026-05-16 PDF):
//   "New Column 'Links' after status that can click and open — can also be
//    managed/deleted/added/changed in detail view"
//
// Reusable add/edit/delete UI for an array of {url, label?, createdAt}. Used
// by the TaskDetailModal (master task list) AND ContactDrawer's Links tab.
// Parent owns the value + persists via its own save flow (PATCH /plan/item
// for tasks, PATCH /contacts for contacts).

export interface TaskLink {
  url: string;
  label?: string;
  createdAt?: string;
}

export interface LinksEditorProps {
  value: TaskLink[] | null | undefined;
  onChange: (next: TaskLink[]) => void;
  /** Header label (default "Links"). */
  label?: string;
  /** Max links to allow. UI hides the Add row once reached. */
  max?: number;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function faviconUrl(url: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(safeHost(url))}&sz=32`;
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Auto-prepend https:// when the user pastes a bare host like "linear.app/issue/COM-123"
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function LinksEditor({ value, onChange, label = "Links", max = 12 }: LinksEditorProps) {
  const links = Array.isArray(value) ? value : [];
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editLabel, setEditLabel] = useState("");

  const add = () => {
    const url = normalizeUrl(newUrl);
    if (!url) { setError("Enter a valid URL (https://…)"); return; }
    setError("");
    onChange([
      ...links,
      { url, label: newLabel.trim() || undefined, createdAt: new Date().toISOString() },
    ]);
    setNewUrl("");
    setNewLabel("");
  };

  const remove = (i: number) => {
    onChange(links.filter((_, idx) => idx !== i));
  };

  const startEdit = (i: number) => {
    setEditIdx(i);
    setEditUrl(links[i].url);
    setEditLabel(links[i].label || "");
    setError("");
  };

  const commitEdit = () => {
    if (editIdx === null) return;
    const url = normalizeUrl(editUrl);
    if (!url) { setError("Enter a valid URL (https://…)"); return; }
    const next = links.slice();
    next[editIdx] = { ...next[editIdx], url, label: editLabel.trim() || undefined };
    onChange(next);
    setEditIdx(null);
    setEditUrl("");
    setEditLabel("");
  };

  const inputStyle: React.CSSProperties = {
    padding: "6px 10px", borderRadius: 6, border: `1px solid ${C.brd}`,
    fontSize: 12, fontFamily: F, background: "#fafafa", outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div>
      <label style={{ fontSize: 10, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "block" }}>
        {label} {links.length > 0 && <span style={{ fontWeight: 400, color: C.mut }}>· {links.length}</span>}
      </label>

      {/* Existing links */}
      {links.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {links.map((l, i) => {
            const host = safeHost(l.url);
            const display = l.label || host;
            const editing = editIdx === i;
            return (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px", borderRadius: 7,
                background: editing ? "#FEF3C7" : "#F9FAFB",
                border: `1px solid ${editing ? "#FCD34D" : C.brd}`,
              }}>
                <img
                  src={faviconUrl(l.url)}
                  alt=""
                  width={16}
                  height={16}
                  style={{ flexShrink: 0, borderRadius: 2 }}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                />
                {editing ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                    <input
                      value={editLabel}
                      onChange={e => setEditLabel(e.target.value)}
                      placeholder="Label (optional)"
                      style={{ ...inputStyle, fontSize: 11 }}
                    />
                    <input
                      value={editUrl}
                      onChange={e => setEditUrl(e.target.value)}
                      placeholder="https://…"
                      style={{ ...inputStyle, fontSize: 11, fontFamily: "monospace" }}
                    />
                  </div>
                ) : (
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      flex: 1, minWidth: 0,
                      color: C.blu, textDecoration: "none",
                      fontSize: 12, fontFamily: F, fontWeight: 600,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                    title={l.url}
                  >
                    {display}
                    {l.label && <span style={{ color: C.mut, fontWeight: 400, marginLeft: 6 }}>· {host}</span>}
                  </a>
                )}
                <div style={{ display: "flex", gap: 4 }}>
                  {editing ? (
                    <>
                      <button
                        type="button"
                        onClick={commitEdit}
                        style={{ padding: "3px 8px", borderRadius: 5, border: `1px solid ${C.grn}`, background: "#fff", color: C.grn, fontSize: 10, fontFamily: F, cursor: "pointer", fontWeight: 700 }}
                      >Save</button>
                      <button
                        type="button"
                        onClick={() => { setEditIdx(null); setError(""); }}
                        style={{ padding: "3px 8px", borderRadius: 5, border: `1px solid ${C.brd}`, background: "#fff", color: C.mut, fontSize: 10, fontFamily: F, cursor: "pointer" }}
                      >Cancel</button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(i)}
                        title="Edit link"
                        style={{ padding: "3px 7px", borderRadius: 5, border: `1px solid ${C.brd}`, background: "#fff", color: C.sub, fontSize: 10, fontFamily: F, cursor: "pointer" }}
                      >Edit</button>
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        title="Remove link"
                        style={{ padding: "3px 8px", borderRadius: 5, border: `1px solid #FECACA`, background: "#fff", color: "#B91C1C", fontSize: 11, fontFamily: F, cursor: "pointer", lineHeight: 1 }}
                      >×</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add row — hidden once max is reached */}
      {links.length < max && (
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
            <input
              value={newUrl}
              onChange={e => { setNewUrl(e.target.value); if (error) setError(""); }}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
              placeholder="https://… (paste a Loom, doc, or link)"
              style={{ ...inputStyle, fontFamily: "monospace" }}
            />
            <input
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
              placeholder="Label (optional — defaults to domain)"
              style={inputStyle}
            />
          </div>
          <button
            type="button"
            onClick={add}
            disabled={!newUrl.trim()}
            style={{
              padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.blu}`,
              background: newUrl.trim() ? C.blu : "#E5E7EB", color: newUrl.trim() ? "#fff" : C.mut,
              fontSize: 12, fontWeight: 700, cursor: newUrl.trim() ? "pointer" : "not-allowed", fontFamily: F,
              whiteSpace: "nowrap",
            }}
          >+ Add</button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 6, padding: "4px 8px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 5, fontSize: 11, color: "#991B1B" }}>
          {error}
        </div>
      )}

      {links.length === 0 && !error && (
        <div style={{ marginTop: 6, fontSize: 11, color: C.mut, fontStyle: "italic" }}>
          No links yet. Paste a URL above to attach one.
        </div>
      )}
    </div>
  );
}
