import { Router, type IRouter } from "express";
import { z } from "zod";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { sharedDb, contactsTable } from "@workspace/db";
import { contactIntelligenceTable } from "../../lib/schema-v2";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const COST_PER_CONTACT = 0.15;

const ResearchBody = z.object({
  contactIds: z.array(z.string().uuid()),
  forceRefresh: z.boolean().optional().default(false),
});

router.post("/contacts/research/check", async (req, res): Promise<void> => {
  const parsed = z.object({ contactIds: z.array(z.string().uuid()) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const results: { contactId: string; name: string; lastResearchDate: string | null; daysOld: number | null; needsRefresh: boolean }[] = [];

  for (const contactId of parsed.data.contactIds) {
    const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
    const [intel] = await sharedDb.select().from(contactIntelligenceTable)
      .where(eq(contactIntelligenceTable.contactId, contactId)).limit(1);

    const lastScan = intel?.lastAiScan;
    let daysOld: number | null = null;
    let needsRefresh = true;

    if (lastScan) {
      daysOld = Math.floor((Date.now() - new Date(lastScan).getTime()) / (1000 * 60 * 60 * 24));
      needsRefresh = daysOld > 7;
    }

    results.push({
      contactId,
      name: contact?.name || "Unknown",
      lastResearchDate: lastScan ? new Date(lastScan).toISOString() : null,
      daysOld,
      needsRefresh,
    });
  }

  const freshCount = results.filter(r => !r.needsRefresh).length;
  const staleCount = results.filter(r => r.needsRefresh).length;
  const estimatedCost = staleCount * COST_PER_CONTACT;

  res.json({
    results,
    freshCount,
    staleCount,
    estimatedCost: `~$${estimatedCost.toFixed(2)}`,
    costPerContact: `~$${COST_PER_CONTACT.toFixed(2)}`,
    message: freshCount > 0
      ? `${freshCount} contact(s) have research less than 7 days old. ${staleCount} need refreshing. Estimated cost: ~$${estimatedCost.toFixed(2)}`
      : `Research ${staleCount} contacts for ~$${estimatedCost.toFixed(2)}?`,
  });
});

router.post("/contacts/research", async (req, res): Promise<void> => {
  const parsed = ResearchBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const results: { contactId: string; ok: boolean; summary?: string; error?: string; skipped?: boolean; daysOld?: number }[] = [];

  for (const contactId of parsed.data.contactIds) {
    try {
      const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
      if (!contact) { results.push({ contactId, ok: false, error: "Contact not found" }); continue; }

      if (!parsed.data.forceRefresh) {
        const [intel] = await sharedDb.select().from(contactIntelligenceTable)
          .where(eq(contactIntelligenceTable.contactId, contactId)).limit(1);
        if (intel?.lastAiScan) {
          const daysOld = Math.floor((Date.now() - new Date(intel.lastAiScan).getTime()) / (1000 * 60 * 60 * 24));
          if (daysOld <= 7) {
            results.push({ contactId, ok: true, skipped: true, daysOld, summary: `Research is ${daysOld} day(s) old. Skipped (use forceRefresh to override).` });
            continue;
          }
        }
      }

      const response = await createTrackedMessage("contact_research", {
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        tools: [{
          type: "web_search_20250305" as any,
          name: "web_search",
          max_uses: 3,
        }],
        messages: [{
          role: "user",
          content: `Research this person for a sales call. Find their LinkedIn profile, company info, recent news or activity, and any personality insights.

Name: ${contact.name}
Company: ${contact.company || "Unknown"}
Email: ${contact.email || "Unknown"}
Phone: ${contact.phone || "Unknown"}
Type: ${contact.type || "Unknown"}

Return your findings in this exact format:
LINKEDIN: [URL or "Not found"]
COMPANY_INFO: [1-2 sentences about their company]
RECENT_NEWS: [Any recent mentions, deals, or activity]
PERSONALITY_NOTES: [Communication style, interests, or approach notes based on their online presence]
COMMUNICATION_STYLE: [Direct/Indirect, Formal/Casual, Data-driven/Relationship-driven]
AI_ASSESSMENT: [One sentence coaching tip for Tony, e.g. "Direct communicator. Don't pitch -- ask questions."]
SOCIAL_PROFILES: [Any other social media URLs found]`,
        }],
      });

      const textBlocks = response.content.filter(b => b.type === "text");
      const researchText = textBlocks.map(b => b.type === "text" ? b.text : "").join("\n");

      const linkedinMatch = researchText.match(/LINKEDIN:\s*(.+)/i);
      const companyMatch = researchText.match(/COMPANY_INFO:\s*(.+)/i);
      const newsMatch = researchText.match(/RECENT_NEWS:\s*(.+)/i);
      const personalityMatch = researchText.match(/PERSONALITY_NOTES:\s*(.+)/i);
      const commStyleMatch = researchText.match(/COMMUNICATION_STYLE:\s*(.+)/i);
      const aiAssessmentMatch = researchText.match(/AI_ASSESSMENT:\s*(.+)/i);
      const socialMatch = researchText.match(/SOCIAL_PROFILES:\s*(.+)/i);

      const linkedinUrl = linkedinMatch?.[1]?.trim();
      const companyInfo = companyMatch?.[1]?.trim();
      const personalityNotes = [
        personalityMatch?.[1]?.trim(),
        commStyleMatch?.[1]?.trim() ? `Communication style: ${commStyleMatch[1].trim()}` : null,
        aiAssessmentMatch?.[1]?.trim() ? `AI tip: ${aiAssessmentMatch[1].trim()}` : null,
      ].filter(Boolean).join("\n");

      const socialProfiles: Record<string, string> = {};
      if (socialMatch?.[1] && socialMatch[1].trim() !== "Not found") {
        socialProfiles.raw = socialMatch[1].trim();
      }
      if (linkedinUrl && linkedinUrl !== "Not found") {
        socialProfiles.linkedin = linkedinUrl;
      }

      const [existing] = await sharedDb.select({ id: contactIntelligenceTable.id })
        .from(contactIntelligenceTable)
        .where(eq(contactIntelligenceTable.contactId, contactId)).limit(1);

      const updates = {
        linkedinUrl: (linkedinUrl && linkedinUrl !== "Not found") ? linkedinUrl : undefined,
        companyInfo: companyInfo ? { summary: companyInfo, news: newsMatch?.[1]?.trim() } : undefined,
        personalityNotes: personalityNotes || undefined,
        socialProfiles: Object.keys(socialProfiles).length > 0 ? socialProfiles : undefined,
        lastAiScan: new Date(),
        updatedAt: new Date(),
      };

      if (existing) {
        await sharedDb.update(contactIntelligenceTable).set(updates)
          .where(eq(contactIntelligenceTable.contactId, contactId));
      } else {
        await sharedDb.insert(contactIntelligenceTable).values({ contactId, ...updates });
      }

      results.push({
        contactId,
        ok: true,
        summary: `LinkedIn: ${linkedinUrl || "N/A"} | Company: ${companyInfo || "N/A"} | Personality: ${personalityNotes || "N/A"}`,
      });
    } catch (err) {
      results.push({ contactId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  res.json({ results });
});

export default router;
