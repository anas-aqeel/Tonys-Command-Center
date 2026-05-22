import { useState } from "react";
import { post } from "@/lib/api";
import { FontLink } from "./FontLink";
import { C, F, FS, TODAY_STR, card, inp, btn1, btn2, lbl } from "./constants";
import { VoiceField } from "./VoiceField";
import type { CheckinState } from "./types";

interface PatternAlert {
  type: string;
  message: string;
  level: "high" | "mid" | "low";
}

interface Props {
  initial: CheckinState;
  onComplete: (ck: CheckinState) => void;
}

const levelStyle = (level: "high" | "mid" | "low") => ({
  background: level === "high" ? C.redBg : level === "mid" ? C.ambBg : C.bluBg,
  color: level === "high" ? C.red : level === "mid" ? C.amb : C.blu,
  icon: level === "high" ? "🚨" : level === "mid" ? "⚠️" : "💡",
});

export function CheckinGate({ initial, onComplete }: Props) {
  const [ck, setCk] = useState<CheckinState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [clock] = useState(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }));
  const [patternAlerts, setPatternAlerts] = useState<PatternAlert[]>([]);
  const [showAlerts, setShowAlerts] = useState(false);
  const [guiltMessage, setGuiltMessage] = useState("");
  const [showGuilt, setShowGuilt] = useState(false);

  const upCk = (k: keyof CheckinState, v: unknown) => {
    const u = { ...ck, [k]: v } as CheckinState;
    if (u.bed && u.wake) {
      try {
        const parse = (t: string, isBedtime: boolean) => {
          const m = t.match(/(\d+):?(\d*)\s*(am|pm)?/i);
          if (!m) return 0;
          let h = +m[1]; const mn = m[2] ? +m[2] : 0;
          const suffix = m[3]?.toLowerCase();
          if (suffix === "pm" && h < 12) h += 12;
          else if (suffix === "am" && h === 12) h = 0;
          else if (!suffix) {
            // No AM/PM: bedtime assumes PM (7-11), wake assumes AM (4-11)
            if (isBedtime && h >= 7 && h <= 11) h += 12;
            // wake time: h <= 12 stays as-is (AM)
          }
          return h + mn / 60;
        };
        let d = parse(u.wake, false) - parse(u.bed, true);
        if (d < 0) d += 24;
        u.sleep = d.toFixed(1);
      } catch { /* ignore */ }
    }
    setCk(u);
  };

  const submit = async () => {
    setSaving(true);
    setError("");

    const missingWorkout = !ck.workout;
    const missingJournal = !ck.journal;

    if (missingWorkout || missingJournal) {
      try {
        const guiltRes = await post("/checkin/guilt-trip", { missingWorkout, missingJournal }) as { message: string };
        if (guiltRes?.message) {
          setGuiltMessage(guiltRes.message);
          setShowGuilt(true);
          setSaving(false);
          return;
        }
      } catch {
        // If guilt trip fails, continue with normal flow
      }
    }

    await doSubmit();
  };

  const doSubmit = async () => {
    setSaving(true);
    setError("");
    try {
      const result = await post("/checkin", {
        bedtime: ck.bed, waketime: ck.wake, sleepHours: ck.sleep || undefined,
        bible: ck.bible, workout: ck.workout, journal: ck.journal,
        nutrition: ck.nut, unplug: ck.unplug,
      }) as { patternAlerts?: PatternAlert[] };

      const alerts: PatternAlert[] = result?.patternAlerts ?? [];
      const done = { ...ck, done: true };
      setCk(done);

      if (alerts.length > 0) {
        setPatternAlerts(alerts);
        setShowAlerts(true);
      } else {
        onComplete(done);
      }
    } catch {
      setError("Failed to save check-in. Please try again.");
    }
    setSaving(false);
  };

  const handleGuiltProceed = async () => {
    setShowGuilt(false);
    setGuiltMessage("");
    await doSubmit();
  };

  const handleGuiltGoBack = () => {
    setShowGuilt(false);
    setGuiltMessage("");
    setSaving(false);
  };

  if (showGuilt) {
    const missingWorkout = !ck.workout;
    const missingJournal = !ck.journal;
    const missingBoth = missingWorkout && missingJournal;
    const accentColor = missingBoth ? C.red : C.amb;
    return (
      <div style={{ minHeight: "100vh", background: "#FFFFFF", fontFamily: F, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <FontLink />
        <img src="/flipiq-logo.png" alt="FlipIQ" style={{ height: 64, marginBottom: 40, objectFit: "contain" }} />
        <div style={{ ...card, padding: "36px 40px", maxWidth: 480, width: "100%", boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: accentColor, textTransform: "uppercase", letterSpacing: 2, marginBottom: 16 }}>
            {missingBoth ? "⚠️ Both Missing" : missingWorkout ? "⚠️ Workout Missing" : "⚠️ Journal Missing"}
          </div>
          <div style={{ fontSize: 16, lineHeight: 1.75, color: C.tx, fontFamily: FS, fontStyle: "italic", marginBottom: 32, borderLeft: `3px solid ${accentColor}`, paddingLeft: 16 }}>
            {guiltMessage}
          </div>
          <div style={{ display: "flex", gap: 12, flexDirection: "column" }}>
            <button onClick={handleGuiltGoBack} style={{ ...btn1, width: "100%", background: accentColor }}>Go Handle It</button>
            <button onClick={handleGuiltProceed} style={{ ...btn2, width: "100%", textAlign: "center" }}>I Hear You — Let's Go</button>
          </div>
        </div>
      </div>
    );
  }

  if (showAlerts) {
    const highAlerts = patternAlerts.filter(a => a.level === "high");
    const otherAlerts = patternAlerts.filter(a => a.level !== "high");
    return (
      <div style={{ minHeight: "100vh", background: "#FFFFFF", fontFamily: F, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <FontLink />
        <img src="/flipiq-logo.png" alt="FlipIQ" style={{ height: 64, marginBottom: 40, objectFit: "contain" }} />
        <div style={{ ...card, padding: "36px 40px", maxWidth: 480, width: "100%", boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
          <h1 style={{ fontFamily: FS, fontSize: 24, margin: 0, marginBottom: 4 }}>Pattern Alert</h1>
          <p style={{ color: C.mut, margin: "0 0 24px", fontSize: 13 }}>
            Based on your last {patternAlerts.length > 0 ? "7" : "3"} days of check-ins:
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
            {[...highAlerts, ...otherAlerts].map((alert, i) => {
              const style = levelStyle(alert.level);
              return (
                <div key={i} style={{
                  padding: "14px 16px",
                  borderRadius: 12,
                  background: style.background,
                  border: `1px solid ${style.color}22`,
                }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 16, flexShrink: 0 }}>{style.icon}</span>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: style.color, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>{alert.type}</div>
                      <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.5 }}>{alert.message}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <p style={{ fontFamily: FS, fontSize: 13, color: C.sub, fontStyle: "italic", borderLeft: `3px solid ${C.brd}`, paddingLeft: 12, margin: "0 0 24px" }}>
            "Follow the plan I gave you!" — God
          </p>

          <button
            onClick={() => onComplete({ ...ck, done: true })}
            style={{ ...btn1, width: "100%" }}
          >
            Acknowledged — Let's Go →
          </button>
          <button
            onClick={() => onComplete({ ...ck, done: true })}
            style={{ ...btn2, width: "100%", marginTop: 8, textAlign: "center" }}
          >
            Skip
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#FFFFFF", fontFamily: F, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <FontLink />
      <img src="/flipiq-logo.png" alt="FlipIQ" style={{ height: 64, marginBottom: 40, objectFit: "contain" }} />
      <div style={{ ...card, padding: "36px 40px", maxWidth: 480, width: "100%", boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
        <h1 style={{ fontFamily: FS, fontSize: 28, margin: 0 }}>Morning Check-in</h1>
        <p style={{ color: C.mut, margin: "6px 0 0", fontSize: 13 }}>{TODAY_STR} · {clock}</p>
        <p style={{ fontFamily: FS, fontSize: 14, color: C.sub, fontStyle: "italic", margin: "12px 0 24px", borderLeft: `3px solid ${C.brd}`, paddingLeft: 12 }}>
          "Follow the plan I gave you!" — God
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
          <div><label style={lbl}>Bedtime</label><VoiceField value={ck.bed} onChange={v => upCk("bed", v)} placeholder="10:30 PM" style={inp} /></div>
          <div><label style={lbl}>Wake time</label><VoiceField value={ck.wake} onChange={v => upCk("wake", v)} placeholder="6:00 AM" style={inp} /></div>
        </div>
        {ck.sleep && (
          <div style={{ background: +ck.sleep >= 7 ? C.grnBg : C.ambBg, borderRadius: 10, padding: "10px 16px", marginBottom: 18, fontSize: 14, fontWeight: 600, color: +ck.sleep >= 7 ? C.grn : C.amb }}>
            Sleep: {ck.sleep}h {+ck.sleep < 7 ? "⚠️" : "✓"}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
          {([["bible", "Bible"], ["workout", "Workout"], ["journal", "Journal"], ["unplug", "Unplug 6PM"]] as [keyof CheckinState, string][]).map(([k, l]) => (
            <button key={k} onClick={() => upCk(k, !ck[k])}
              style={{ padding: 13, borderRadius: 8, border: `1px solid ${ck[k] ? "#F97316" : C.brd}`, background: ck[k] ? "#F97316" : C.card, color: ck[k] ? "#fff" : C.sub, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: F }}>
              {ck[k] ? "✓ " : ""}{l}
            </button>
          ))}
        </div>
        <div style={{ marginBottom: 22 }}>
          <label style={lbl}>Yesterday's Nutrition</label>
          <div style={{ display: "flex", gap: 8 }}>
            {["Good", "OK", "Bad"].map(n => (
              <button key={n} onClick={() => upCk("nut", n)}
                style={{ flex: 1, padding: 12, borderRadius: 8, border: `1px solid ${ck.nut === n ? "#F97316" : C.brd}`, background: ck.nut === n ? "#F97316" : C.card, color: ck.nut === n ? "#fff" : C.sub, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: F }}>
                {n}
              </button>
            ))}
          </div>
        </div>
        {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, background: C.redBg, color: C.red, fontSize: 13 }}>{error}</div>}
        <button onClick={submit} disabled={saving || !ck.bed || !ck.wake}
          style={{ ...btn1, width: "100%", opacity: (saving || !ck.bed || !ck.wake) ? 0.6 : 1 }}>
          {saving ? "Checking..." : !ck.bed || !ck.wake ? "Enter Bedtime & Wake Time" : "Let's Go →"}
        </button>
        {/* H1 (Tony's 2026-05-16 PDF): surface where this lands. */}
        <div style={{
          marginTop: 14, fontSize: 11, color: C.mut, lineHeight: 1.5, textAlign: "center",
        }}>
          Saved to <strong style={{ color: C.sub }}>TCC_Personal_Checkin</strong>.
        </div>
      </div>
    </div>
  );
}
