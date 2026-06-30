import { Router, type IRouter } from "express";
import { sharedDb, contactsTable, contactNotesTable, callLogTable } from "@workspace/db";
import { communicationLogTable } from "../../lib/schema-v2";
import { eq, ilike, or, and, sql, desc, inArray } from "drizzle-orm";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { syncContactsTab } from "./sheets-sync";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const router: IRouter = Router();

// DISABLED — unidirectional push overwrote Tony's Sheet. Webhook-based bidirectional sync coming later.
function triggerContactSync() { /* no-op */ }
void syncContactsTab;

router.get("/contacts", async (req, res): Promise<void> => {
  const { status, stage, type, category, search, limit = "50", offset = "0" } = req.query as Record<string, string>;
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;

  const conditions: import("drizzle-orm").SQL[] = [];

  // Multi-select filter support (Tony's 2026-05-16 ask). Each filter accepts
  // either a single value ("Hot") or a comma-separated list ("Hot,Warm"). Empty
  // / "All" / missing → no filter on that field.
  const splitCSV = (v: string | undefined): string[] => {
    if (!v || v === "All") return [];
    return v.split(",").map(s => s.trim()).filter(s => s && s !== "All");
  };
  const applyMulti = (col: import("drizzle-orm").AnyColumn, values: string[]) => {
    if (values.length === 0) return;
    if (values.length === 1) conditions.push(eq(col, values[0]));
    else conditions.push(inArray(col, values));
  };

  applyMulti(contactsTable.status,        splitCSV(status));
  applyMulti(contactsTable.pipelineStage, splitCSV(stage));
  applyMulti(contactsTable.type,          splitCSV(type));
  applyMulti(contactsTable.category,      splitCSV(category));

  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push(
      or(
        ilike(contactsTable.name, q),
        ilike(contactsTable.company, q),
        ilike(contactsTable.phone, q),
        ilike(contactsTable.email, q),
        ilike(contactsTable.title, q),
      )!
    );
  }

  const where = conditions.length === 1 ? conditions[0]
    : conditions.length > 1 ? and(...conditions)
    : undefined;

  const contacts = await sharedDb
    .select()
    .from(contactsTable)
    .where(where)
    .orderBy(
      sql`CASE status WHEN 'Hot' THEN 0 WHEN 'Warm' THEN 1 WHEN 'New' THEN 2 ELSE 3 END`,
      sql`CASE pipeline_stage WHEN 'Demo Scheduled' THEN 0 WHEN 'Negotiation' THEN 1 WHEN 'Proposal Sent' THEN 2 WHEN 'Qualified' THEN 3 WHEN 'Lead' THEN 4 ELSE 5 END`,
      contactsTable.name
    )
    .limit(lim)
    .offset(off);

  const countResult = await sharedDb
    .select({ count: sql<number>`COUNT(*)` })
    .from(contactsTable)
    .where(where);

  res.json({
    contacts,
    total: Number(countResult[0]?.count ?? 0),
    limit: lim,
    offset: off,
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/contacts/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) { res.status(404).json({ error: "Not found" }); return; }
  const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, id)).limit(1);
  if (!contact) { res.status(404).json({ error: "Not found" }); return; }

  const [notes, recentCalls, comms] = await Promise.all([
    sharedDb.select().from(contactNotesTable).where(eq(contactNotesTable.contactId, id)).orderBy(desc(contactNotesTable.createdAt)).limit(50),
    sharedDb.select().from(callLogTable).where(eq(callLogTable.contactId, id)).orderBy(desc(callLogTable.createdAt)).limit(20),
    sharedDb.select().from(communicationLogTable).where(eq(communicationLogTable.contactId, id)).orderBy(desc(communicationLogTable.loggedAt)).limit(30),
  ]);

  res.json({ ...contact, _notes: notes, _calls: recentCalls, _comms: comms });
});

router.post("/contacts", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (!body.name || typeof body.name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [contact] = await sharedDb.insert(contactsTable).values({
    name: String(body.name),
    company: body.company ? String(body.company) : undefined,
    status: body.status ? String(body.status) : "New",
    phone: body.phone ? String(body.phone) : undefined,
    email: body.email ? String(body.email) : undefined,
    type: body.type ? String(body.type) : undefined,
    category: body.category ? String(body.category) : undefined,
    title: body.title ? String(body.title) : undefined,
    nextStep: body.nextStep ? String(body.nextStep) : undefined,
    notes: body.notes ? String(body.notes) : undefined,
    source: body.source ? String(body.source) : undefined,
    pipelineStage: body.pipelineStage ? String(body.pipelineStage) : "Lead",
    dealValue: body.dealValue ? String(body.dealValue) : undefined,
    leadSource: body.leadSource ? String(body.leadSource) : undefined,
    linkedinUrl: body.linkedinUrl ? String(body.linkedinUrl) : undefined,
    website: body.website ? String(body.website) : undefined,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    followUpDate: body.followUpDate ? String(body.followUpDate) : undefined,
    expectedCloseDate: body.expectedCloseDate ? String(body.expectedCloseDate) : undefined,
    dealProbability: body.dealProbability ? Number(body.dealProbability) : undefined,
    painPoints: body.painPoints ? String(body.painPoints) : undefined,
  }).returning();

  triggerContactSync();
  res.status(201).json(contact);
});

router.patch("/contacts/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const [current] = await sharedDb.select({ status: contactsTable.status, pipelineStage: contactsTable.pipelineStage })
    .from(contactsTable).where(eq(contactsTable.id, id)).limit(1);
  if (!current) { res.status(404).json({ error: "Not found" }); return; }

  const updateFields: Partial<typeof contactsTable.$inferInsert> = {};
  if ("name" in body) updateFields.name = String(body.name);
  if ("company" in body) updateFields.company = body.company ? String(body.company) : null;
  if ("status" in body) updateFields.status = body.status ? String(body.status) : "New";
  if ("phone" in body) updateFields.phone = body.phone ? String(body.phone) : null;
  if ("email" in body) updateFields.email = body.email ? String(body.email) : null;
  if ("type" in body) updateFields.type = body.type ? String(body.type) : null;
  if ("category" in body) updateFields.category = body.category ? String(body.category) : null;
  if ("title" in body) updateFields.title = body.title ? String(body.title) : null;
  if ("nextStep" in body) updateFields.nextStep = body.nextStep ? String(body.nextStep) : null;
  if ("lastContactDate" in body) updateFields.lastContactDate = body.lastContactDate ? String(body.lastContactDate) : null;
  if ("notes" in body) updateFields.notes = body.notes ? String(body.notes) : null;
  if ("source" in body) updateFields.source = body.source ? String(body.source) : null;
  if ("pipelineStage" in body) updateFields.pipelineStage = body.pipelineStage ? String(body.pipelineStage) : "Lead";
  if ("dealValue" in body) updateFields.dealValue = body.dealValue != null ? String(body.dealValue) : null;
  if ("leadSource" in body) updateFields.leadSource = body.leadSource ? String(body.leadSource) : null;
  if ("linkedinUrl" in body) updateFields.linkedinUrl = body.linkedinUrl ? String(body.linkedinUrl) : null;
  if ("website" in body) updateFields.website = body.website ? String(body.website) : null;
  if ("tags" in body) updateFields.tags = Array.isArray(body.tags) ? body.tags as string[] : null;
  if ("followUpDate" in body) updateFields.followUpDate = body.followUpDate ? String(body.followUpDate) : null;
  if ("expectedCloseDate" in body) updateFields.expectedCloseDate = body.expectedCloseDate ? String(body.expectedCloseDate) : null;
  if ("dealProbability" in body) updateFields.dealProbability = body.dealProbability != null ? Number(body.dealProbability) : null;
  if ("painPoints" in body) updateFields.painPoints = body.painPoints ? String(body.painPoints) : null;
  if ("links" in body) {
    // Links JSONB array of { url, label?, createdAt }. Best-effort validate:
    // accept arrays only; each entry must have a url that starts with http(s).
    const arr = Array.isArray(body.links) ? body.links : [];
    const cleaned = arr
      .filter((l: unknown): l is { url: string } =>
        !!l && typeof l === "object" && typeof (l as { url?: unknown }).url === "string" && /^https?:\/\//i.test((l as { url: string }).url))
      .map((l: { url: string; label?: unknown; createdAt?: unknown }) => ({
        url: l.url,
        ...(typeof l.label === "string" && l.label.trim() ? { label: l.label.trim() } : {}),
        createdAt: typeof l.createdAt === "string" ? l.createdAt : new Date().toISOString(),
      }));
    updateFields.links = cleaned;
  }
  updateFields.updatedAt = new Date();

  const [updated] = await sharedDb.update(contactsTable).set(updateFields).where(eq(contactsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }

  const activityNotes: { contactId: string; text: string; kind: string }[] = [];
  if ("status" in body && updateFields.status && updateFields.status !== current.status) {
    activityNotes.push({ contactId: id, text: `Status changed: ${current.status ?? "—"} → ${updateFields.status}`, kind: "status_change" });
  }
  if ("pipelineStage" in body && updateFields.pipelineStage && updateFields.pipelineStage !== current.pipelineStage) {
    activityNotes.push({ contactId: id, text: `Stage moved: ${current.pipelineStage ?? "—"} → ${updateFields.pipelineStage}`, kind: "stage_change" });
  }
  if (activityNotes.length > 0) {
    await sharedDb.insert(contactNotesTable).values(activityNotes).catch(() => {});
  }

  triggerContactSync();
  res.json(updated);
});

router.delete("/contacts/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  const [deleted] = await sharedDb.delete(contactsTable).where(eq(contactsTable.id, id)).returning({ id: contactsTable.id });
  if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
  triggerContactSync();
  res.json({ ok: true, id: deleted.id });
});

router.get("/contacts/:id/notes", async (req, res): Promise<void> => {
  const { id } = req.params;
  const notes = await sharedDb.select().from(contactNotesTable).where(eq(contactNotesTable.contactId, id)).orderBy(desc(contactNotesTable.createdAt)).limit(100);
  res.json(notes);
});

router.post("/contacts/:id/notes", async (req, res): Promise<void> => {
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const [note] = await sharedDb.insert(contactNotesTable).values({
    contactId: id,
    text: body.text.trim(),
  }).returning();

  triggerContactSync();
  res.status(201).json(note);
});

// ─── GET /contacts/:id/draft — load most recent unsent follow-up draft ────
router.get("/contacts/:id/draft", async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    // Find the most recent call with a draft that hasn't been sent
    const [call] = await sharedDb.select({ followUpText: callLogTable.followUpText, createdAt: callLogTable.createdAt })
      .from(callLogTable)
      .where(and(eq(callLogTable.contactId, id), eq(callLogTable.followUpSent, false), sql`${callLogTable.followUpText} IS NOT NULL`))
      .orderBy(desc(callLogTable.createdAt))
      .limit(1);

    if (!call?.followUpText) { res.json({ draft: null }); return; }

    // Check if draft is newer than last communication
    const [contact] = await sharedDb.select({ lastContactDate: contactsTable.lastContactDate })
      .from(contactsTable).where(eq(contactsTable.id, id)).limit(1);

    if (contact?.lastContactDate && call.createdAt) {
      const draftDate = new Date(call.createdAt);
      const lastCommDate = new Date(contact.lastContactDate + "T23:59:59");
      if (draftDate < lastCommDate) { res.json({ draft: null, reason: "stale" }); return; }
    }

    res.json({ draft: call.followUpText, draftDate: call.createdAt });
  } catch { res.json({ draft: null }); }
});

// ─── POST /contacts/scan-card ─────────────────────────────────────────────
// Accepts a base64 image, uses Claude vision to extract contact details
router.post("/contacts/scan-card", async (req, res): Promise<void> => {
  const { imageBase64, mimeType } = req.body as { imageBase64?: string; mimeType?: string };
  if (!imageBase64) { res.status(400).json({ error: "imageBase64 required" }); return; }

  const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const mt = (mimeType && allowedTypes.includes(mimeType) ? mimeType : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  try {
    let raw = "{}";

    // Image content blocks (vision input) — same shape used in both branches
    const visionContent = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: mt, data: imageBase64 },
      },
      {
        type: "text" as const,
        text: `Extract contact information from this business card image. Return ONLY a JSON object with these fields (omit any field not found):
{"name":"","company":"","title":"","phone":"","email":"","website":"","linkedin":"","notes":""}
Rules: phone in format (xxx) xxx-xxxx if possible, notes = any extra info not in other fields. No markdown, no explanation.`,
      },
    ];

    // Flag-gated: AGENT_RUNTIME_CONTACTS=true routes through runtime.
    if (isAgentRuntimeEnabled("contacts")) {
      const result = await runAgent("contacts", "card-ocr", {
        userMessage: visionContent as any,
        caller: "direct",
        meta: { mimeType: mt },
      });
      raw = result.text.trim() || "{}";
    } else {
      const response = await createTrackedMessage("contact_card_ocr", {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: visionContent }],
      });
      const textBlock = response.content.find(b => b.type === "text");
      raw = textBlock?.type === "text" ? textBlock.text.trim() : "{}";
    }

    let parsed: Record<string, string> = {};
    try {
      // Handle potential markdown code fences
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {};
    }

    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "Business card scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

export default router;
