import { useState } from "react";
import { C, F } from "./constants";

// Highlight feature (Tony's 2026-05-16 screenshare):
//   "I like to be able to create a highlight where I can click on right click
//    or click on this on this particular individual and make notes... And I
//    can turn this highlights on or off and they're going to be colored based
//    on so Ramy is just going to highlight Ramy. Maybe highlight the whole
//    section and then uh put a filter here under highlights."
//
// Palette is intentionally short — Tony reads this at a glance. Colors aren't
// hardcoded to people; Tony picks per task ("yellow = Ramy items I'm tracking").

export const HIGHLIGHT_COLORS = [
  { value: "yellow", hex: "#F59E0B", label: "Yellow" },
  { value: "blue",   hex: "#3B82F6", label: "Blue" },
  { value: "purple", hex: "#8B5CF6", label: "Purple" },
  { value: "green",  hex: "#10B981", label: "Green" },
  { value: "red",    hex: "#EF4444", label: "Red" },
  { value: "gray",   hex: "#6B7280", label: "Gray" },
] as const;

export function highlightHex(color: string | null | undefined): string | null {
  if (!color) return null;
  return HIGHLIGHT_COLORS.find(c => c.value === color)?.hex ?? null;
}

export interface HighlightPickerProps {
  /** Selected color value (one of HIGHLIGHT_COLORS[].value) or null/empty for unhighlighted. */
  color: string | null | undefined;
  note: string | null | undefined;
  onChange: (next: { color: string | null; note: string | null }) => void;
  /** Whether dueDate is set on the task — if not, picking a color shows a warning. */
  hasDueDate?: boolean;
}

export function HighlightPicker({ color, note, onChange, hasDueDate = true }: HighlightPickerProps) {
  const [localNote, setLocalNote] = useState(note ?? "");
  const active = !!color;

  const setColor = (next: string | null) => {
    onChange({ color: next, note: next ? (localNote || null) : null });
  };

  const commitNote = (text: string) => {
    setLocalNote(text);
    if (active) onChange({ color: color ?? null, note: text || null });
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 10, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>
        Highlight <span style={{ fontWeight: 400, color: C.mut, fontSize: 10 }}>— focus marker · note shows on hover in the master list</span>
      </label>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {HIGHLIGHT_COLORS.map(c => {
          const selected = color === c.value;
          return (
            <button
              key={c.value}
              type="button"
              onClick={() => setColor(selected ? null : c.value)}
              title={c.label}
              style={{
                width: 26, height: 26, borderRadius: 6, cursor: "pointer",
                background: c.hex,
                border: selected ? `3px solid ${C.tx}` : `1px solid ${c.hex}`,
                padding: 0, boxShadow: selected ? "0 0 0 2px #fff inset" : "none",
                transition: "all 0.12s",
              }}
            />
          );
        })}
        {active && (
          <button
            type="button"
            onClick={() => setColor(null)}
            style={{
              padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.brd}`,
              background: "#fff", color: C.mut, fontSize: 11, fontFamily: F, cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>

      {active && !hasDueDate && (
        <div style={{
          marginTop: 6, fontSize: 11, color: "#B45309",
          background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 6,
          padding: "5px 9px",
        }}>
          ⚠ Highlighted tasks must have a due date. Set one above before saving.
        </div>
      )}

      {active && (
        <textarea
          value={localNote}
          onChange={e => commitNote(e.target.value)}
          placeholder="Why is this in focus? Short note (shows on hover in the master list)…"
          style={{
            marginTop: 8, width: "100%", padding: "6px 9px", borderRadius: 6,
            border: `1px solid ${C.brd}`, fontSize: 12, fontFamily: F,
            background: "#fafafa", minHeight: 50, resize: "vertical", boxSizing: "border-box",
          }}
        />
      )}
    </div>
  );
}
