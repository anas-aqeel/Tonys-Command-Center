import { useState, useEffect, useRef, useCallback } from "react";
import { get, post } from "@/lib/api";
import { C, F, FS, card, btn2, TIPS, SC, PIPELINE_STAGES, CONTACT_TYPES, CONTACT_CATEGORIES } from "./constants";
import { SmsModal } from "./SmsModal";
import { ContactDrawer } from "./ContactDrawer";
import { AddContactModal } from "./AddContactModal";
import { HoverCard } from "./HoverCard";
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

const STATUS_OPTIONS = ["All", "Hot", "Warm", "New", "Cold"] as const;

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

const ACTION_PILL: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
  padding: "7px 10px", borderRadius: 8, border: "1px solid transparent",
  fontSize: 11, fontWeight: 600, fontFamily: F, cursor: "pointer",
  transition: "background 0.12s, border-color 0.12s",
  textDecoration: "none", whiteSpace: "nowrap",
  minWidth: 0, flex: "1 1 0",
};

export function SalesView({ contacts: initialContacts, calls, calSide, onAttempt, onConnected, onSwitchToTasks, onBackToSchedule, onCompose, onConnectedCall }: Props) {
  const [smsContact, setSmsContact] = useState<Contact | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [showAddContact, setShowAddContact] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [filterStage, setFilterStage] = useState<string>("All");
  const [filterType, setFilterType] = useState<string>("All");
  const [filterCategory, setFilterCategory] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Contact[]>(initialContacts);
  const [total, setTotal] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMoreResults, setNoMoreResults] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [syncing, setSyncing] = useState<"" | "db">("");
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [briefModal, setBriefModal] = useState<BriefModalData | null>(null);
  const [briefLoading, setBriefLoading] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<BriefChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);

  const hasFilters = !!(search.trim() || filterStatus !== "All" || filterStage !== "All" || filterType !== "All" || filterCategory !== "All");

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
      if (filterStatus !== "All") params.set("status", filterStatus);
      if (filterStage !== "All") params.set("stage", filterStage);
      if (filterType !== "All") params.set("type", filterType);
      if (filterCategory !== "All") params.set("category", filterCategory);
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

  const handlePushToSheets = useCallback(async () => {
    setSyncing("db");
    setSyncToast("Pushing contacts to Google Sheets…");
    try {
      await post<{ ok: boolean; synced: string[] }>("/sheets/sync-master");
      setSyncToast("✓ Pushed to Google Sheets");
    } catch (err) {
      setSyncToast(`✕ Push failed: ${(err as Error).message}`);
    } finally {
      setSyncing("");
      setTimeout(() => setSyncToast(null), 3500);
    }
  }, []);

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
          if (partial.status !== undefined) setFilterStatus(partial.status);
          if (partial.stage !== undefined) setFilterStage(partial.stage);
          if (partial.type !== undefined) setFilterType(partial.type);
          if (partial.category !== undefined) setFilterCategory(partial.category);
          if (partial.search !== undefined) setSearch(partial.search);
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

      {syncToast && (
        <div style={{ position: "fixed", bottom: 20, right: 20, background: syncToast.startsWith("✕") ? C.redBg : syncToast.startsWith("✓") ? "#DCFCE7" : "#FFF7ED", color: syncToast.startsWith("✕") ? C.red : syncToast.startsWith("✓") ? "#065F46" : "#9A3412", padding: "10px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: F, zIndex: 9999, boxShadow: "0 4px 16px rgba(0,0,0,0.15)" }}>
          {syncToast}
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
                onClick={handlePushToSheets}
                disabled={!!syncing}
                title="Push contacts to Google Sheets"
                style={{ padding: "6px 12px", background: "#FAFAF8", color: C.sub, border: `1px solid ${C.brd}`, borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: syncing ? "wait" : "pointer", fontFamily: F, opacity: syncing ? 0.6 : 1 }}
              >
                {syncing === "db" ? "↑ Pushing…" : "↑ Sheets"}
              </button>
              <button
                onClick={() => setShowAddContact(true)}
                style={{ padding: "6px 16px", background: C.tx, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: F }}
              >
                + Add
              </button>
            </div>
          </div>

          {/* ── Filters ── */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            {[
              { value: filterStatus, onChange: setFilterStatus, options: STATUS_OPTIONS.map(s => ({ value: s, label: s === "All" ? "All Statuses" : s })), activeColor: C.red },
              { value: filterStage, onChange: setFilterStage, options: [{ value: "All", label: "All Stages" }, ...PIPELINE_STAGES.map(s => ({ value: s, label: s }))], activeColor: C.blu },
              { value: filterType, onChange: setFilterType, options: [{ value: "All", label: "All Types" }, ...CONTACT_TYPES.map(t => ({ value: t, label: t }))], activeColor: C.amb },
              { value: filterCategory, onChange: setFilterCategory, options: [{ value: "All", label: "All Categories" }, ...CONTACT_CATEGORIES.map(c => ({ value: c, label: c }))], activeColor: "#7B1FA2" },
            ].map((f, i) => (
              <select
                key={i}
                value={f.value}
                onChange={e => f.onChange(e.target.value)}
                style={{
                  padding: "5px 8px", borderRadius: 7,
                  border: `1px solid ${f.value !== "All" ? f.activeColor : C.brd}`,
                  fontSize: 12, fontFamily: F, background: "#FAFAF8",
                  color: f.value !== "All" ? f.activeColor : C.sub,
                  cursor: "pointer", outline: "none",
                  fontWeight: f.value !== "All" ? 700 : 400,
                }}
              >
                {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ))}
            {hasFilters && (
              <button
                onClick={() => { setFilterStatus("All"); setFilterStage("All"); setFilterType("All"); setFilterCategory("All"); setSearch(""); }}
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
              const initials = c.name.split(" ").filter(Boolean).map((n: string) => n[0]).slice(0, 2).join("").toUpperCase();

              return (
                <div
                  key={c.id}
                  style={{
                    display: "flex", flexDirection: "column",
                    background: "#fff", borderRadius: 12,
                    border: `1px solid ${C.brd}`,
                    borderTop: `4px solid ${statusColor}`,
                    overflow: "hidden",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                    transition: "box-shadow 0.15s, transform 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 6px 18px rgba(0,0,0,0.10)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={e => { e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)"; e.currentTarget.style.transform = "translateY(0)"; }}
                >
                  {/* Header: Avatar + Name + Status */}
                  <div
                    onClick={() => setSelectedContactId(String(c.id))}
                    style={{ display: "flex", gap: 12, padding: "14px 14px 8px", cursor: "pointer", alignItems: "center" }}
                  >
                    <div style={{
                      width: 44, height: 44, borderRadius: "50%",
                      background: statusColor, flexShrink: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 14, fontWeight: 800, color: "#fff",
                      letterSpacing: -0.5, userSelect: "none",
                    }}>{initials}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.tx, letterSpacing: -0.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                      {c.company && <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.company}</div>}
                    </div>
                  </div>

                  {/* Badges */}
                  <div onClick={() => setSelectedContactId(String(c.id))} style={{ display: "flex", gap: 5, flexWrap: "wrap", padding: "0 14px 8px", cursor: "pointer" }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: statusColor,
                      background: STATUS_BG[c.status || "New"] || "#F1F5F9",
                      padding: "2px 7px", borderRadius: 10, letterSpacing: 0.3,
                    }}>{c.status || "New"}</span>
                    {c.pipelineStage && (
                      <span style={{ fontSize: 10, color: "#6B5FF8", background: "#F5F3FF", padding: "2px 6px", borderRadius: 5, fontWeight: 500 }}>{c.pipelineStage}</span>
                    )}
                    {c.type && (
                      <span style={{ fontSize: 10, color: C.sub, background: "#F3F4F6", padding: "2px 6px", borderRadius: 5 }}>{c.type}</span>
                    )}
                  </div>

                  {/* Body: next step + meta */}
                  <div onClick={() => setSelectedContactId(String(c.id))} style={{ flex: 1, padding: "0 14px 10px", cursor: "pointer", minHeight: 36 }}>
                    {c.nextStep && (
                      <div style={{ fontSize: 12, color: C.tx, lineHeight: 1.4, marginBottom: 6 }}>
                        → {c.nextStep.length > 80 ? c.nextStep.slice(0, 80) + "…" : c.nextStep}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: C.mut, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      {c.followUpDate && (
                        <span style={{ color: od ? C.red : C.mut, fontWeight: od ? 700 : 400 }}>
                          {od ? "⚠ Overdue" : "📅"} {c.followUpDate}
                        </span>
                      )}
                      {!c.followUpDate && c.lastContactDate && <span>Last: {c.lastContactDate}</span>}
                      {c.phone && <span style={{ fontVariantNumeric: "tabular-nums" }}>{c.phone}</span>}
                    </div>
                    {c.painPoints && (
                      <div style={{ fontSize: 11, color: C.red, fontStyle: "italic", marginTop: 4 }}>
                        ⚠ {c.painPoints.length > 70 ? c.painPoints.slice(0, 70) + "…" : c.painPoints}
                      </div>
                    )}
                  </div>

                  {/* Action buttons (icon + text, wraps onto two rows) */}
                  <div
                    style={{
                      display: "flex", flexWrap: "wrap", gap: 5,
                      padding: "10px 12px", borderTop: `1px solid ${C.brd}`,
                      background: "#FAFAF8",
                    }}
                    onClick={e => e.stopPropagation()}
                  >
                    {c.phone && (
                      <a
                        href={`tel:${c.phone}`}
                        onClick={() => onAttempt({ id: c.id, name: c.name })}
                        title="Call"
                        style={{ ...ACTION_PILL, background: "#F0FDF4", color: C.grn, borderColor: "#BBF7D0" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#DCFCE7")}
                        onMouseLeave={e => (e.currentTarget.style.background = "#F0FDF4")}
                      >
                        <span>📞</span><span>Call</span>
                      </a>
                    )}
                    {c.phone && (
                      <button
                        onClick={() => setSmsContact(c)}
                        title="Text"
                        style={{ ...ACTION_PILL, background: "#EFF6FF", color: C.blu, borderColor: "#BFDBFE" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#DBEAFE")}
                        onMouseLeave={e => (e.currentTarget.style.background = "#EFF6FF")}
                      >
                        <span>💬</span><span>Text</span>
                      </button>
                    )}
                    {onCompose && (
                      <button
                        onClick={() => onCompose(c)}
                        title="Email"
                        style={{ ...ACTION_PILL, background: "#EFF6FF", color: C.blu, borderColor: "#BFDBFE" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#DBEAFE")}
                        onMouseLeave={e => (e.currentTarget.style.background = "#EFF6FF")}
                      >
                        <span>✉️</span><span>Email</span>
                      </button>
                    )}
                    <button
                      onClick={() => handleGetBrief(c)}
                      disabled={briefLoading === String(c.id)}
                      title="Pre-call brief"
                      style={{
                        ...ACTION_PILL,
                        background: "#F5F3FF", color: "#6B5FF8", borderColor: "#DDD6FE",
                        opacity: briefLoading === String(c.id) ? 0.5 : 1,
                        cursor: briefLoading === String(c.id) ? "wait" : "pointer",
                      }}
                      onMouseEnter={e => { if (briefLoading !== String(c.id)) e.currentTarget.style.background = "#EDE9FE"; }}
                      onMouseLeave={e => (e.currentTarget.style.background = "#F5F3FF")}
                    >
                      <span>{briefLoading === String(c.id) ? "⌛" : "📋"}</span>
                      <span>{briefLoading === String(c.id) ? "Loading…" : "Brief"}</span>
                    </button>
                    <button
                      onClick={() => onAttempt({ id: c.id, name: c.name })}
                      title={TIPS.attempt}
                      style={{ ...ACTION_PILL, background: "#FFFBEB", color: "#B45309", borderColor: "#FDE68A" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#FEF3C7")}
                      onMouseLeave={e => (e.currentTarget.style.background = "#FFFBEB")}
                    >
                      <span>📝</span><span>Attempt</span>
                    </button>
                    <button
                      onClick={() => onConnectedCall
                        ? onConnectedCall({ contactId: String(c.id), contactName: c.name, contactEmail: c.email || undefined })
                        : onConnected(c.name)
                      }
                      title="Log connected call"
                      style={{ ...ACTION_PILL, background: "#F0FDF4", color: C.grn, borderColor: "#BBF7D0", fontWeight: 700 }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#DCFCE7")}
                      onMouseLeave={e => (e.currentTarget.style.background = "#F0FDF4")}
                    >
                      <span>✓</span><span>Connected</span>
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
