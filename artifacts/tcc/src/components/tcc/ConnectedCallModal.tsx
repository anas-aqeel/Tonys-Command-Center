import { useState } from "react";
import { post } from "@/lib/api";
import { C, FS, inp, btn1, btn2 } from "./constants";
import { VoiceField } from "./VoiceField";

interface Props {
  open: boolean;
  onClose: () => void;
  contactId: string;
  contactName: string;
  contactEmail?: string;
  onFollowUpEmail?: (prefill: { to: string; subject: string; body: string; contactId: string; contactName: string }) => void;
}

type FollowUpType = "follow_up" | "appointment";

export function ConnectedCallModal({ open, onClose, contactId, contactName, contactEmail, onFollowUpEmail }: Props) {
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  // B7 (Tony's 2026-05-16): when a follow-up date is set, ask whether it's a
  // plain follow-up (reminder only) or a sales appointment (counts in today's
  // "appointments booked" win). Default follow_up to match prior behavior.
  const [followUpType, setFollowUpType] = useState<FollowUpType>("follow_up");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setOutcomeNotes("");
    setNextStep("");
    setFollowUpDate("");
    setFollowUpType("follow_up");
    setSaved(false);
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSave = async () => {
    if (!outcomeNotes.trim()) {
      setError("Outcome notes are required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      // BE now returns an AI-drafted follow-up so the compose modal opens
      // prefilled (Tony's 2026-05-16 ask: "make sure this information is
      // preloaded so I don't have to come back and refill it").
      const resp = await post<{ ok: boolean; followUpText?: string | null }>(
        "/calls/connected-outcome",
        {
          contactId,
          contactName,
          outcomeNotes,
          nextStep: nextStep || undefined,
          followUpDate: followUpDate || undefined,
          // Only meaningful when followUpDate is set; BE defaults to follow_up.
          followUpType: followUpDate ? followUpType : undefined,
        },
      );
      setSaved(true);

      setTimeout(() => {
        handleClose();
        if (onFollowUpEmail && contactEmail) {
          onFollowUpEmail({
            to: contactEmail,
            subject: `Following up - ${contactName}`,
            body: resp?.followUpText || "",
            contactId,
            contactName,
          });
        }
      }, 1200);
    } catch {
      setError("Failed to save. Try again.");
    }
    setSaving(false);
  };

  if (!open) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={handleClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 14, padding: 28, width: 500, maxWidth: "95vw" }}>

        {saved ? (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>&#10003;</div>
            <div style={{ fontFamily: FS, fontSize: 18, color: C.grn }}>Call Logged</div>
            {followUpDate && (
              <div style={{ fontSize: 12, color: C.mut, marginTop: 6 }}>
                Calendar reminder created for {followUpDate}
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ fontFamily: FS, fontSize: 20, margin: 0 }}>
                Connected Call: {contactName}
              </h3>
              <button onClick={handleClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: C.mut }}>&#10005;</button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>
                Outcome Notes *
              </label>
              <VoiceField
                as="textarea"
                value={outcomeNotes}
                onChange={setOutcomeNotes}
                placeholder="What was discussed? Key takeaways..."
                style={{ ...inp, minHeight: 100, resize: "vertical", fontSize: 14, lineHeight: 1.5 }}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>
                Next Step
              </label>
              <VoiceField
                value={nextStep}
                onChange={setNextStep}
                placeholder="e.g. Send proposal, Schedule demo, Send contract"
                style={{ ...inp, fontSize: 14 }}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>
                Follow-Up Date
              </label>
              <input
                type="date"
                value={followUpDate}
                onChange={e => setFollowUpDate(e.target.value)}
                style={{ ...inp, fontSize: 14 }}
              />
              <div style={{ fontSize: 10, color: C.mut, marginTop: 3 }}>
                Sets next_action_date + creates a Google Calendar reminder
              </div>

              {/* B7 — only ask the type when a date is actually set. */}
              {followUpDate && (
                <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.brd}`, background: "#FAFAF8" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                    What is this date for?
                  </div>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 6 }}>
                    <input
                      type="radio"
                      name="follow-up-type"
                      checked={followUpType === "follow_up"}
                      onChange={() => setFollowUpType("follow_up")}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ fontSize: 13, lineHeight: 1.35 }}>
                      <div style={{ fontWeight: 700 }}>Follow up only</div>
                      <div style={{ color: C.mut, fontSize: 11 }}>Reminder on the calendar — does NOT count as an appointment booked.</div>
                    </div>
                  </label>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="follow-up-type"
                      checked={followUpType === "appointment"}
                      onChange={() => setFollowUpType("appointment")}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ fontSize: 13, lineHeight: 1.35 }}>
                      <div style={{ fontWeight: 700 }}>Sales appointment</div>
                      <div style={{ color: C.mut, fontSize: 11 }}>Real meeting / demo — counts in today's "appointments booked" win.</div>
                    </div>
                  </label>
                </div>
              )}
            </div>

            {error && (
              <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: C.redBg, color: C.red, fontSize: 12 }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={handleClose} style={{ ...btn2, padding: "10px 20px" }}>Cancel</button>
              <button
                onClick={handleSave}
                disabled={saving || !outcomeNotes.trim()}
                style={{
                  ...btn1,
                  padding: "10px 28px",
                  opacity: (saving || !outcomeNotes.trim()) ? 0.4 : 1,
                }}
              >
                {saving ? "Saving..." : "Log Call"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
