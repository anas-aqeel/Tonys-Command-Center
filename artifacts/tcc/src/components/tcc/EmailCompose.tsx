import { useState, useEffect, useRef } from "react";
import { get, post } from "@/lib/api";
import { C, F, FS, inp, btn1, btn2 } from "./constants";
import { VoiceField } from "./VoiceField";
import { VoiceInput } from "./VoiceInput";

interface Props {
  open: boolean;
  onClose: () => void;
  prefillTo?: string;
  prefillSubject?: string;
  prefillBody?: string;
  prefillContactId?: string;
  prefillContactName?: string;
  replyToSnippet?: string;
  threadId?: string;
}

interface ContactSuggestion {
  name: string;
  email: string;
}

function ContactAutocomplete({
  value, onChange, placeholder, label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleInput = (v: string) => {
    onChange(v);
    clearTimeout(timeoutRef.current);
    const lastToken = v.split(",").pop()?.trim() || "";
    if (lastToken.length >= 3) {
      timeoutRef.current = setTimeout(async () => {
        try {
          const results = await get<ContactSuggestion[]>(`/contacts/autocomplete?q=${encodeURIComponent(lastToken)}`);
          setSuggestions(results);
          setShowSuggestions(results.length > 0);
        } catch {
          setSuggestions([]);
        }
      }, 200);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const selectSuggestion = (s: ContactSuggestion) => {
    const parts = value.split(",").map(p => p.trim()).filter(Boolean);
    parts.pop();
    const display = s.name ? `${s.name} <${s.email}>` : s.email;
    parts.push(display);
    onChange(parts.join(", "));
    setShowSuggestions(false);
  };

  return (
    <div style={{ marginBottom: 12, position: "relative" }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>{label}</label>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          value={value}
          onChange={e => handleInput(e.target.value)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder={placeholder}
          style={{ ...inp, fontSize: 14, flex: 1 }}
        />
        <VoiceInput
          onTranscript={t => onChange(value ? `${value}, ${t}` : t)}
          size={30}
        />
      </div>
      {showSuggestions && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 36, zIndex: 100,
          background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8,
          maxHeight: 200, overflow: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        }}>
          {suggestions.map((s, i) => (
            <div
              key={i}
              onClick={() => selectSuggestion(s)}
              style={{
                padding: "8px 12px", cursor: "pointer", fontSize: 13,
                borderBottom: i < suggestions.length - 1 ? `1px solid ${C.brd}` : "none",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = C.bg)}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ fontWeight: 600 }}>{s.name || s.email}</div>
              {s.name && <div style={{ fontSize: 11, color: C.mut }}>{s.email}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmailCompose({
  open, onClose,
  prefillTo, prefillSubject, prefillBody, prefillContactId, prefillContactName,
  replyToSnippet, threadId,
}: Props) {
  const [to, setTo] = useState(prefillTo || "");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(prefillSubject || "");
  const [body, setBody] = useState(prefillBody || "");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [aiDrafting, setAiDrafting] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [signature, setSignature] = useState("");
  const [sigLoading, setSigLoading] = useState(false);

  // Fetch Gmail signature once
  useEffect(() => {
    if (signature || sigLoading) return;
    setSigLoading(true);
    get<{ signature: string }>("/email/signature")
      .then(r => setSignature(r.signature || "Tony Diaz\nCEO, FlipIQ"))
      .catch(() => setSignature("Tony Diaz\nCEO, FlipIQ"))
      .finally(() => setSigLoading(false));
  }, []);

  useEffect(() => {
    if (open) {
      setTo(prefillTo || "");
      setSubject(prefillSubject || "");
      setBody(prefillBody || "");
      setCc("");
      setBcc("");
      setSent(false);
      setError("");
      // Auto-load draft if opening for a contact with no prefill body
      if (prefillContactId && !prefillBody) {
        get<{ draft: string | null }>(`/contacts/${prefillContactId}/draft`)
          .then(r => { if (r?.draft) setBody(r.draft); })
          .catch(() => {});
      }
    }
  }, [open, prefillTo, prefillSubject, prefillBody, prefillContactId]);

  const handleRewrite = async () => {
    if (!body.trim() || rewriting) return;
    setRewriting(true);
    setError("");
    try {
      // Pull the first email out of the to-field (handles "Name <a@b.com>, c@d.com")
      const firstTo = to.split(",")[0]?.trim() || "";
      const bracket = firstTo.match(/^([^<]*)<([^>]+)>$/);
      const recipientName = bracket ? bracket[1].trim() : (prefillContactName || undefined);
      const recipientEmail = bracket ? bracket[2].trim() : (firstTo.includes("@") ? firstTo : undefined);

      const r = await post<{ ok: boolean; text?: string; error?: string }>("/emails/rewrite", {
        text: body,
        recipientName,
        recipientEmail,
        threadSnippet: replyToSnippet || undefined,
      });
      if (r.ok && r.text) {
        setBody(r.text);
      } else {
        setError(r.error || "Rewrite failed — try again");
      }
    } catch (err: any) {
      setError(err?.message?.slice(0, 200) || "Rewrite failed — try again");
    } finally {
      setRewriting(false);
    }
  };

  const handleAiDraft = async () => {
    setAiDrafting(true);
    setError("");
    try {
      const result = await post<{ ok: boolean; subject: string; body: string }>("/email/suggest-draft", {
        to,
        subject,
        contactName: prefillContactName,
        replyToSnippet,
        context: body || undefined,
      });
      if (result.body) setBody(result.body);
      if (result.subject) setSubject(result.subject);
    } catch {
      setError("AI draft failed — check that the API server is running");
    }
    setAiDrafting(false);
  };

  // Full body including signature separator
  const fullBodyForSend = () => {
    const trimmed = body.trim();
    if (!signature) return trimmed;
    const sep = "\n\n--\n";
    // Avoid double-appending if user already typed the signature
    if (trimmed.includes(signature.trim())) return trimmed;
    return `${trimmed}${sep}${signature}`;
  };

  const handleSend = async () => {
    if (!to || !subject || !body.trim()) {
      setError("To, Subject, and Body are required");
      return;
    }
    setSending(true);
    setError("");
    try {
      await post("/email/send", {
        to, cc: cc || undefined, bcc: bcc || undefined,
        subject,
        body: fullBodyForSend(),
        threadId: threadId || undefined,
        contactId: prefillContactId || undefined,
      });
      setSent(true);
      setTimeout(onClose, 1500);
    } catch {
      setError("Failed to send email. Check your connection and try again.");
    }
    setSending(false);
  };

  if (!open) return null;

  const canSend = !!to && !!subject && !!body.trim() && !sending;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 14, padding: 28, width: 620, maxWidth: "95vw", maxHeight: "92vh", overflow: "auto" }}>

        {sent ? (
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>&#10003;</div>
            <div style={{ fontFamily: FS, fontSize: 20, color: C.grn }}>Email Sent</div>
            <div style={{ fontSize: 13, color: C.mut, marginTop: 6 }}>Sent from {import.meta.env.VITE_USER_EMAIL || "tony@flipiq.com"}</div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontFamily: FS, fontSize: 20, margin: 0 }}>
                {replyToSnippet ? "Reply" : "New Email"}
              </h3>
              <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: C.mut }}>&#10005;</button>
            </div>

            {prefillContactId && prefillTo ? (
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>To</label>
                <div style={{ ...inp, fontSize: 14, background: "#F0EFEB", color: C.tx, display: "flex", alignItems: "center", gap: 6 }}>
                  {prefillContactName && <span style={{ fontWeight: 600 }}>{prefillContactName}</span>}
                  <span style={{ color: C.sub }}>{prefillContactName ? `<${to}>` : to}</span>
                </div>
              </div>
            ) : (
              <ContactAutocomplete value={to} onChange={setTo} placeholder="name@example.com" label="To" />
            )}
            <ContactAutocomplete value={cc} onChange={setCc} placeholder="cc@example.com" label="CC (optional)" />
            <ContactAutocomplete value={bcc} onChange={setBcc} placeholder="bcc@example.com" label="BCC (optional)" />

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 4 }}>Subject</label>
              <VoiceField value={subject} onChange={setSubject} placeholder="Subject line" style={{ ...inp, fontSize: 14 }} />
            </div>

            <div style={{ marginBottom: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1 }}>Body</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={handleRewrite}
                    disabled={rewriting || aiDrafting || !body.trim()}
                    title="Rewrite the body in Tony's voice. Works on a messy draft OR an instruction like 'write to Chris about Friday meeting'."
                    style={{ ...btn2, padding: "4px 12px", fontSize: 11, color: "#7C3AED", borderColor: "#7C3AED", opacity: (rewriting || aiDrafting || !body.trim()) ? 0.6 : 1 }}
                  >
                    {rewriting ? "Rewriting…" : "✨ Rewrite with AI"}
                  </button>
                  <button
                    onClick={handleAiDraft}
                    disabled={aiDrafting || rewriting}
                    style={{ ...btn2, padding: "4px 12px", fontSize: 11, color: C.blu, borderColor: C.blu, opacity: (aiDrafting || rewriting) ? 0.6 : 1 }}
                  >
                    {aiDrafting ? "Drafting…" : "AI Draft"}
                  </button>
                </div>
              </div>

              {/* Compose area: body + signature preview */}
              <div style={{ border: `1px solid ${C.brd}`, borderRadius: 8, background: "#FAFAF8", overflow: "hidden" }}>
                <VoiceField
                  as="textarea"
                  value={body}
                  onChange={setBody}
                  placeholder={replyToSnippet ? "Write your reply…" : "Write your message…"}
                  style={{
                    width: "100%", minHeight: 160, padding: "12px 14px",
                    border: "none", outline: "none", resize: "vertical",
                    fontSize: 14, lineHeight: 1.6, fontFamily: F,
                    background: "transparent", boxSizing: "border-box",
                  }}
                />
                {signature && (
                  <div style={{
                    padding: "8px 14px 12px",
                    borderTop: `1px solid ${C.brd}`,
                    fontSize: 13, color: C.mut, fontFamily: F,
                    lineHeight: 1.5, whiteSpace: "pre-wrap",
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.brd, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>— Signature</div>
                    {signature}
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: 12, marginTop: 8, padding: "8px 12px", borderRadius: 8, background: C.redBg, color: C.red, fontSize: 12 }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
              <button onClick={onClose} style={{ ...btn2, padding: "10px 20px" }}>Cancel</button>
              <button
                onClick={handleSend}
                disabled={!canSend}
                style={{ ...btn1, padding: "10px 28px", opacity: canSend ? 1 : 0.4 }}
              >
                {sending ? "Sending…" : "Send via Gmail"}
              </button>
            </div>

            <div style={{ fontSize: 10, color: C.mut, marginTop: 8, textAlign: "center" }}>
              Sends from {import.meta.env.VITE_USER_EMAIL || "tony@flipiq.com"} · signature appended automatically
            </div>
          </>
        )}
      </div>
    </div>
  );
}
