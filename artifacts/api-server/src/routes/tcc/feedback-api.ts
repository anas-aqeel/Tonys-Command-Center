// POST /api/feedback — universal feedback capture endpoint.
// FE/UI handlers and backend handlers can call this to log a feedback row
// (alternative to importing recordFeedback() directly).

import { Router, type IRouter } from "express";
import { z } from "zod";
import { recordFeedback } from "../../agents/feedback.js";
import { isFeedbackPipelineEnabled } from "../../agents/flags.js";

const router: IRouter = Router();

const FeedbackBody = z.object({
  agent: z.string().min(1),
  skill: z.string().min(1),
  source_type: z.enum(["thumbs", "reorder", "override", "correction", "rating", "free_text", "escalate"]),
  source_id: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(-1), z.null()]).optional(),
  review_text: z.string().nullable().optional(),
  context_snapshot: z.record(z.string(), z.unknown()).default({}),
});

router.post("/feedback", async (req, res): Promise<void> => {
  const parsed = FeedbackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.message });
    return;
  }

  const result = await recordFeedback({
    agent: parsed.data.agent,
    skill: parsed.data.skill,
    sourceType: parsed.data.source_type,
    sourceId: parsed.data.source_id,
    rating: parsed.data.rating ?? null,
    reviewText: parsed.data.review_text ?? null,
    contextSnapshot: parsed.data.context_snapshot,
  });

  if (!result.recorded) {
    // Pipeline disabled is not an error — handler still gets ok:true.
    res.json({ ok: true, recorded: false, reason: "pipeline_disabled" });
    return;
  }

  res.json({ ok: true, recorded: true, feedback_id: result.feedbackId });
});

router.get("/feedback/health", (_req, res): void => {
  res.json({ ok: true, pipeline_enabled: isFeedbackPipelineEnabled() });
});

export default router;
