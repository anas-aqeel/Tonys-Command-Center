import { useEffect, useRef, useState } from "react";
import { C, F } from "./constants";

// Multi-select filter popover used by the Sales view + ContactDrawer's
// quick-filter row. Tony's 2026-05-16 feedback: filters need to be multi-option
// (e.g. Hot + Warm simultaneously). Empty selection array = "no filter" =
// "All" — keeps the API call shape backward-compatible (omit the param when
// empty; comma-join when non-empty).
export interface MultiSelectFilterProps {
  /** Selected values. Empty array = no filter (= "All"). */
  values: string[];
  /** Replace the full selection. */
  onChange: (next: string[]) => void;
  /** Available choices. */
  options: readonly string[];
  /** Button label when no selection (e.g. "Status"). */
  label: string;
  /** Pluralized label used in the "All ..." dropdown header (e.g. "Statuses"). */
  pluralLabel?: string;
  /** Accent color when the filter is active. */
  activeColor: string;
  /** Optional: hide the option list completely if the parent wants a label-only button. */
  hidden?: boolean;
}

export function MultiSelectFilter({
  values, onChange, options, label, pluralLabel, activeColor, hidden = false,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = values.length > 0;

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (hidden) return null;

  const toggle = (opt: string) => {
    if (values.includes(opt)) onChange(values.filter(v => v !== opt));
    else onChange([...values, opt]);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "5px 10px", borderRadius: 7,
          border: `1px solid ${active ? activeColor : C.brd}`,
          fontSize: 12, fontFamily: F, background: "#FAFAF8",
          color: active ? activeColor : C.sub,
          cursor: "pointer", outline: "none",
          fontWeight: active ? 700 : 400,
          display: "inline-flex", alignItems: "center", gap: 6,
          whiteSpace: "nowrap",
        }}
      >
        <span>{label}</span>
        {active && (
          <span style={{
            background: activeColor, color: "#fff",
            fontSize: 10, fontWeight: 800,
            padding: "1px 6px", borderRadius: 10, minWidth: 16, textAlign: "center",
          }}>{values.length}</span>
        )}
        <span style={{ fontSize: 9, opacity: 0.55, marginLeft: 1 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 50,
          minWidth: 180, maxWidth: 220, width: "max-content", maxHeight: 280, overflowY: "auto",
          background: "#fff", border: `1px solid ${C.brd}`, borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          padding: 4,
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "6px 10px 4px", borderBottom: `1px solid ${C.brd}`, marginBottom: 4,
          }}>
            <span style={{ fontSize: 11, color: C.mut, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {active ? `${values.length} of ${options.length}` : `All ${pluralLabel ?? label.toLowerCase() + "s"}`}
            </span>
            {active && (
              <button
                type="button"
                onClick={() => onChange([])}
                style={{
                  background: "none", border: "none", color: C.blu,
                  fontSize: 11, fontFamily: F, cursor: "pointer", padding: 0,
                }}
              >
                Clear
              </button>
            )}
          </div>
          {options.map(opt => {
            const sel = values.includes(opt);
            return (
              <label key={opt} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "5px 10px", cursor: "pointer", borderRadius: 5,
                background: sel ? `${activeColor}11` : "transparent",
                fontSize: 12, fontFamily: F,
              }}>
                <input
                  type="checkbox"
                  checked={sel}
                  onChange={() => toggle(opt)}
                  style={{ accentColor: activeColor, cursor: "pointer" }}
                />
                <span style={{ color: sel ? activeColor : C.tx, fontWeight: sel ? 700 : 400 }}>
                  {opt}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
