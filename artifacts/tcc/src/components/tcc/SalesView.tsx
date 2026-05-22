import { useState, useEffect, useRef, useCallback } from "react";
import { get, post } from "@/lib/api";
import { C, F, FS, card, btn2, TIPS, SC, PIPELINE_STAGES, CONTACT_TYPES, CONTACT_CATEGORIES, STATUS_OPTIONS } from "./constants";
import { SmsModal } from "./SmsModal";
import { ContactDrawer } from "./ContactDrawer";
import { AddContactModal } from "./AddContactModal";
import { HoverCard } from "./HoverCard";
import { MultiSelectFilter } from "./MultiSelectFilter";
import type { Contact, CallEntry } from "./types";

interface Props {
  contacts: Contact[];
  calls: CallEntry[];
  calSide: boolean;
  onAttempt: (contact: { id: string | number; name: string }) => void;
  onConnected: (contactName: string) => void;
  onSwitchToTasks: () => void;
  onBackToSchedule: () => void;
  onCompose?: (contact: Contact) => void;
  onConnectedCall?: (contact: { contactId: string; contactName: string; contactEmail?: string }) => void;
}

function isOverdue(date?: string | null): boolean {
  if (!date) return false;
  return new Date(date) < new Date(new Date().toDateString());
}

interface BriefModalData {
  contactId: string;
  contactName: string;
  briefText: string;
  aiScore?: string | number | null;
  stage?: string;
  status?: string;
  linkedinUrl?: string | null;
  personalityNotes?: string | null;
  openTasks?: string[];
}

interface BriefChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STATUS_BG: Record<string, string> = {
  Hot: "#FEE2E2", Warm: "#FEF3C7", Cold: "#DBEAFE", New: "#F1F5F9",
};

// Icon-first action button: 32x32 square with tooltip. Connected gets text alongside.
const ICON_BTN: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 30, height: 30, borderRadius: 7,
  border: "1px solid transparent",
  fontSize: 14, fontFamily: F, cursor: "pointer",
  transition: "background 0.12s, border-color 0.12s, transform 0.08s",
  textDecoration: "none", padding: 0, lineHeight: 1,
};

const CONNECTED_BTN: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
  height: 30, padding: "0 10px", borderRadius: 7,
  border: "1px solid transparent",
  fontSize: 11, fontWeight: 700, fontFamily: F, cursor: "pointer",
  transition: "background 0.12s, border-color 0.12s",
  whiteSpace: "nowrap", marginLeft: "auto",
};

export function SalesView({ contacts: initialContacts, calls, calSide, onAttempt, onConnected, onSwitchToTasks, onBackToSchedule, onCompose, onConnectedCall }: Props) {
  const [smsContact, setSmsContact] = useState<Contact | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [showAddContact, setShowAddContact] = useState(false);
  // Multi-select filter state — empty array means "no filter" (= "All").
  // Tony's 2026-05-16 ask: allow Hot+Warm simultaneously, not single-select.
  // Backend already supports comma-separated values per /contacts?status=Hot,Warm.
  const [filterStatus, setFilterStatus] = useState<string[]>([]);
  const [filterStage, setFilterStage] = useState<string[]>([]);
  const [filterType, setFilterType] = useState<string[]>([]);
  const [filterCategory, setFilterCategory] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Contact[]>(initialContacts);
  const [total, setTotal] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMoreResults, setNoMoreResults] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [briefModal, setBriefModal] = useState<BriefModalData | null>(null);
  const [briefLoading, setBriefLoading] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<BriefChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);

  const hasFilters = !!(search.trim() || filterStatus.length || filterStage.length || filterType.length || filterCategory.length);

  useEffect(() => {
    if (!hasFilters) {
      setResults(initialContacts);
      setTotal(null);
    }
  }, [initialContacts, hasFilters]);

  const fetchContacts = useCallback(async (newOffset = 0) => {
    if (newOffset === 0) setSearching(true);
    try {
      const params = new URLSearchParams({ limit: "50", offset: String(newOffset) });
      if (search.trim()) params.set("search", search.trim());
      // Multi-select filters: join with comma. BE accepts ?status=Hot,Warm.
      if (filterStatus.length)   params.set("status",   filterStatus.join(","));
      if (filterStage.length)    params.set("stage",    filterStage.join(","));
      if (filterType.length)     params.set("type",     filterType.join(","));
      if (filterCategory.length) params.set("category", filterCategory.join(","));
      const data = await get<{ contacts: Contact[]; total: number } | Contact[]>(`/contacts?${params}`);
      const list = Array.isArray(data) ? data : data.contacts;
      const tot = Array.isArray(data) ? list.length : data.total;
      if (newOffset === 0) {
        setResults(list);
        setOffset(list.length);
        setNoMoreResults(list.length < 50);
      } else {
        setResults(prev => [...prev, ...list]);
        setOffset(prev => prev + list.length);
        setNoMoreResults(list.length < 50);
      }
      setTotal(tot);
    } catch { /* keep existing */ }
    finally { setSearching(false); setLoadingMore(false); }
  }, [search, filterStatus, filterStage, filterType, filterCategory]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!hasFilters) { setOffset(0); setNoMoreResults(false); return; }
    debounceRef.current = setTimeout(() => fetchContacts(0), search.trim() ? 300 : 0);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, filterStatus, filterStage, filterType, filterCategory, fetchContacts, hasFilters]);

  const handleLoadMore = useCallback(async () => {
    setLoadingMore(true);
    if (hasFilters) {
      await fetchContacts(offset);
    } else {
      try {
        const params = new URLSearchParams({ limit: "50", offset: String(offset) });
        const data = await get<{ contacts: Contact[]; total: number } | Contact[]>(`/contacts?${params}`);
        const list = Array.isArray(data) ? data : data.contacts;
        setResults(prev => [...prev, ...list]);
        setOffset(prev => prev + list.length);
        setNoMoreResults(list.length < 50);
        setTotal(Array.isArray(data) ? null : data.total);
      } catch { /* keep existing */ }
      finally { setLoadingMore(false); }
    }
  }, [offset, hasFilters, fetchContacts]);

  const handleContactUpdated = useCallback((updated: Contact) => {
    setResults(prev => prev.map(c => String(c.id) === String(updated.id) ? updated : c));
  }, []);

  const handleContactDeleted = useCallback((id: string) => {
    setResults(prev => prev.filter(c => String(c.id) !== id));
    setSelectedContactId(null);
  }, []);

  const handleContactCreated = useCallback((contact: Contact) => {
    setResults(prev => [contact, ...prev]);
  }, []);

  const handleGetBrief = useCallback(async (contact: Contact) => {
    setBriefLoading(String(contact.id));
    try {
      const brief = await post<BriefModalData>("/contacts/brief", { contactId: contact.id });
      setBriefModal(brief);
      setChatOpen(false);
      setChatMessages([]);
      setChatInput("");
    } catch {
      alert("Failed to generate brief");
    } finally {
      setBriefLoading(null);
    }
  }, []);

  const sendChatMessage = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || !briefModal || chatSending) return;
    const next: BriefChatMessage[] = [...chatMessages, { role: "user", content: text }];
    setChatMessages(next);
    setChatInput("");
    setChatSending(true);
    try {
      const r = await post<{ ok: boolean; reply?: string; error?: string }>("/contacts/brief/chat", {
        contactId: briefModal.contactId,
        briefText: briefModal.briefText,
        messages: next,
      });
      if (r.ok && r.reply) {
        setChatMessages(prev => [...prev, { role: "assistant", content: r.reply! }]);
      } else {
        setChatMessages(prev => [...prev, { role: "assistant", content: r.error || "Couldn't get a reply — try again." }]);
      }
    } catch (err: any) {
      const msg = err?.message?.slice(0, 200) || "Network error — try again.";
      setChatMessages(prev => [...prev, { role: "assistant", content: msg }]);
    } finally {
      setChatSending(false);
    }
  }, [chatInput, chatMessages, chatSending, briefModal]);

  const overdue = results.filter(c => c.followUpDate && isOverdue(c.followUpDate)).length;

  return (
    <>
      {smsContact && <SmsModal contact={smsContact} onClose={() => setSmsContact(null)} />}
      <ContactDrawer
        contactId={selectedContactId}
        onClose={() => setSelectedContactId(null)}
        onUpdated={handleContactUpdated}
        onDeleted={handleContactDeleted}
        onAttempt={c => { onAttempt(c); setSelectedContactId(null); }}
        onConnected={c => { if (onConnectedCall) onConnectedCall(c); else onConnected(c.contactName); setSelectedContactId(null); }}
        onSmsOpen={c => { setSmsContact(c); setSelectedContactId(null); }}
        onCompose={onCompose ? c => { onCompose(c); } : undefined}
        contacts={results}
        onNavigate={id => setSelectedContactId(id)}
        filters={{ status: filterStatus, stage: filterStage, type: filterType, category: filterCategory, search }}
        onFiltersChange={partial => {
          if (partial.status   !== undefined) setFilterStatus(partial.status);
          if (partial.stage    !== undefined) setFilterStage(partial.stage);
          if (partial.type     !== undefined) setFilterType(partial.type);
          if (partial.category !== undefined) setFilterCategory(partial.category);
          if (partial.search   !== undefined) setSearch(partial.search);
        }}
      />
      <AddContactModal open={showAddContact} onClose={() => setShowAddContact(false)} onCreated={handleContactCreated} />

      {/* ── Pre-Call Brief Modal ── */}
      {briefModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "#00000066", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
          onClick={() => { setBriefModal(null); setChatOpen(false); setChatMessages([]); setChatInput(""); }}
        >
          <div
            style={{
              ...card,
              padding: 0,
              maxWidth: chatOpen ? 920 : 560,
              width: "92%", maxHeight: "85vh",
              transition: "max-width 0.2s ease",
              display: "flex",
              overflow: "hidden",
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Brief panel */}
            <div style={{ flex: 1, padding: "18px 20px", overflowY: "auto", minWidth: 0, ...(chatOpen ? { borderRight: `1px solid ${C.brd}` } : {}) }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
                <div style={{ fontFamily: FS, fontSize: 18, fontWeight: 700 }}>{briefModal.contactName}</div>
                {briefModal.linkedinUrl && (
                  <a href={briefModal.linkedinUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: C.blu }}>LinkedIn ↗</a>
                )}
              </div>
              <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px", marginBottom: 12 }}>
                <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", color: C.tx }}>{briefModal.briefText}</div>
              </div>
              {briefModal.openTasks && briefModal.openTasks.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Open Tasks</div>
                  {briefModal.openTasks.map((t, i) => <div key={i} style={{ fontSize: 12, color: C.sub }}>→ {t}</div>)}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                {!chatOpen && (
                  <button
                    onClick={() => setChatOpen(true)}
                    style={{ ...btn2, fontSize: 12, padding: "6px 14px", color: "#7C3AED", borderColor: "#7C3AED" }}
                    title="Ask follow-up questions about this contact"
                  >
                    💬 Continue with Chat
                  </button>
                )}
                <button
                  onClick={() => { setBriefModal(null); setChatOpen(false); setChatMessages([]); setChatInput(""); }}
                  style={{ ...btn2, fontSize: 12, padding: "6px 14px" }}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Chat panel */}
            {chatOpen && (
              <div style={{ width: 380, display: "flex", flexDirection: "column", background: "#FAFAF8" }}>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.brd}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontFamily: FS, fontSize: 14, fontWeight: 700, color: C.tx }}>💬 Brief Chat</div>
                  <button
                    onClick={() => { setChatOpen(false); setChatMessages([]); setChatInput(""); }}
                    style={{ background: "none", border: "none", fontSize: 16, cursor: "pointer", color: C.mut, padding: 0 }}
                  >×</button>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {chatMessages.length === 0 && (
                    <div style={{ fontSize: 12, color: C.mut, textAlign: "center", padding: "20px 8px", lineHeight: 1.5 }}>
                      Ask a follow-up about <strong>{briefModal.contactName}</strong> — e.g. "is this person actually an investor?", "what should I open with?"
                    </div>
                  )}
                  {chatMessages.map((m, i) => (
                    <div key={i} style={{
                      alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "88%", padding: "8px 12px", borderRadius: 12,
                      fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap",
                      background: m.role === "user" ? C.blu : C.card,
                      color: m.role === "user" ? "#fff" : C.tx,
                      border: m.role === "user" ? "none" : `1px solid ${C.brd}`,
                    }}>
                      {m.content}
                    </div>
                  ))}
                  {chatSending && (
                    <div style={{ alignSelf: "flex-start", fontSize: 11, color: C.mut, fontStyle: "italic", padding: "4px 8px" }}>Thinking…</div>
                  )}
                </div>
                <div style={{ padding: "10px 12px", borderTop: `1px solid ${C.brd}`, background: C.card }}>
                  <textarea
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !chatSending && chatInput.trim()) {
                        e.preventDefault();
                        void sendChatMessage();
                      }
                    }}
                    placeholder="Ask a follow-up… (⌘↵ to send)"
                    style={{ width: "100%", minHeight: 50, resize: "vertical", padding: "8px 10px", fontSize: 12, fontFamily: F, border: `1px solid ${C.brd}`, borderRadius: 8, boxSizing: "border-box", background: "#fff" }}
                    disabled={chatSending}
                  />
                  <button
                    onClick={() => void sendChatMessage()}
                    disabled={chatSending || !chatInput.trim()}
                    style={{ marginTop: 6, width: "100%", padding: "7px 0", borderRadius: 8, border: "none", background: "#7C3AED", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: F, cursor: (chatSending || !chatInput.trim()) ? "not-allowed" : "pointer", opacity: (chatSending || !chatInput.trim()) ? 0.5 : 1 }}
                  >
                    {chatSending ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ padding: "16px 20px 40px", marginRight: calSide ? 320 : undefined, transition: "margin 0.2s" }}>

        {/* ── Header ── */}
        <div style={{ ...card, marginBottom: 12, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <h3 style={{ fontFamily: FS, fontSize: 20, margin: 0, color: C.tx, letterSpacing: -0.5 }}>Sales Mode</h3>
              <span style={{ fontSize: 12, color: C.mut, fontWeight: 500 }}>
                {results.length}{total && total > results.length ? ` of ${total}` : ""} contacts
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {calls.length > 0 && (
                <span style={{ fontSize: 12, fontWeight: 600, color: C.grn, background: "#F0FDF4", border: `1px solid #BBF7D0`, padding: "4px 10px", borderRadius: 8 }}>
                  {calls.length} call{calls.length !== 1 ? "s" : ""} today
                </span>
              )}
              {overdue > 0 && (
                <span style={{ fontSize: 12, fontWeight: 700, color: C.red, background: C.redBg, border: `1px solid #FECACA`, padding: "4px 10px", borderRadius: 8 }}>
                  ⚠ {overdue} overdue
                </span>
              )}
              <button
                onClick={() => setShowAddContact(true)}
                style={{ padding: "6px 16px", background: C.tx, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: F }}
              >
                + Add
              </button>
            </div>
          </div>

          {/* ── Filters (multi-select per Tony's 2026-05-16 feedback) ── */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            <MultiSelectFilter
              label="Status" pluralLabel="Statuses" activeColor={C.red}
              values={filterStatus} onChange={setFilterStatus}
              options={STATUS_OPTIONS}
            />
            <MultiSelectFilter
              label="Stage" pluralLabel="Stages" activeColor={C.blu}
              values={filterStage} onChange={setFilterStage}
              options={PIPELINE_STAGES}
            />
            <MultiSelectFilter
              label="Type" pluralLabel="Types" activeColor={C.amb}
              values={filterType} onChange={setFilterType}
              options={CONTACT_TYPES}
            />
            <MultiSelectFilter
              label="Category" pluralLabel="Categories" activeColor="#7B1FA2"
              values={filterCategory} onChange={setFilterCategory}
              options={CONTACT_CATEGORIES}
            />
            {hasFilters && (
              <button
                onClick={() => { setFilterStatus([]); setFilterStage([]); setFilterType([]); setFilterCategory([]); setSearch(""); }}
                style={{ padding: "5px 10px", borderRadius: 7, border: `1px solid ${C.brd}`, background: "#FAFAF8", color: C.mut, fontSize: 12, cursor: "pointer", fontFamily: F }}
              >
                Clear
              </button>
            )}
          </div>

          {/* ── Search ── */}
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: C.mut, pointerEvents: "none" }}>🔍</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, company, phone…"
              style={{ width: "100%", border: `1px solid ${C.brd}`, borderRadius: 9, padding: "8px 34px 8px 32px", fontFamily: F, fontSize: 13, outline: "none", boxSizing: "border-box", background: "#FAFAF8" }}
            />
            {searching && <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: C.mut }}>…</span>}
            {search && !searching && (
              <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: C.mut, padding: 2 }}>✕</button>
            )}
          </div>
        </div>

        {/* ── Contact List ── */}
        {results.length === 0 && (searching || (initialContacts.length === 0 && !hasFilters)) && (
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 mb-3">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} style={{ background: "#fff", border: `1px solid ${C.brd}`, borderTop: `4px solid #EEE`, borderRadius: 12, padding: 14 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
                  <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#EEE" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ width: "60%", height: 12, background: "#EEE", borderRadius: 4, marginBottom: 6 }} />
                    <div style={{ width: "45%", height: 10, background: "#F2F2F2", borderRadius: 4 }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
                  <div style={{ width: 40, height: 14, background: "#F2F2F2", borderRadius: 5 }} />
                  <div style={{ width: 60, height: 14, background: "#F2F2F2", borderRadius: 5 }} />
                </div>
                <div style={{ width: "85%", height: 10, background: "#F2F2F2", borderRadius: 4, marginBottom: 6 }} />
                <div style={{ width: "55%", height: 10, background: "#F2F2F2", borderRadius: 4 }} />
                <div style={{ display: "flex", gap: 5, marginTop: 14, paddingTop: 10, borderTop: `1px solid ${C.brd}` }}>
                  {[0, 1, 2, 3].map(j => (
                    <div key={j} style={{ flex: 1, height: 26, background: "#F5F5F5", borderRadius: 6 }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {results.length === 0 && !searching && (initialContacts.length > 0 || hasFilters) && (
          <div style={{ ...card, textAlign: "center", padding: 40, color: C.mut, fontSize: 14 }}>
            No contacts match your filters.
          </div>
        )}

        {results.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 mb-3">
            {results.map(c => {
              const od = isOverdue(c.followUpDate);
              const statusColor = SC[c.status || "New"] || C.mut;
              const statusBg = STATUS_BG[c.status || "New"] || "#F1F5F9";
              const initials = c.name.split(" ").filter(Boolean).map((n: string) => n[0]).slice(0, 2).join("").toUpperCase();
              const isLoadingBrief = briefLoading === String(c.id);

              // Last interaction: follow-up takes precedence (it's actionable), otherwise lastContactDate
              const interactionLabel = c.followUpDate
                ? (od ? "Overdue" : "Follow-up")
                : c.lastContactDate ? "Last contact" : null;
              const interactionDate = c.followUpDate || c.lastContactDate;

              return (
                <div
                  key={c.id}
                  style={{
                    position: "relative",
                    display: "flex", flexDirection: "column",
                    background: "#fff", borderRadius: 10,
                    border: `1px solid ${C.brd}`,
                    overflow: "hidden",
                    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
                    transition: "box-shadow 0.15s, border-color 0.15s, transform 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 8px 24px rgba(16,24,40,0.10)"; e.currentTarget.style.borderColor = "#D1D5DB"; e.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={e => { e.currentTarget.style.boxShadow = "0 1px 2px rgba(16,24,40,0.04)"; e.currentTarget.style.borderColor = C.brd; e.currentTarget.style.transform = "translateY(0)"; }}
                >
                  {/* Subtle left accent stripe (replaces heavy 4px top border) */}
                  <div style={{
                    position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
                    background: statusColor, opacity: 0.85,
                  }} />

                  {/* Header: Avatar + Name/Company + Status pill (top-right) */}
                  <div
                    onClick={() => setSelectedContactId(String(c.id))}
                    style={{ display: "flex", gap: 11, padding: "13px 14px 6px 16px", cursor: "pointer", alignItems: "flex-start" }}
                  >
                    <div style={{
                      width: 40, height: 40, borderRadius: "50%",
                      background: statusBg, flexShrink: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 13, fontWeight: 700, color: statusColor,
                      letterSpacing: -0.3, userSelect: "none",
                      border: `1.5px solid ${statusColor}40`,
                    }}>{initials}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 15, fontWeight: 700, color: C.tx,
                        letterSpacing: -0.2, lineHeight: 1.25,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{c.name}</div>
                      {c.company && (
                        <div style={{
                          fontSize: 12, color: C.sub, fontWeight: 500,
                          marginTop: 1, lineHeight: 1.3,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>{c.company}</div>
                      )}
                    </div>
                    <span style={{
                      fontSize: 9.5, fontWeight: 800, color: statusColor,
                      background: statusBg,
                      padding: "3px 8px", borderRadius: 999,
                      letterSpacing: 0.5, textTransform: "uppercase",
                      flexShrink: 0, lineHeight: 1.4,
                    }}>{c.status || "New"}</span>
                  </div>

                  {/* Meta line: stage · type — light, single inline row */}
                  {(c.pipelineStage || c.type) && (
                    <div
                      onClick={() => setSelectedContactId(String(c.id))}
                      style={{
                        padding: "0 14px 8px 16px", cursor: "pointer",
                        fontSize: 11, color: C.mut, fontWeight: 500,
                        display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap",
                      }}
                    >
                      {c.pipelineStage && (
                        <span style={{ color: "#6B5FF8", fontWeight: 600 }}>{c.pipelineStage}</span>
                      )}
                      {c.pipelineStage && c.type && <span style={{ color: C.brd }}>·</span>}
                      {c.type && <span>{c.type}</span>}
                    </div>
                  )}

                  {/* Body: next step + last interaction (prominent) */}
                  <div onClick={() => setSelectedContactId(String(c.id))} style={{ flex: 1, padding: "0 14px 10px 16px", cursor: "pointer", minHeight: 30 }}>
                    {c.nextStep && (
                      <div style={{
                        fontSize: 12.5, color: C.tx, lineHeight: 1.45,
                        marginBottom: 8,
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}>
                        <span style={{ color: C.mut, marginRight: 4 }}>→</span>
                        {c.nextStep}
                      </div>
                    )}
                    {/* Interaction row — prominent, dedicated */}
                    {interactionDate && (
                      <div style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        fontSize: 11.5,
                        color: od ? C.red : C.sub,
                        fontWeight: od ? 700 : 600,
                        background: od ? C.redBg : "#F9FAFB",
                        border: `1px solid ${od ? "#FECACA" : C.brd}`,
                        padding: "3px 9px", borderRadius: 6,
                      }}>
                        <span style={{ fontSize: 10 }}>{od ? "⚠" : interactionLabel === "Follow-up" ? "📅" : "🕒"}</span>
                        <span style={{ letterSpacing: 0.1 }}>{interactionLabel}: {interactionDate}</span>
                      </div>
                    )}
                    {c.painPoints && (
                      <div style={{
                        fontSize: 11, color: C.amb, marginTop: 6,
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                        overflow: "hidden", lineHeight: 1.4,
                      }}>
                        <span style={{ marginRight: 3 }}>⚡</span>
                        {c.painPoints}
                      </div>
                    )}
                  </div>

                  {/* Action bar: icon-only buttons + prominent Connected CTA */}
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "8px 12px 8px 16px",
                      borderTop: `1px solid ${C.brd}`,
                      background: "#FAFAFB",
                    }}
                    onClick={e => e.stopPropagation()}
                  >
                    {c.phone && (
                      <a
                        href={`tel:${c.phone}`}
                        onClick={() => onAttempt({ id: c.id, name: c.name })}
                        title={`Call ${c.phone}`}
                        style={{ ...ICON_BTN, background: "transparent", color: C.grn }}
                        onMouseEnter={e => { e.currentTarget.style.background = "#F0FDF4"; e.currentTarget.style.borderColor = "#BBF7D0"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
                      >📞</a>
                    )}
                    {c.phone && (
                      <button
                        onClick={() => setSmsContact(c)}
                        title="Send text message"
                        style={{ ...ICON_BTN, background: "transparent", color: C.blu }}
                        onMouseEnter={e => { e.currentTarget.style.background = "#EFF6FF"; e.currentTarget.style.borderColor = "#BFDBFE"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
                      >💬</button>
                    )}
                    {onCompose && (
                      <button
                        onClick={() => onCompose(c)}
                        title="Compose email"
                        style={{ ...ICON_BTN, background: "transparent", color: C.blu }}
                        onMouseEnter={e => { e.currentTarget.style.background = "#EFF6FF"; e.currentTarget.style.borderColor = "#BFDBFE"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
                      >✉️</button>
                    )}
                    <button
                      onClick={() => handleGetBrief(c)}
                      disabled={isLoadingBrief}
                      title={isLoadingBrief ? "Loading brief…" : "Pre-call brief"}
                      style={{
                        ...ICON_BTN, background: "transparent", color: "#6B5FF8",
                        opacity: isLoadingBrief ? 0.5 : 1,
                        cursor: isLoadingBrief ? "wait" : "pointer",
                      }}
                      onMouseEnter={e => { if (!isLoadingBrief) { e.currentTarget.style.background = "#F5F3FF"; e.currentTarget.style.borderColor = "#DDD6FE"; } }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
                    >{isLoadingBrief ? "⌛" : "📋"}</button>
                    <button
                      onClick={() => onAttempt({ id: c.id, name: c.name })}
                      title={TIPS.attempt}
                      style={{ ...ICON_BTN, background: "transparent", color: "#B45309" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#FFFBEB"; e.currentTarget.style.borderColor = "#FDE68A"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
                    >📝</button>
                    <button
                      onClick={() => onConnectedCall
                        ? onConnectedCall({ contactId: String(c.id), contactName: c.name, contactEmail: c.email || undefined })
                        : onConnected(c.name)
                      }
                      title="Log connected call"
                      style={{ ...CONNECTED_BTN, background: C.grn, color: "#fff", borderColor: C.grn }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#1B5E20"; e.currentTarget.style.borderColor = "#1B5E20"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = C.grn; e.currentTarget.style.borderColor = C.grn; }}
                    >
                      <span style={{ fontSize: 12 }}>✓</span>
                      <span>Connected</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Load More ── */}
        {!noMoreResults && results.length >= 50 && (
          <div style={{ textAlign: "center", marginTop: 8, marginBottom: 4 }}>
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              style={{ ...btn2, fontSize: 12, padding: "8px 24px", color: C.blu, borderColor: C.blu, opacity: loadingMore ? 0.6 : 1 }}
            >
              {loadingMore ? "Loading…" : `Load More (${total && total > results.length ? `${results.length} of ${total}` : results.length} shown)`}
            </button>
          </div>
        )}

        {/* ── Call Log ── */}
        {calls.length > 0 && (
          <div style={{ ...card, marginTop: 12, background: "#F0FDF4", border: `1px solid #BBF7D0`, padding: "14px 20px" }}>
            <h3 style={{ fontFamily: FS, fontSize: 15, margin: "0 0 10px", color: C.grn, letterSpacing: -0.3 }}>
              Today's Calls <span style={{ fontWeight: 400, fontSize: 13, color: C.grn }}>({calls.length})</span>
            </h3>
            {calls.map((cl, i) => (
              <HoverCard key={i} rows={[
                { label: "Contact", value: cl.contactName },
                { label: "Type", value: cl.type === "connected" ? "Connected" : "Attempt", color: cl.type === "connected" ? C.grn : C.amb },
                ...(cl.notes ? [{ label: "Notes", value: cl.notes }] : []),
                ...(cl.createdAt ? [{ label: "Time", value: new Date(cl.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) }] : []),
              ]}>
                <div style={{ fontSize: 13, padding: "3px 0", color: "#065F46", display: "flex", gap: 8, cursor: "default", alignItems: "center" }}>
                  <span>{cl.type === "connected" ? "✓" : "📞"}</span>
                  <span style={{ fontWeight: 600 }}>{cl.contactName}</span>
                  <span style={{ color: C.grn, opacity: 0.7 }}>— {cl.type}</span>
                  {cl.createdAt && <span style={{ color: C.grn, opacity: 0.6, marginLeft: "auto", fontSize: 11 }}>{new Date(cl.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })}</span>}
                </div>
              </HoverCard>
            ))}
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={onSwitchToTasks} style={{ ...btn2, flex: 1, fontWeight: 600 }}>✅ Switch to Tasks</button>
          <button onClick={onBackToSchedule} style={{ ...btn2, flex: 1, color: C.mut }}>← Schedule</button>
        </div>
      </div>
    </>
  );
}
