import { useState, useEffect, useCallback, useRef } from "react";
import { get, patch, post, del } from "@/lib/api";
import { C, F, PC, PCBg, SC, PIPELINE_STAGES, LEAD_SOURCES, STATUS_OPTIONS, CONTACT_TYPES, CONTACT_CATEGORIES } from "./constants";
import { VoiceField } from "./VoiceField";
import { PainPointsSelect } from "./PainPointsSelect";
import { MultiSelectFilter } from "./MultiSelectFilter";
import { LinksEditor, type TaskLink } from "./LinksEditor";
import { showToast } from "./Toast";
import type { Contact, ContactNote, CallEntry } from "./types";

// Multi-select filter shape (Tony's 2026-05-16 ask). Empty array = no filter.
interface FilterState {
  status: string[];
  stage: string[];
  type: string[];
  category: string[];
  search: string;
}

interface Props {
  contactId: string | null;
  onClose: () => void;
  onUpdated: (contact: Contact) => void;
  onDeleted: (id: string) => void;
  onAttempt: (contact: { id: string | number; name: string }) => void;
  onConnected: (contact: { contactId: string; contactName: string; contactEmail?: string }) => void;
  onSmsOpen: (contact: Contact) => void;
  onCompose?: (contact: Contact) => void;
  contacts?: Contact[];
  onNavigate?: (id: string) => void;
  filters?: FilterState;
  onFiltersChange?: (partial: Partial<FilterState>) => void;
}

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.brd}`,
  fontSize: 13, fontFamily: F, boxSizing: "border-box", outline: "none", background: "#FAFAF8",
};
const sel: React.CSSProperties = { ...inp, cursor: "pointer" };
const lbl: React.CSSProperties = {
  display: "block", fontSize: 10, fontWeight: 700, color: C.mut,
  textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4,
};
const fieldRow: React.CSSProperties = { marginBottom: 12 };


function isOverdue(date?: string | null): boolean {
  if (!date) return false;
  return new Date(date) < new Date(new Date().toDateString());
}

export function ContactDrawer({ contactId, onClose, onUpdated, onDeleted, onAttempt, onConnected, onSmsOpen, onCompose, contacts, onNavigate, filters, onFiltersChange }: Props) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [calls, setCalls] = useState<CallEntry[]>([]);
  const [comms, setComms] = useState<{ id: string; channel: string; direction: string; subject?: string; summary?: string; loggedAt?: string; contactName?: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [draft, setDraft] = useState<Partial<Contact>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "notes" | "activity" | "meetings" | "links">("details");
  const [meetings, setMeetings] = useState<{ id: string; date: string; contactName: string | null; summary: string | null; nextSteps: string | null; outcome: string | null }[]>([]);
  const [meetingsLoaded, setMeetingsLoaded] = useState(false);
  const [showAddMeeting, setShowAddMeeting] = useState(false);
  const [meetingTranscript, setMeetingTranscript] = useState("");
  const [meetingDate, setMeetingDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }));
  const [extractingMeeting, setExtractingMeeting] = useState(false);
  const [deletingMeetingId, setDeletingMeetingId] = useState<string | null>(null);
  const [interacted, setInteracted] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);

  const currentIndex = contacts && contactId ? contacts.findIndex(c => String(c.id) === contactId) : -1;
  const total = contacts?.length ?? 0;
  const prevId = currentIndex > 0 && contacts ? String(contacts[currentIndex - 1].id) : null;
  const nextId = currentIndex < total - 1 && contacts ? String(contacts[currentIndex + 1].id) : null;

  const hasActiveFilters = !!filters && (
    filters.status.length > 0 || filters.stage.length > 0 ||
    filters.type.length > 0 || filters.category.length > 0 || filters.search.trim() !== ""
  );

  const refreshContact = useCallback((cid: string, resetView = true) => {
    if (resetView) {
      setLoading(true);
      setActiveTab("details");
      setMeetings([]);
      setMeetingsLoaded(false);
      setInteracted(false);
    }
    get<Contact & { _notes: ContactNote[]; _calls: CallEntry[]; _comms?: typeof comms }>(`/contacts/${cid}`)
      .then(data => {
        const { _notes, _calls, _comms, ...c } = data;
        setContact(c);
        if (resetView) { setDraft(c); setHasChanges(false); }
        setNotes(_notes ?? []);
        setCalls(_calls ?? []);
        setComms(_comms ?? []);
        if ((_calls ?? []).length > 0 || (_comms ?? []).length > 0 || (_notes ?? []).length > 0) {
          setInteracted(true);
        }
      })
      .catch(() => {})
      .finally(() => { if (resetView) setLoading(false); });
  }, []);

  useEffect(() => {
    if (!contactId) { setContact(null); setDraft({}); setHasChanges(false); setMeetings([]); setMeetingsLoaded(false); setInteracted(false); return; }
    refreshContact(contactId, true);
  }, [contactId, refreshContact]);

  // No periodic refresh — data refreshes on tab switch or after user actions

  useEffect(() => {
    if (activeTab !== "meetings" || meetingsLoaded || !contact?.name) return;
    get<typeof meetings>(`/meeting-history?contactName=${encodeURIComponent(contact.name)}&limit=20`)
      .then(rows => { setMeetings(rows ?? []); setMeetingsLoaded(true); })
      .catch(() => { setMeetingsLoaded(true); });
  }, [activeTab, meetingsLoaded, contact]);

  const updateDraft = useCallback((field: keyof Contact, value: unknown) => {
    setDraft(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
    setInteracted(true);
  }, []);

  const handleManualSave = useCallback(async () => {
    if (!hasChanges || !contactId) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      const fields: (keyof Contact)[] = [
        "name", "company", "title", "phone", "email", "status", "pipelineStage",
          "type", "category", "dealValue", "dealProbability", "leadSource", "linkedinUrl", "website",
          "nextStep", "notes", "followUpDate", "expectedCloseDate", "lastContactDate", "tags", "painPoints",
        ];
        for (const f of fields) {
          if (f in draft) payload[f] = (draft as Record<string, unknown>)[f];
        }
        const updated = await patch<Contact>(`/contacts/${contactId}`, payload);
        setContact(updated);
        setDraft(updated);
        setHasChanges(false);
        onUpdated(updated);
        setSaveMsg("Saved ✓");
        setTimeout(() => setSaveMsg(""), 2000);
      } catch {
        setSaveMsg("Error saving");
        setTimeout(() => setSaveMsg(""), 2000);
      } finally {
        setSaving(false);
      }
  }, [draft, hasChanges, contactId, onUpdated]);

  const handleClose = useCallback(() => {
    if (hasChanges) { setShowUnsavedWarning(true); return; }
    onClose();
  }, [hasChanges, onClose]);

  const handleAddNote = useCallback(async () => {
    if (!contactId || !noteText.trim()) return;
    setAddingNote(true);
    try {
      const note = await post<ContactNote>(`/contacts/${contactId}/notes`, { text: noteText.trim() });
      setNotes(prev => [note, ...prev]);
      setNoteText("");
    } catch { /* silent */ }
    finally { setAddingNote(false); }
  }, [contactId, noteText]);

  const handleDelete = useCallback(async () => {
    if (!contactId || !contact) return;
    try {
      await del(`/contacts/${contactId}`);
      onDeleted(contactId);
      onClose();
    } catch { /* silent */ }
  }, [contactId, contact, onDeleted, onClose]);

  if (!contactId) return null;

  const navBtnStyle = (enabled: boolean): React.CSSProperties => ({
    background: "none", border: `1px solid ${enabled ? C.brd : "transparent"}`, borderRadius: 6,
    color: enabled ? C.tx : C.brd, cursor: enabled ? "pointer" : "default",
    fontSize: 14, fontWeight: 700, padding: "2px 8px", fontFamily: F, lineHeight: 1.4,
  });

  return (
    <>
      <div
        onClick={handleClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.18)", zIndex: 999, backdropFilter: "blur(1px)" }}
      />
      {/* Unsaved changes warning dialog */}
      {showUnsavedWarning && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: "24px 28px", maxWidth: 380, boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#B45309", marginBottom: 8 }}>Unsaved Changes</div>
            <div style={{ fontSize: 13, color: "#374151", marginBottom: 16 }}>You have unsaved changes. Save them before closing to keep your updates.</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setShowUnsavedWarning(false); setHasChanges(false); onClose(); }} style={{
                background: "#F3F4F6", color: "#374151", border: "1px solid #D1D5DB", borderRadius: 6,
                padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Discard & Close</button>
              <button onClick={async () => { setShowUnsavedWarning(false); await handleManualSave(); onClose(); }} style={{
                background: "#F59E0B", color: "#fff", border: "none", borderRadius: 6,
                padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>Save & Close</button>
            </div>
          </div>
        </div>
      )}
      <div style={{
        position: "fixed", top: 0, right: 0, width: 440, height: "100vh",
        background: "#FFF", borderLeft: `1px solid ${C.brd}`, zIndex: 1000,
        display: "flex", flexDirection: "column", boxShadow: "-4px 0 20px rgba(0,0,0,0.08)",
        overflowY: "auto",
      }}>

        {/* ── Navigation + Filter bar ── */}
        {onNavigate && contacts && contacts.length > 0 && (
          <div style={{ borderBottom: `1px solid ${C.brd}`, background: "#F5F3EE", flexShrink: 0 }}>
            {/* Row 1: prev/next nav */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
              <button onClick={() => prevId && onNavigate(prevId)} style={navBtnStyle(!!prevId)}>‹</button>
              <span style={{ flex: 1, textAlign: "center", fontSize: 12, color: C.sub, fontWeight: 600, fontFamily: F }}>
                {currentIndex >= 0 ? `${currentIndex + 1} of ${total}` : `${total} contacts`}
                {hasActiveFilters && <span style={{ color: C.blu, marginLeft: 4 }}>· filtered</span>}
              </span>
              <button onClick={() => nextId && onNavigate(nextId)} style={navBtnStyle(!!nextId)}>›</button>
              {onFiltersChange && (
                <button
                  onClick={() => setShowFilters(f => !f)}
                  style={{ marginLeft: 4, padding: "3px 10px", borderRadius: 6, border: `1px solid ${hasActiveFilters ? C.blu : C.brd}`, background: hasActiveFilters ? C.bluBg : "none", color: hasActiveFilters ? C.blu : C.sub, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: F }}
                >
                  {showFilters ? "Hide Filters" : `Filters${hasActiveFilters ? " ●" : ""}`}
                </button>
              )}
              <button onClick={handleClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.mut, fontSize: 18, padding: "0 2px", lineHeight: 1, marginLeft: 2 }}>✕</button>
            </div>

            {/* Row 2: multi-select filters (Tony's 2026-05-16 ask). Empty array = no filter. */}
            {showFilters && onFiltersChange && filters && (
              <div style={{ padding: "8px 14px 10px", display: "flex", flexWrap: "wrap", gap: 6, borderTop: `1px solid ${C.brd}` }}>
                <input
                  type="text"
                  value={filters.search}
                  onChange={e => onFiltersChange({ search: e.target.value })}
                  placeholder="Search…"
                  style={{ flex: "1 1 100%", padding: "5px 8px", borderRadius: 7, border: `1px solid ${filters.search ? C.blu : C.brd}`, fontSize: 12, fontFamily: F, outline: "none", background: "#FAFAF8" }}
                />
                <MultiSelectFilter
                  label="Status" pluralLabel="Statuses" activeColor={C.red}
                  values={filters.status} onChange={v => onFiltersChange({ status: v })}
                  options={STATUS_OPTIONS}
                />
                <MultiSelectFilter
                  label="Stage" pluralLabel="Stages" activeColor={C.blu}
                  values={filters.stage} onChange={v => onFiltersChange({ stage: v })}
                  options={PIPELINE_STAGES}
                />
                <MultiSelectFilter
                  label="Type" pluralLabel="Types" activeColor={C.amb}
                  values={filters.type} onChange={v => onFiltersChange({ type: v })}
                  options={CONTACT_TYPES}
                />
                <MultiSelectFilter
                  label="Category" pluralLabel="Categories" activeColor="#7B1FA2"
                  values={filters.category} onChange={v => onFiltersChange({ category: v })}
                  options={CONTACT_CATEGORIES}
                />
                {hasActiveFilters && (
                  <button onClick={() => onFiltersChange({ status: [], stage: [], type: [], category: [], search: "" })}
                    style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.brd}`, background: "#FAFAF8", color: C.mut, fontSize: 11, cursor: "pointer", fontFamily: F }}>
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: C.mut, fontSize: 14 }}>
            Loading…
          </div>
        ) : contact ? (
          <>
            <div style={{ padding: "20px 20px 0", borderBottom: `1px solid ${C.brd}`, background: "#FAFAF8" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 19, fontWeight: 700, color: C.tx, lineHeight: 1.2 }}>{contact.name}</div>
                  {contact.phone && (
                    <div style={{ fontSize: 15, color: C.sub, marginTop: 4, fontWeight: 600, letterSpacing: 0.2 }}>{contact.phone}</div>
                  )}
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: contact.status === "Hot" ? C.redBg : contact.status === "Warm" ? C.ambBg : C.bluBg, color: SC[contact.status || "New"] || C.mut }}>{contact.status || "New"}</span>
                    {contact.pipelineStage && <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: PCBg[contact.pipelineStage] || "#F5F5F5", color: PC[contact.pipelineStage] || C.mut }}>{contact.pipelineStage}</span>}
                    {contact.dealValue && <span style={{ fontSize: 11, fontWeight: 700, color: C.grn }}>${Number(contact.dealValue).toLocaleString()}</span>}
                    {contact.followUpDate && <span style={{ fontSize: 11, fontWeight: 700, color: isOverdue(contact.followUpDate) ? C.red : C.mut }}>{contact.followUpDate}</span>}
                  </div>
                </div>
                <button onClick={handleClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.mut, fontSize: 20, padding: 4, lineHeight: 1, flexShrink: 0 }}>✕</button>
              </div>
              {hasChanges && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0 8px", borderTop: `1px solid ${C.brd}` }}>
                  <span style={{ fontSize: 12, color: "#B45309", fontWeight: 600 }}>Unsaved changes</span>
                  <button onClick={handleManualSave} disabled={saving} style={{
                    background: "#F59E0B", color: "#fff", border: "none", borderRadius: 6,
                    padding: "5px 14px", fontSize: 12, fontWeight: 700, cursor: saving ? "default" : "pointer",
                    opacity: saving ? 0.6 : 1,
                  }}>{saving ? "Saving..." : "Save Changes"}</button>
                </div>
              )}
              {saveMsg && !hasChanges && (
                <div style={{ fontSize: 11, color: C.grn, fontWeight: 600, padding: "4px 0" }}>{saveMsg}</div>
              )}
              <div style={{ display: "flex", gap: 5, paddingBottom: 12, flexWrap: "wrap" }}>
                {contact.phone && (
                  <a href={`tel:${contact.phone}`} onClick={() => onAttempt({ id: contact.id, name: contact.name })} style={{ flex: 1, minWidth: 60, padding: "8px 4px", background: C.tx, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F, textAlign: "center", textDecoration: "none", display: "block" }}>Call</a>
                )}
                {contact.phone && (
                  <button onClick={() => { setInteracted(true); onSmsOpen(contact); }} style={{ flex: 1, minWidth: 60, padding: "8px 4px", background: C.bluBg, color: C.blu, border: `1px solid ${C.blu}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F }}>Text</button>
                )}
                {onCompose && (
                  <button onClick={() => { setInteracted(true); onCompose(contact); }} style={{ flex: 1, minWidth: 60, padding: "8px 4px", background: C.bluBg, color: C.blu, border: `1px solid ${C.blu}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F }}>Email</button>
                )}
                <button
                  onClick={() => { if (interacted) onConnected({ contactId: String(contact.id), contactName: contact.name, contactEmail: contact.email || undefined }); }}
                  disabled={!interacted}
                  title={interacted ? "Log as done" : "Send a text, email, or make an update first"}
                  style={{ flex: 1, minWidth: 60, padding: "8px 4px", background: interacted ? C.grnBg : "#F0F0EE", color: interacted ? C.grn : C.mut, border: `1px solid ${interacted ? C.grn : C.brd}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: interacted ? "pointer" : "not-allowed", fontFamily: F, transition: "all 0.2s" }}>Done</button>
                <button onClick={() => setConfirmDelete(!confirmDelete)} style={{ padding: "8px 10px", background: C.redBg, color: C.red, border: `1px solid ${C.redBg}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F }}>🗑</button>
              </div>
              {confirmDelete && (
                <div style={{ background: C.redBg, borderRadius: 8, padding: "10px 12px", marginBottom: 8, fontSize: 13 }}>
                  Delete {contact.name}? <button onClick={handleDelete} style={{ marginLeft: 8, padding: "3px 10px", background: C.red, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Delete</button>
                  <button onClick={() => setConfirmDelete(false)} style={{ marginLeft: 6, padding: "3px 10px", background: C.card, color: C.tx, border: `1px solid ${C.brd}`, borderRadius: 6, cursor: "pointer", fontSize: 12 }}>Cancel</button>
                </div>
              )}
              <div style={{ display: "flex", gap: 0, borderTop: `1px solid ${C.brd}`, marginTop: 4 }}>
                {(["details", "notes", "activity", "meetings", "links"] as const).map(tab => {
                  const linkCount = Array.isArray(contact?.links) ? contact!.links!.length : 0;
                  return (
                    <button key={tab} onClick={() => setActiveTab(tab)} style={{ flex: 1, padding: "10px 2px", background: "none", border: "none", borderBottom: activeTab === tab ? `2px solid ${C.tx}` : "2px solid transparent", fontFamily: F, fontSize: 11, fontWeight: 700, color: activeTab === tab ? C.tx : C.mut, cursor: "pointer", textTransform: "capitalize", letterSpacing: 0.4 }}>
                      {tab === "notes" ? `Notes (${notes.length})`
                        : tab === "activity" ? `Activity (${calls.length + comms.length})`
                        : tab === "meetings" ? `Meetings${meetingsLoaded ? ` (${meetings.length})` : ""}`
                        : tab === "links" ? `Links (${linkCount})`
                        : "Details"}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 24px" }}>
              {activeTab === "details" && (
                <>
                  {/* Quick Note */}
                  <div style={{ marginBottom: 16, padding: "12px 14px", background: "#FAFAF8", borderRadius: 10, border: `1px solid ${C.brd}` }}>
                    <label style={lbl}>Quick Note</label>
                    <VoiceField
                      as="textarea"
                      value={noteText}
                      onChange={setNoteText}
                      onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAddNote(); }}
                      rows={2}
                      placeholder="Jot a note… (⌘↵ to save)"
                      style={{ ...inp, resize: "none", marginBottom: 6, fontSize: 12 }}
                    />
                    <button
                      onClick={handleAddNote}
                      disabled={addingNote || !noteText.trim()}
                      style={{ padding: "6px 14px", background: noteText.trim() ? C.tx : "#E8E6E1", color: noteText.trim() ? "#fff" : C.mut, border: "none", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: noteText.trim() ? "pointer" : "not-allowed", fontFamily: F }}
                    >
                      {addingNote ? "Saving…" : "Save Note"}
                    </button>
                    {notes.length > 0 && (
                      <span style={{ fontSize: 11, color: C.mut, marginLeft: 8 }}>{notes.length} note{notes.length !== 1 ? "s" : ""} · see Notes tab</span>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Status</label>
                      <select value={draft.status || "New"} onChange={e => updateDraft("status", e.target.value)} style={sel}>
                        {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Pipeline Stage</label>
                      <select value={draft.pipelineStage || "Lead"} onChange={e => updateDraft("pipelineStage", e.target.value)} style={sel}>
                        {PIPELINE_STAGES.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Deal Value ($)</label>
                      <input type="number" value={draft.dealValue ?? ""} onChange={e => updateDraft("dealValue", e.target.value)} style={inp} placeholder="0" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Probability (%)</label>
                      <input type="number" min={0} max={100} value={draft.dealProbability ?? ""} onChange={e => updateDraft("dealProbability", Number(e.target.value))} style={inp} placeholder="0–100" />
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Follow-up Date</label>
                      <input type="date" value={draft.followUpDate ?? ""} onChange={e => updateDraft("followUpDate", e.target.value)} style={{ ...inp, color: isOverdue(draft.followUpDate) ? C.red : C.tx }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Expected Close</label>
                      <input type="date" value={draft.expectedCloseDate ?? ""} onChange={e => updateDraft("expectedCloseDate", e.target.value)} style={inp} />
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Contact Type</label>
                      <select value={draft.type || ""} onChange={e => updateDraft("type", e.target.value)} style={sel}>
                        <option value="">— Select —</option>
                        {CONTACT_TYPES.map(t => <option key={t}>{t}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Category</label>
                      <select value={draft.category || ""} onChange={e => updateDraft("category", e.target.value)} style={sel}>
                        <option value="">— Select —</option>
                        {CONTACT_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Lead Source</label>
                    <select value={draft.leadSource || ""} onChange={e => updateDraft("leadSource", e.target.value)} style={sel}>
                      <option value="">— Select —</option>
                      {LEAD_SOURCES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Next Step</label>
                    <VoiceField as="textarea" value={draft.nextStep ?? ""} onChange={v => updateDraft("nextStep", v)} rows={2} style={{ ...inp, resize: "vertical" }} placeholder="What's the next action?" />
                  </div>

                  <hr style={{ border: "none", borderTop: `1px solid ${C.brd}`, margin: "14px 0" }} />

                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Name</label>
                      <VoiceField value={draft.name ?? ""} onChange={v => updateDraft("name", v)} style={inp} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Title / Role</label>
                      <VoiceField value={draft.title ?? ""} onChange={v => updateDraft("title", v)} style={inp} placeholder="CEO, Broker…" />
                    </div>
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Company</label>
                    <VoiceField value={draft.company ?? ""} onChange={v => updateDraft("company", v)} style={inp} />
                  </div>

                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Phone</label>
                      <input value={draft.phone ?? ""} onChange={e => updateDraft("phone", e.target.value)} style={inp} type="tel" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>Email</label>
                      <input value={draft.email ?? ""} onChange={e => updateDraft("email", e.target.value)} style={inp} type="email" />
                    </div>
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>LinkedIn URL</label>
                    <input value={draft.linkedinUrl ?? ""} onChange={e => updateDraft("linkedinUrl", e.target.value)} style={inp} placeholder="https://linkedin.com/in/…" />
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Website</label>
                    <input value={draft.website ?? ""} onChange={e => updateDraft("website", e.target.value)} style={inp} placeholder="https://…" />
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Tags (comma-separated)</label>
                    <VoiceField value={(draft.tags ?? []).join(", ")} onChange={v => updateDraft("tags", v.split(",").map(t => t.trim()).filter(Boolean))} style={inp} placeholder="investor, warm, referral…" />
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Pain Points</label>
                    <PainPointsSelect value={draft.painPoints} onChange={v => updateDraft("painPoints", v)} compact />
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Notes</label>
                    <VoiceField as="textarea" value={draft.notes ?? ""} onChange={v => updateDraft("notes", v)} rows={3} style={{ ...inp, resize: "vertical" }} placeholder="Internal notes about this contact…" />
                  </div>

                  <div style={fieldRow}>
                    <label style={lbl}>Last Contact Date</label>
                    <input type="date" value={draft.lastContactDate ?? ""} onChange={e => updateDraft("lastContactDate", e.target.value)} style={inp} />
                  </div>

                  {saveMsg && (
                    <div style={{ fontSize: 11, color: saveMsg.includes("Error") ? C.red : saveMsg === "Unsaved…" ? C.mut : C.grn, fontWeight: 600, textAlign: "right", marginTop: 4, transition: "color 0.3s" }}>{saveMsg}</div>
                  )}
                </>
              )}

              {activeTab === "notes" && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <VoiceField
                      as="textarea"
                      value={noteText}
                      onChange={setNoteText}
                      onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAddNote(); }}
                      rows={3}
                      placeholder="Add a note… (⌘↵ to save)"
                      style={{ ...inp, resize: "vertical", marginBottom: 8 }}
                    />
                    <button onClick={handleAddNote} disabled={addingNote || !noteText.trim()} style={{ width: "100%", padding: "9px 0", background: C.tx, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: addingNote || !noteText.trim() ? "not-allowed" : "pointer", fontFamily: F, opacity: addingNote || !noteText.trim() ? 0.5 : 1 }}>
                      {addingNote ? "Adding…" : "+ Add Note"}
                    </button>
                  </div>
                  {notes.length === 0 ? (
                    <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: "24px 0" }}>No notes yet</div>
                  ) : (
                    notes.map(n => (
                      <div key={n.id} style={{ padding: "10px 12px", background: "#FAFAF8", borderRadius: 10, marginBottom: 8, borderLeft: `3px solid ${C.brd}` }}>
                        <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.text}</div>
                        <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>{n.createdAt ? new Date(n.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : ""}</div>
                      </div>
                    ))
                  )}
                </>
              )}

              {activeTab === "activity" && (() => {
                type ActivityItem =
                  | { kind: "call"; data: CallEntry & { followUpText?: string }; ts: number }
                  | { kind: "note"; data: ContactNote; ts: number }
                  | { kind: "comm"; data: typeof comms[number]; ts: number };

                const items: ActivityItem[] = [
                  ...calls.map(cl => ({
                    kind: "call" as const,
                    data: cl as CallEntry & { followUpText?: string },
                    ts: cl.createdAt ? new Date(cl.createdAt).getTime() : 0,
                  })),
                  ...notes.map(n => ({
                    kind: "note" as const,
                    data: n,
                    ts: n.createdAt ? new Date(n.createdAt).getTime() : 0,
                  })),
                  ...comms.map(cm => ({
                    kind: "comm" as const,
                    data: cm,
                    ts: cm.loggedAt ? new Date(cm.loggedAt).getTime() : 0,
                  })),
                ].sort((a, b) => b.ts - a.ts);

                if (items.length === 0) {
                  return <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: "24px 0" }}>No activity yet</div>;
                }

                return (
                  <>
                    {items.map((item, i) => {
                      if (item.kind === "call") {
                        const cl = item.data;
                        return (
                          <div key={`call-${i}`} style={{ padding: "10px 12px", background: "#FAFAF8", borderRadius: 10, marginBottom: 8, borderLeft: `3px solid ${cl.type === "connected" ? C.grn : C.mut}` }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 }}>Call</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: cl.type === "connected" ? C.grn : C.tx }}>
                              {cl.type === "connected" ? "✓ Connected" : cl.type === "attempt" ? "Attempt — no answer" : cl.type}
                            </div>
                            {cl.notes && <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{cl.notes}</div>}
                            {cl.followUpText && <div style={{ fontSize: 12, color: C.blu, marginTop: 4, fontStyle: "italic" }}>Follow-up draft: {cl.followUpText}</div>}
                            <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>{cl.createdAt ? new Date(cl.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : ""}</div>
                          </div>
                        );
                      } else if (item.kind === "comm") {
                        const cm = item.data;
                        const isEmail = cm.channel?.includes("email");
                        const isText = cm.channel?.includes("text") || cm.channel?.includes("sms");
                        const isInbound = cm.direction === "inbound";
                        const accentColor = isEmail ? "#E65100" : isText ? "#7B1FA2" : C.blu;
                        const channelLabel = isEmail ? (isInbound ? "Email Received" : "Email Sent") : isText ? (isInbound ? "Text Received" : "Text Sent") : cm.channel?.replace(/_/g, " ") || "Communication";
                        return (
                          <div key={`comm-${cm.id}`} style={{ padding: "10px 12px", background: "#FAFAF8", borderRadius: 10, marginBottom: 8, borderLeft: `3px solid ${accentColor}` }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: accentColor, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 }}>
                              {isInbound ? "↓ " : "↑ "}{channelLabel}
                            </div>
                            {cm.subject && <div style={{ fontSize: 13, fontWeight: 600, color: C.tx }}>{cm.subject}</div>}
                            {cm.summary && <div style={{ fontSize: 12, color: C.sub, marginTop: 2, lineHeight: 1.4 }}>{cm.summary}</div>}
                            <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>{cm.loggedAt ? new Date(cm.loggedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : ""}</div>
                          </div>
                        );
                      } else {
                        const n = item.data;
                        const isSystemEvent = n.kind === "status_change" || n.kind === "stage_change";
                        const accentColor = n.kind === "status_change" ? C.blu : n.kind === "stage_change" ? C.grn : C.brd;
                        const label = n.kind === "status_change" ? "Status Change" : n.kind === "stage_change" ? "Stage Move" : "Note";
                        return (
                          <div key={`note-${n.id}`} style={{ padding: "10px 12px", background: isSystemEvent ? "#F8F8FF" : "#FAFAF8", borderRadius: 10, marginBottom: 8, borderLeft: `3px solid ${accentColor}` }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: accentColor, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 }}>{label}</div>
                            <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.text}</div>
                            <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>{n.createdAt ? new Date(n.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : ""}</div>
                          </div>
                        );
                      }
                    })}
                  </>
                );
              })()}
              {activeTab === "meetings" && (
                <>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                    <button
                      onClick={() => setShowAddMeeting(true)}
                      style={{
                        padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.blu}`,
                        background: C.bluBg, color: C.blu, fontSize: 12, fontWeight: 700,
                        cursor: "pointer", fontFamily: F, display: "inline-flex", alignItems: "center", gap: 6,
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1 }}>+</span> Add Meeting
                    </button>
                  </div>
                  {!meetingsLoaded ? (
                    <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: "24px 0" }}>Loading…</div>
                  ) : meetings.length === 0 ? (
                    <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: "24px 0" }}>
                      No meeting history yet.<br />
                      <span style={{ fontSize: 12 }}>Click "+ Add Meeting" to paste a transcript.</span>
                    </div>
                  ) : (
                    meetings.map(m => (
                      <div key={m.id} style={{ position: "relative", padding: "12px 14px", paddingRight: 36, background: "#FAFAF8", borderRadius: 10, marginBottom: 10, borderLeft: `3px solid ${C.blu}` }}>
                        <button
                          onClick={async () => {
                            if (deletingMeetingId === m.id) return;
                            if (!confirm("Delete this meeting?")) return;
                            setDeletingMeetingId(m.id);
                            try {
                              await del(`/meeting-history/${m.id}`);
                              setMeetings(prev => prev.filter(x => x.id !== m.id));
                              showToast({ title: "Meeting deleted" });
                            } catch (err) {
                              const msg = err instanceof Error ? err.message : String(err);
                              showToast({ title: "Failed to delete", description: msg, variant: "error" });
                            } finally {
                              setDeletingMeetingId(null);
                            }
                          }}
                          disabled={deletingMeetingId === m.id}
                          title="Delete meeting"
                          style={{
                            position: "absolute", top: 8, right: 8, width: 24, height: 24,
                            background: "transparent", border: "none", cursor: deletingMeetingId === m.id ? "not-allowed" : "pointer",
                            color: C.mut, fontSize: 14, lineHeight: 1, opacity: deletingMeetingId === m.id ? 0.5 : 1,
                          }}
                        >
                          {deletingMeetingId === m.id ? "…" : "🗑"}
                        </button>
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.blu, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>
                          {m.date}
                        </div>
                        {m.summary && <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.5, marginBottom: 4 }}>{m.summary}</div>}
                        {m.nextSteps && (
                          <div style={{ fontSize: 12, color: C.grn, marginTop: 4, whiteSpace: "pre-wrap" }}>
                            <span style={{ fontWeight: 700 }}>Next Steps: </span>{m.nextSteps}
                          </div>
                        )}
                        {m.outcome && (
                          <div style={{ fontSize: 11, fontWeight: 700, marginTop: 6, padding: "2px 8px", background: C.grnBg, color: C.grn, borderRadius: 4, display: "inline-block" }}>
                            {m.outcome}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </>
              )}

              {activeTab === "links" && contact && (
                <LinksEditor
                  value={contact.links || []}
                  onChange={async (next: TaskLink[]) => {
                    // Optimistically update local contact + PATCH to BE. On
                    // success the response replaces the contact so any BE
                    // sanitization (e.g. https:// auto-prepend) shows up.
                    setContact(prev => prev ? { ...prev, links: next } : prev);
                    try {
                      const updated = await patch<Contact>(`/contacts/${contact.id}`, { links: next });
                      setContact(updated);
                      onUpdated(updated);
                    } catch (err) {
                      showToast({ title: "Failed to save links", description: err instanceof Error ? err.message : "Try again", variant: "error" });
                    }
                  }}
                  label="Links"
                />
              )}

              {/* Add Meeting modal */}
              {showAddMeeting && (
                <div
                  style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
                  onClick={e => { if (e.target === e.currentTarget && !extractingMeeting) setShowAddMeeting(false); }}
                >
                  <div style={{ background: C.card, borderRadius: 14, width: 560, maxWidth: "94vw", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 36px rgba(0,0,0,0.25)" }}>
                    <div style={{ padding: "16px 22px", borderBottom: `1px solid ${C.brd}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.tx }}>Add Meeting</div>
                        <div style={{ fontSize: 11, color: C.mut, marginTop: 2 }}>Paste the transcript — AI will extract a summary, next steps, and outcome.</div>
                      </div>
                      <button onClick={() => { if (!extractingMeeting) setShowAddMeeting(false); }} disabled={extractingMeeting} style={{ background: "none", border: "none", fontSize: 20, cursor: extractingMeeting ? "not-allowed" : "pointer", color: C.mut }}>✕</button>
                    </div>
                    <div style={{ padding: 22, overflowY: "auto", flex: 1 }}>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 }}>Meeting Date</label>
                        <input
                          type="date"
                          value={meetingDate}
                          onChange={e => setMeetingDate(e.target.value)}
                          disabled={extractingMeeting}
                          style={{ width: 180, padding: "6px 10px", border: `1px solid ${C.brd}`, borderRadius: 7, fontSize: 13, fontFamily: F }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 }}>Transcript</label>
                        <textarea
                          value={meetingTranscript}
                          onChange={e => setMeetingTranscript(e.target.value)}
                          disabled={extractingMeeting}
                          placeholder="Paste the full meeting transcript here…"
                          style={{ width: "100%", minHeight: 220, padding: 12, border: `1px solid ${C.brd}`, borderRadius: 8, fontSize: 13, fontFamily: F, resize: "vertical", boxSizing: "border-box" }}
                        />
                      </div>
                    </div>
                    <div style={{ padding: "14px 22px", borderTop: `1px solid ${C.brd}`, display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => setShowAddMeeting(false)}
                        disabled={extractingMeeting}
                        style={{ padding: "8px 16px", border: `1px solid ${C.brd}`, background: "#fff", borderRadius: 8, fontSize: 13, fontFamily: F, cursor: extractingMeeting ? "not-allowed" : "pointer", color: C.sub }}
                      >Cancel</button>
                      <button
                        onClick={async () => {
                          const trimmed = meetingTranscript.trim();
                          if (!trimmed) {
                            showToast({ title: "Transcript is empty", variant: "error" });
                            return;
                          }
                          setExtractingMeeting(true);
                          try {
                            const row = await post<typeof meetings[number]>("/meeting-history/extract", {
                              transcript: trimmed,
                              contactName: contact?.name || null,
                              date: meetingDate,
                            });
                            setMeetings(prev => [row, ...prev]);
                            setMeetingsLoaded(true);
                            setMeetingTranscript("");
                            setShowAddMeeting(false);
                            showToast({ title: "Meeting saved", description: "AI extracted summary + next steps" });
                          } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            showToast({ title: "Failed to save meeting", description: msg, variant: "error" });
                          } finally {
                            setExtractingMeeting(false);
                          }
                        }}
                        disabled={extractingMeeting || !meetingTranscript.trim()}
                        style={{
                          padding: "8px 18px", border: "none", background: C.blu, color: "#fff",
                          borderRadius: 8, fontSize: 13, fontFamily: F, fontWeight: 700,
                          cursor: extractingMeeting || !meetingTranscript.trim() ? "not-allowed" : "pointer",
                          opacity: extractingMeeting || !meetingTranscript.trim() ? 0.6 : 1,
                        }}
                      >
                        {extractingMeeting ? "Extracting…" : "Save & Extract"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: C.red, fontSize: 14 }}>
            Contact not found
          </div>
        )}
      </div>
    </>
  );
}
