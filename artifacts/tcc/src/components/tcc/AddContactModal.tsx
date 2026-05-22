import { useState, useRef } from "react";
import { post } from "@/lib/api";
import { C, F, FS, PIPELINE_STAGES, STATUS_OPTIONS, CONTACT_TYPES, CONTACT_CATEGORIES, LEAD_SOURCES } from "./constants";
import { VoiceField } from "./VoiceField";
import { PainPointsSelect } from "./PainPointsSelect";
import type { Contact } from "./types";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (contact: Contact) => void;
}

const inp: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${C.brd}`,
  fontSize: 14, fontFamily: F, boxSizing: "border-box", outline: "none", background: "#FAFAF8",
};
const lbl: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 700, color: C.mut,
  textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5,
};

export function AddContactModal({ open, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    name: "", company: "", title: "", phone: "", email: "",
    status: "New", pipelineStage: "Lead", leadSource: "", type: "", category: "",
    notes: "", painPoints: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Business card scan state
  const [scanning, setScanning] = useState(false);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  // B4 (Tony's 2026-05-16): downscale phone-camera photos before upload so
  // mobile scans don't fail. A raw iPhone shot is ~4-8 MB (12 MP) which
  // base64-inflates past Vercel's 4.5 MB body limit. Resize to max 1600 px on
  // the long edge + re-encode as JPEG q=0.85 → typically ~250-500 KB.
  async function downscaleToJpeg(file: File, maxEdge = 1600, quality = 0.85): Promise<{ blob: Blob; dataUrl: string }> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("Failed to read file"));
      r.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Failed to decode image (HEIC files aren't supported — switch your camera to JPEG)"));
      i.src = dataUrl;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("Encode failed")), "image/jpeg", quality);
    });
    const outDataUrl = canvas.toDataURL("image/jpeg", quality);
    return { blob, dataUrl: outDataUrl };
  }

  const handleCardCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setScanning(true);
    setScanMsg("Preparing image…");
    try {
      // B4: client-side downscale + re-encode as JPEG. Falls back to a
      // descriptive error if the image can't be decoded (e.g. HEIC).
      const { blob, dataUrl } = await downscaleToJpeg(file);
      setCardPreview(dataUrl);

      setScanMsg("Scanning business card…");
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const result = r.result as string;
          resolve(result.split(",")[1]); // strip data:image/jpeg;base64,
        };
        r.onerror = () => reject(new Error("Re-read failed"));
        r.readAsDataURL(blob);
      });

      const result = await post<{
        name?: string; company?: string; title?: string;
        phone?: string; email?: string; website?: string;
        linkedin?: string; notes?: string;
      }>("/contacts/scan-card", {
        imageBase64: base64,
        mimeType: "image/jpeg",
      });

      // Pre-fill form with extracted data
      setForm(prev => ({
        ...prev,
        name: result.name || prev.name,
        company: result.company || prev.company,
        title: result.title || prev.title,
        phone: result.phone || prev.phone,
        email: result.email || prev.email,
        notes: [
          prev.notes,
          result.website ? `Website: ${result.website}` : "",
          result.linkedin ? `LinkedIn: ${result.linkedin}` : "",
          result.notes || "",
        ].filter(Boolean).join("\n").trim(),
      }));

      setScanMsg("Card scanned — review and confirm");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Scan failed";
      setScanMsg(msg.length > 80 ? "Scan failed — fill in manually" : msg);
    } finally {
      setScanning(false);
      // Reset file input so same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError("");
    try {
      const contact = await post<Contact>("/contacts", {
        name: form.name.trim(),
        company: form.company || undefined,
        title: form.title || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        status: form.status,
        pipelineStage: form.pipelineStage,
        leadSource: form.leadSource || undefined,
        type: form.type || undefined,
        category: form.category || undefined,
        notes: form.notes || undefined,
        painPoints: form.painPoints || undefined,
      });
      onCreated(contact);
      setForm({ name: "", company: "", title: "", phone: "", email: "", status: "New", pipelineStage: "Lead", leadSource: "", type: "", category: "", notes: "", painPoints: "" });
      setCardPreview(null);
      setScanMsg("");
      onClose();
    } catch {
      setError("Failed to create contact");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.22)", zIndex: 1100, backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 500, background: "#FFF", borderRadius: 16, padding: "24px 28px",
        zIndex: 1101, boxShadow: "0 20px 60px rgba(0,0,0,0.15)", border: `1px solid ${C.brd}`,
        maxHeight: "92vh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ fontFamily: FS, fontSize: 20, margin: 0, color: C.tx }}>Add Contact</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.mut, fontSize: 20 }}>✕</button>
        </div>

        {/* ── Business Card Scanner ── */}
        <div style={{
          marginBottom: 20, padding: "14px 16px", borderRadius: 12,
          border: `1.5px dashed ${cardPreview ? C.grn : C.brd}`,
          background: cardPreview ? C.grnBg : "#FAFAF8",
          display: "flex", alignItems: "center", gap: 14,
        }}>
          {cardPreview ? (
            <img
              src={cardPreview}
              alt="Business card"
              style={{ width: 80, height: 52, objectFit: "cover", borderRadius: 6, border: `1px solid ${C.brd}`, flexShrink: 0 }}
            />
          ) : (
            <div style={{
              width: 80, height: 52, borderRadius: 6, background: C.brd + "44",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 26, flexShrink: 0,
            }}>
              📇
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.tx, marginBottom: 4 }}>
              Business Card Scan
            </div>
            {scanMsg ? (
              <div style={{ fontSize: 12, color: scanning ? C.blu : cardPreview ? C.grn : C.red, fontWeight: 600 }}>
                {scanning ? "⟳ " : cardPreview ? "✓ " : "⚠ "}{scanMsg}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: C.mut }}>Take a photo or upload — AI fills the form</div>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            // B4 (Tony's 2026-05-16): mobile scan failure was rooted in iPhone
            // HEIC defaults (Claude Vision rejects HEIC). Limit to JPEG/PNG/WebP
            // so HEICs are filtered at the OS picker before they hit the network.
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={handleCardCapture}
            style={{ display: "none" }}
          />
          <button
            type="button"
            disabled={scanning}
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.brd}`,
              background: C.card, color: scanning ? C.mut : C.tx,
              fontSize: 13, fontWeight: 600, cursor: scanning ? "not-allowed" : "pointer",
              fontFamily: F, flexShrink: 0, opacity: scanning ? 0.6 : 1,
            }}
          >
            {scanning ? "Scanning…" : cardPreview ? "Rescan" : "📷 Scan"}
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Full Name *</label>
            <VoiceField value={form.name} onChange={v => setForm(p => ({ ...p, name: v }))} style={inp} placeholder="Jane Smith" autoFocus />
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Company</label>
              <VoiceField value={form.company} onChange={v => setForm(p => ({ ...p, company: v }))} style={inp} placeholder="Acme Corp" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Title / Role</label>
              <VoiceField value={form.title} onChange={v => setForm(p => ({ ...p, title: v }))} style={inp} placeholder="CEO" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Phone</label>
              <input value={form.phone} onChange={set("phone")} style={inp} type="tel" placeholder="(555) 123-4567" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Email</label>
              <input value={form.email} onChange={set("email")} style={inp} type="email" placeholder="jane@acme.com" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Status</label>
              <select value={form.status} onChange={set("status")} style={{ ...inp, cursor: "pointer" }}>
                {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Pipeline Stage</label>
              <select value={form.pipelineStage} onChange={set("pipelineStage")} style={{ ...inp, cursor: "pointer" }}>
                {PIPELINE_STAGES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Contact Type</label>
              <select value={form.type} onChange={set("type")} style={{ ...inp, cursor: "pointer" }}>
                <option value="">— Select —</option>
                {CONTACT_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Category</label>
              <select value={form.category} onChange={set("category")} style={{ ...inp, cursor: "pointer" }}>
                <option value="">— Select —</option>
                {CONTACT_CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Lead Source</label>
            <select value={form.leadSource} onChange={set("leadSource")} style={{ ...inp, cursor: "pointer" }}>
              <option value="">— Select —</option>
              {LEAD_SOURCES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Pain Points</label>
            <PainPointsSelect value={form.painPoints} onChange={v => setForm(p => ({ ...p, painPoints: v }))} />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={lbl}>Notes</label>
            <VoiceField
              as="textarea"
              value={form.notes}
              onChange={v => setForm(p => ({ ...p, notes: v }))}
              rows={3}
              placeholder="Tap the mic to speak notes, or type here…"
              style={{ ...inp, resize: "vertical", lineHeight: 1.5, fontSize: 13 }}
            />
          </div>

          {error && <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "12px 0", background: "none", color: C.mut, border: `1px solid ${C.brd}`, borderRadius: 10, fontSize: 14, cursor: "pointer", fontFamily: F }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ flex: 2, padding: "12px 0", background: C.tx, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", fontFamily: F, opacity: saving ? 0.7 : 1 }}>
              {saving ? "Creating…" : "Create Contact"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
