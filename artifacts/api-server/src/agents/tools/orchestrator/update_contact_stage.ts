// update_contact_stage — orchestrator wrapper. Updates/inserts contact pipeline stage.

import type { ToolHandler } from "../index.js";
import { sharedDb } from "@workspace/db";
import { contactIntelligenceTable } from "../../../lib/schema-v2.js";
import { eq } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  const VALID_STAGES = ["new", "outreach", "engaged", "meeting_scheduled", "negotiating", "closed", "dormant"];
  const stage = String(input.stage);
  if (!VALID_STAGES.includes(stage)) return `Invalid stage "${stage}". Valid: ${VALID_STAGES.join(", ")}`;
  try {
    const [existing] = await sharedDb.select().from(contactIntelligenceTable)
      .where(eq(contactIntelligenceTable.contactId, String(input.contact_id))).limit(1);
    if (existing) {
      await sharedDb.update(contactIntelligenceTable)
        .set({ stage, updatedAt: new Date() })
        .where(eq(contactIntelligenceTable.contactId, String(input.contact_id)));
    } else {
      await sharedDb.insert(contactIntelligenceTable).values({ contactId: String(input.contact_id), stage });
    }
    return `✓ Contact stage updated to "${stage}"`;
  } catch (err) {
    return `Stage update failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
