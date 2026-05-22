import { useState } from "react";
import { post } from "@/lib/api";
import { C, F, FS } from "./constants";
import { VoiceInput } from "./VoiceInput";
import type { Contact } from "./types";

interface Props {
  contact: Contact;
  onClose: () => void;
  apiBase?: string;
}

export function SmsModal({ contact, onClose }: Props) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSend() {
    if (!message.trim()) return;
    setSending(true);
    setError("");
    try {
      const data = await post<{ sent?: boolean; macrodroid_configured?: boolean; macrodroid_triggered?: boolean }>("/send-sms", {
        phone_number: contact.phone,
        message: message.trim(),
        contact_id: String(contact.id),
      });
      setSent(true);
      // B8 (Tony's 2026-05-16): surface the exact delivery state instead of
      // silently saying "Sent ✓" when MacroDroid failed.
      //   - configured + triggered → real success
      //   - configured but NOT triggered → URL exists but the webhook 4xx/5xx'd
      //     (typical when the macro was deleted or rebuilt — URL is stale)
      //   - not configured → env var missing on the server
      if (!data.macrodroid_configured) {
        setError("Logged, but MacroDroid webhook is not configured on the server. SMS will not arrive on your phone until MACRODROID_WEBHOOK_URL is set.");
        // Don't auto-close — Tony needs to see the message.
        return;
      }
      if (!data.macrodroid_triggered) {
        setError("Logged, but the MacroDroid webhook call failed. Likely causes: (1) the macro URL has changed on your phone — regenerate and update MACRODROID_WEBHOOK_URL, or (2) the MacroDroid app permissions were revoked. Open MacroDroid → Trigger History to check.");
        return;
      }
      setTimeout(onClose, 1800);
    } catch (err) {
      console.error("[SmsModal] Send failed:", err);
      setError("Network error. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 28, width: "100%", maxWidth: 420, fontFamily: F, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ fontFamily: FS, fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
          💬 Text {contact.name}
        </div>
        <div style={{ fontSize: 12, color: C.mut, marginBottom: 16 }}>{contact.phone}</div>

        {sent ? (
          <div style={{ textAlign: "center", padding: "20px 0", fontSize: 15, color: C.grn, fontWeight: 700 }}>
            ✓ Message logged {!error ? "& sent from your phone!" : ""}
            {error && <div style={{ fontSize: 12, color: C.mut, fontWeight: 400, marginTop: 6 }}>{error}</div>}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Type your message..."
                style={{
                  flex: 1, border: `1px solid ${C.brd}`, borderRadius: 10, padding: 12,
                  fontFamily: F, fontSize: 14, height: 110, resize: "vertical",
                  outline: "none", boxSizing: "border-box",
                }}
                autoFocus
                onKeyDown={e => { if (e.key === "Enter" && e.metaKey) handleSend(); }}
              />
              <VoiceInput onTranscript={t => setMessage(prev => prev ? prev + " " + t : t)} size={34} />
            </div>
            {error && <div style={{ fontSize: 12, color: "#E05", marginBottom: 8 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${C.brd}`, background: "transparent", cursor: "pointer", fontFamily: F, fontSize: 13, color: C.mut }}>
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={sending || !message.trim()}
                style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: message.trim() ? C.blu : C.brd, color: "#fff", cursor: message.trim() ? "pointer" : "not-allowed", fontFamily: F, fontSize: 13, fontWeight: 700 }}
              >
                {sending ? "Sending…" : "Send from my phone"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: C.mut, marginTop: 10, textAlign: "center" }}>
              🎙 Voice input · ⌘↵ to send · Triggers MacroDroid on your Android
            </div>
          </>
        )}
      </div>
    </div>
  );
}
