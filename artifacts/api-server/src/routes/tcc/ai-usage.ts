import { Router } from "express";
import { personalDb, aiUsageLogsTable } from "@workspace/db";
import { desc, sql, eq, gte, and } from "drizzle-orm";

const router = Router();

// POST /ai-usage/migrate — create table if not exists
router.post("/ai-usage/migrate", async (_req, res) => {
  try {
    await personalDb.execute(sql`CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      timestamp TIMESTAMPTZ DEFAULT now() NOT NULL,
      feature_name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'anthropic',
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      input_cost_usd NUMERIC(10,6),
      output_cost_usd NUMERIC(10,6),
      total_cost_usd NUMERIC(10,6),
      request_summary TEXT,
      response_summary TEXT,
      full_request JSONB,
      full_response JSONB,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      metadata JSONB
    )`);
    await personalDb.execute(sql`CREATE INDEX IF NOT EXISTS idx_aul_timestamp ON ai_usage_logs(timestamp)`);
    await personalDb.execute(sql`CREATE INDEX IF NOT EXISTS idx_aul_feature ON ai_usage_logs(feature_name)`);
    await personalDb.execute(sql`CREATE INDEX IF NOT EXISTS idx_aul_provider ON ai_usage_logs(provider)`);
    await personalDb.execute(sql`CREATE INDEX IF NOT EXISTS idx_aul_model ON ai_usage_logs(model)`);
    res.json({ ok: true, message: "ai_usage_logs table created" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /ai-usage — returns logs + summary
router.get("/ai-usage", async (_req, res) => {
  try {
    const { from, to, feature, model, provider, limit: lim, offset: off } = _req.query;
    const limitN = Math.min(Number(lim) || 100, 500);
    const offsetN = Number(off) || 0;

    // Build conditions
    const conditions: any[] = [];
    if (from) conditions.push(gte(aiUsageLogsTable.timestamp, new Date(from as string)));
    if (to) {
      const toDate = new Date(to as string);
      toDate.setHours(23, 59, 59, 999);
      conditions.push(sql`${aiUsageLogsTable.timestamp} <= ${toDate}`);
    }
    if (feature) conditions.push(eq(aiUsageLogsTable.featureName, feature as string));
    if (model) conditions.push(eq(aiUsageLogsTable.model, model as string));
    if (provider) conditions.push(eq(aiUsageLogsTable.provider, provider as string));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Fetch logs
    const logs = await personalDb
      .select({
        id: aiUsageLogsTable.id,
        timestamp: aiUsageLogsTable.timestamp,
        featureName: aiUsageLogsTable.featureName,
        provider: aiUsageLogsTable.provider,
        model: aiUsageLogsTable.model,
        inputTokens: aiUsageLogsTable.inputTokens,
        outputTokens: aiUsageLogsTable.outputTokens,
        totalTokens: aiUsageLogsTable.totalTokens,
        inputCostUsd: aiUsageLogsTable.inputCostUsd,
        outputCostUsd: aiUsageLogsTable.outputCostUsd,
        totalCostUsd: aiUsageLogsTable.totalCostUsd,
        requestSummary: aiUsageLogsTable.requestSummary,
        responseSummary: aiUsageLogsTable.responseSummary,
        durationMs: aiUsageLogsTable.durationMs,
        status: aiUsageLogsTable.status,
        errorMessage: aiUsageLogsTable.errorMessage,
      })
      .from(aiUsageLogsTable)
      .where(where)
      .orderBy(desc(aiUsageLogsTable.timestamp))
      .limit(limitN)
      .offset(offsetN);

    // Total count
    const [{ count }] = await personalDb
      .select({ count: sql<number>`count(*)::int` })
      .from(aiUsageLogsTable)
      .where(where);

    // Summary aggregations
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [todayAgg] = await personalDb
      .select({ cost: sql<string>`coalesce(sum(total_cost_usd::numeric), 0)::text`, tokens: sql<number>`coalesce(sum(total_tokens), 0)::int`, calls: sql<number>`count(*)::int` })
      .from(aiUsageLogsTable)
      .where(gte(aiUsageLogsTable.timestamp, todayStart));

    const [weekAgg] = await personalDb
      .select({ cost: sql<string>`coalesce(sum(total_cost_usd::numeric), 0)::text`, tokens: sql<number>`coalesce(sum(total_tokens), 0)::int`, calls: sql<number>`count(*)::int` })
      .from(aiUsageLogsTable)
      .where(gte(aiUsageLogsTable.timestamp, weekAgo));

    const [monthAgg] = await personalDb
      .select({ cost: sql<string>`coalesce(sum(total_cost_usd::numeric), 0)::text`, tokens: sql<number>`coalesce(sum(total_tokens), 0)::int`, calls: sql<number>`count(*)::int` })
      .from(aiUsageLogsTable)
      .where(gte(aiUsageLogsTable.timestamp, monthAgo));

    // By feature
    const byFeature = await personalDb
      .select({
        feature: aiUsageLogsTable.featureName,
        cost: sql<string>`coalesce(sum(total_cost_usd::numeric), 0)::text`,
        tokens: sql<number>`coalesce(sum(total_tokens), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(aiUsageLogsTable)
      .where(gte(aiUsageLogsTable.timestamp, monthAgo))
      .groupBy(aiUsageLogsTable.featureName)
      .orderBy(sql`sum(total_cost_usd::numeric) desc`);

    // By model
    const byModel = await personalDb
      .select({
        model: aiUsageLogsTable.model,
        provider: aiUsageLogsTable.provider,
        cost: sql<string>`coalesce(sum(total_cost_usd::numeric), 0)::text`,
        tokens: sql<number>`coalesce(sum(total_tokens), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(aiUsageLogsTable)
      .where(gte(aiUsageLogsTable.timestamp, monthAgo))
      .groupBy(aiUsageLogsTable.model, aiUsageLogsTable.provider)
      .orderBy(sql`sum(total_cost_usd::numeric) desc`);

    // By provider
    const byProvider = await personalDb
      .select({
        provider: aiUsageLogsTable.provider,
        cost: sql<string>`coalesce(sum(total_cost_usd::numeric), 0)::text`,
        tokens: sql<number>`coalesce(sum(total_tokens), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(aiUsageLogsTable)
      .where(gte(aiUsageLogsTable.timestamp, monthAgo))
      .groupBy(aiUsageLogsTable.provider)
      .orderBy(sql`sum(total_cost_usd::numeric) desc`);

    res.json({
      logs,
      summary: {
        today: { cost: parseFloat(todayAgg.cost), tokens: todayAgg.tokens, calls: todayAgg.calls },
        week: { cost: parseFloat(weekAgg.cost), tokens: weekAgg.tokens, calls: weekAgg.calls },
        month: { cost: parseFloat(monthAgg.cost), tokens: monthAgg.tokens, calls: monthAgg.calls },
        byFeature: byFeature.map((r) => ({ ...r, cost: parseFloat(r.cost) })),
        byModel: byModel.map((r) => ({ ...r, cost: parseFloat(r.cost) })),
        byProvider: byProvider.map((r) => ({ ...r, cost: parseFloat(r.cost) })),
      },
      pagination: { total: count, limit: limitN, offset: offsetN },
    });
  } catch (err) {
    console.error("[ai-usage] Error:", err);
    res.status(500).json({ error: "Failed to fetch AI usage data" });
  }
});

// GET /ai-usage/:id — returns full log entry with full request/response
router.get("/ai-usage/:id", async (req, res) => {
  try {
    const [entry] = await personalDb
      .select()
      .from(aiUsageLogsTable)
      .where(eq(aiUsageLogsTable.id, req.params.id))
      .limit(1);

    if (!entry) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(entry);
  } catch (err) {
    console.error("[ai-usage] Error:", err);
    res.status(500).json({ error: "Failed to fetch log entry" });
  }
});

export default router;
