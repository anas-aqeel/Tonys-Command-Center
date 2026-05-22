import { useState, useEffect } from "react";
import { post, get } from "@/lib/api";
import { C, F, FS, card, inp, btn1, btn2 } from "./constants";
import { VoiceInput } from "./VoiceInput";

interface Props {
  onComplete: (formatted: string) => void;
}

function cleanAnchor(raw: string): string {
  if (!raw) return "";
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.anchor === "string") return parsed.anchor.trim();
    } catch { /* fall through */ }
  }
  return text;
}

export function JournalGate({ onComplete }: Props) {
  const [jTxt, setJTxt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState("");
  const [anchorLoading, setAnchorLoading] = useState(true);

  useEffect(() => {
    get<{ anchor: string; perfSummary: string }>("/brief/spiritual-anchor")
      .then(r => setAnchor(cleanAnchor(r.anchor || "")))
      .catch(() => setAnchor(""))
      .finally(() => setAnchorLoading(false));
  }, []);

  const submit = async (skip = false) => {
    setSaving(true);
    setError("");
    try {
      if (skip) {
        await post("/journal", { rawText: "[skipped]" });
        onComplete("");
      } else {
        const j = await post<{ formattedText?: string; rawText?: string }>("/journal", { rawText: jTxt });
        onComplete(j.formattedText || j.rawText || jTxt);
      }
    } catch {
      setError("Failed to save journal. Please try again.");
    }
    setSaving(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ maxWidth: 560, width: "100%" }}>

        {/* ── Spiritual Anchor (non-dismissable) ─── */}
        <div style={{ ...card, marginBottom: 16, background: "#FDF8EF", border: `1px solid #D4A017`, borderLeft: `4px solid #D4A017` }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ fontSize: 22, flexShrink: 0 }}>✝</span>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.5, color: "#9A7C0A", marginBottom: 6 }}>Morning Anchor</div>
              {anchorLoading ? (
                <div style={{ fontSize: 13, color: "#B8860B", fontStyle: "italic" }}>Generating your morning anchor...</div>
              ) : anchor ? (
                <div style={{ fontFamily: FS, fontSize: 15, color: "#5C4000", lineHeight: 1.6 }}>
                  {anchor.replace(/[#*_~`>]/g, "").trim().split(/\n+/).map((line, i) => (
                    <p key={i} style={{ margin: i === 0 ? 0 : "8px 0 0" }}>{line.trim()}</p>
                  ))}
                </div>
              ) : (
                <div style={{ fontFamily: FS, fontSize: 15, color: "#5C4000", lineHeight: 1.6 }}>
                  Commit your work to the Lord, and your plans will be established. — Proverbs 16:3<br />
                  Start with your 10 calls today.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Journal Form ──────────────────────── */}
        <div style={{ ...card, padding: "36px 40px" }}>
          <h1 style={{ fontFamily: FS, fontSize: 28, margin: 0 }}>Journal</h1>
          <p style={{ color: C.mut, margin: "6px 0 20px", fontSize: 13 }}>Brain dump — speak or type. AI will format it.</p>

          <div style={{ position: "relative", marginBottom: 8 }}>
            <textarea
              value={jTxt}
              onChange={e => setJTxt(e.target.value)}
              placeholder="What's on your mind? What happened yesterday? What are you grateful for?"
              style={{ ...inp, minHeight: 180, resize: "vertical", fontSize: 15, lineHeight: 1.7, paddingRight: 50 }}
            />
            <div style={{ position: "absolute", bottom: 12, right: 12 }}>
              <VoiceInput onTranscript={t => setJTxt(prev => prev ? prev + " " + t : t)} size={34} />
            </div>
          </div>

          {error && <div style={{ marginTop: 8, padding: "10px 14px", borderRadius: 10, background: C.redBg, color: C.red, fontSize: 13 }}>{error}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={() => submit(true)} disabled={saving} style={{ ...btn2, flex: 1 }}>Skip</button>
            <button onClick={() => submit(false)} disabled={saving || !jTxt.trim()}
              style={{ ...btn1, flex: 2, opacity: saving || !jTxt.trim() ? 0.4 : 1 }}>
              {saving ? "AI Formatting..." : "Save & Continue →"}
            </button>
          </div>
          {/* H1 (Tony's 2026-05-16 PDF): surface where this lands so Tony knows
              the entry is being persisted and where to find historical entries. */}
          <div style={{
            marginTop: 14, fontSize: 11, color: C.mut, lineHeight: 1.5,
            paddingTop: 12, borderTop: `1px solid ${C.brd}`,
          }}>
            Saved to <strong style={{ color: C.sub }}>TCC_Daily_Journal</strong> (Google Doc · 5-minute sync). AI formats Mood / Key Events / Reflection sections before save.
          </div>
        </div>
      </div>
    </div>
  );
}
