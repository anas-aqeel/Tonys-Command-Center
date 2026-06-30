import { Router, type IRouter } from "express";
import { eq, desc, lt } from "drizzle-orm";
import { z } from "zod";
import { personalDb, checkinsTable } from "@workspace/db";
import { SaveCheckinBody } from "@workspace/api-zod";
import { todayPacific } from "../../lib/dates.js";
import { upsertSheetRow } from "../../lib/google-sheets.js";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const TONY_PERSONAL_DOC = `
WHO I AM — CORE IDENTITY
I am a disciple of Jesus Christ first. My faith is the foundation of everything. My purpose is not success — it is obedience. Success follows obedience. Not the other way around.

I am a husband to Stephanie. I am a father to our children. I am a provider, protector, and leader of my household. Business is the vehicle, not the destination.

THE MISSION
Build a real estate investment company that generates freedom — financial, time, and impact — so I can lead my family, serve my community, and operate from a position of strength, not desperation.

The three non-negotiables every single day:
1. BIBLE — The anchor. Without this, everything else drifts. No compromise.
2. WORKOUT — The body is the machine. You don't maintain a machine, it breaks. Period.
3. JOURNAL — The mind must process. What isn't written is forgotten. What isn't examined is repeated.

These aren't optional. These are the system. If I skip these, I am not operating. I am drifting.

THE AWARENESS LOOP TRAP
Here is the lie I tell myself: "I'm preparing. I'm getting ready. I'm learning." But preparation without action is a disguise for avoidance. I have studied enough. I know enough. The only thing left is execution.

The awareness loop is when I gain insight, feel the weight of it, and then do nothing. I am aware. I am convicted. And then I go back to the same patterns. That is not growth. That is entertainment. This stops now.

EGO OVER OBEDIENCE
The second trap: pride. I want to look productive. I want to feel in control. But control is an illusion, and productivity without obedience is vanity.

Obedience to God. Obedience to the plan. Obedience to the standard I've set for myself. Not performance. Not image. Obedience.

WHAT GOES ON TOP
The morning rituals — Bible, workout, journal — go on top. Not after email. Not after calls. Not after I feel ready. Before anything. These are the non-negotiables that protect everything else.

If I compromise the top, everything underneath degrades. The deals suffer. The relationships suffer. My mind suffers. There is no "I'll do it later today." Later is a lie I tell myself when I want to skip.

THE COMMITMENTS
- I will not touch my phone for business before completing the morning three.
- I will protect my mornings like they are the most important asset I have — because they are.
- I will execute, not plan. Ship, not prepare.
- I will lead from strength, not panic.
- I will trust the system, not my feelings.
- Obedience comes before comfort. Every. Single. Time.

THE STANDARD
This is the bar. Not what I hope to do someday. What I do every day. No exceptions. No renegotiation. No "just this once."

If I'm not living this, I'm not leading. If I'm not leading myself, I cannot lead my family, my team, or my clients. Everything flows from this.
`;


const CHECKIN_SHEET_ID = process.env.CHECKIN_SHEET_ID || "";

const router: IRouter = Router();

router.get("/checkin/today", async (req, res): Promise<void> => {
  const today = todayPacific();
  const [checkin] = await personalDb
    .select()
    .from(checkinsTable)
    .where(eq(checkinsTable.date, today));

  if (!checkin) {
    res.json({ id: null, date: today, bedtime: null, waketime: null, sleepHours: null, bible: false, workout: false, journal: false, nutrition: "Good", unplug: false, done: false });
    return;
  }

  res.json({ ...checkin, done: true });
});

router.post("/checkin", async (req, res): Promise<void> => {
  const parsed = SaveCheckinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const today = todayPacific();
  const data = parsed.data;

  // Use ON CONFLICT DO UPDATE to avoid select-then-insert race condition
  const [checkin] = await personalDb
    .insert(checkinsTable)
    .values({
      date: today,
      bedtime: data.bedtime ?? undefined,
      waketime: data.waketime ?? undefined,
      sleepHours: data.sleepHours ?? undefined,
      bible: data.bible ?? false,
      workout: data.workout ?? false,
      journal: data.journal ?? false,
      nutrition: data.nutrition ?? "Good",
      unplug: data.unplug ?? false,
    })
    .onConflictDoUpdate({
      target: checkinsTable.date,
      set: {
        bedtime: data.bedtime ?? undefined,
        waketime: data.waketime ?? undefined,
        sleepHours: data.sleepHours ?? undefined,
        bible: data.bible ?? undefined,
        workout: data.workout ?? undefined,
        journal: data.journal ?? undefined,
        nutrition: data.nutrition ?? undefined,
        unplug: data.unplug ?? undefined,
      },
    })
    .returning();

  // Pattern analysis: look at last 7 check-ins
  const recent = await personalDb
    .select()
    .from(checkinsTable)
    .where(lt(checkinsTable.date, today))
    .orderBy(desc(checkinsTable.date))
    .limit(7);

  const alerts: { type: string; message: string; level: "high" | "mid" | "low" }[] = [];

  if (recent.length >= 3) {
    const sleepValues = recent
      .map(r => parseFloat(r.sleepHours ?? "0"))
      .filter(v => v > 0);
    if (sleepValues.length >= 3) {
      const avgSleep = sleepValues.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
      if (avgSleep < 6) {
        alerts.push({ type: "sleep", message: `Avg sleep this week: ${avgSleep.toFixed(1)}h — You're running a sleep debt. Performance will drop.`, level: "high" });
      }
    }

    const noWorkout = recent.slice(0, 3).filter(r => !r.workout).length;
    if (noWorkout >= 3) {
      alerts.push({ type: "workout", message: `Missed workout 3 days in a row. Body and mind need this — get back on it.`, level: "mid" });
    }

    const noBible = recent.slice(0, 3).filter(r => !r.bible).length;
    if (noBible >= 2) {
      alerts.push({ type: "bible", message: `No Bible time ${noBible} days straight. This is your anchor. Don't drift.`, level: "mid" });
    }

    const badNut = recent.slice(0, 4).filter(r => r.nutrition === "Bad").length;
    if (badNut >= 3) {
      alerts.push({ type: "nutrition", message: `Poor nutrition ${badNut} of last 4 days. Fuel matters for focus and deals.`, level: "mid" });
    }

    const noUnplug = recent.slice(0, 3).filter(r => !r.unplug).length;
    if (noUnplug >= 3) {
      alerts.push({ type: "unplug", message: `Didn't unplug at 6PM for 3 days straight. Recovery is part of performance.`, level: "low" });
    }

    // Bedtime after 11 PM pattern check (within recent block so we have history)
    if (data.bedtime) {
      const [hStr] = data.bedtime.split(":");
      const h = parseInt(hStr ?? "0", 10);
      const isTonightLate = h >= 23 || (h >= 0 && h < 6);
      if (isTonightLate) {
        const lateBedtimes = recent.slice(0, 3).filter(r => {
          if (!r.bedtime) return false;
          const [rh] = r.bedtime.split(":");
          const rHour = parseInt(rh ?? "0", 10);
          return rHour >= 23 || (rHour >= 0 && rHour < 6);
        });
        if (lateBedtimes.length >= 2) {
          alerts.push({ type: "bedtime", message: `Going to bed after 11 PM ${lateBedtimes.length + 1} nights in a row. Your sleep window is shrinking — protect your recovery.`, level: "mid" });
        } else {
          alerts.push({ type: "bedtime", message: `You went to bed after 11 PM tonight. Consistent late nights will erode your performance.`, level: "low" });
        }
      }
    }
  }

  // Upsert to personal check-in Google Sheet (find by date, update or append)
  const alertSummary = alerts.length > 0 ? alerts.map(a => a.message).join(" | ") : "";
  if (CHECKIN_SHEET_ID) upsertSheetRow(CHECKIN_SHEET_ID, "Daily Check-in", checkin.date, [
    checkin.date,
    checkin.bedtime ?? "",
    checkin.waketime ?? "",
    checkin.sleepHours ?? "",
    checkin.bible ? "Yes" : "No",
    checkin.workout ? "Yes" : "No",
    checkin.journal ? "Yes" : "No",
    checkin.nutrition ?? "Good",
    checkin.unplug ? "Yes" : "No",
    alertSummary,
    "", // Spiritual Anchor — filled separately via /brief/spiritual-anchor
    "",  // notes — column not in schema; placeholder to keep sheet shape stable
  ]).then(rowNum => {
    // Save sheet row number to DB for reference
    personalDb.update(checkinsTable).set({ sheetRowNumber: rowNum } as any).where(eq(checkinsTable.date, today)).catch(() => {});
  }).catch(err => req.log.warn({ err }, "[checkin] Sheet upsert failed (non-fatal)"));

  res.json({ ...checkin, done: true, patternAlerts: alerts });
});

const GuiltTripBody = z.object({
  missingWorkout: z.boolean().optional().default(false),
  missingJournal: z.boolean().optional().default(false),
});

router.post("/checkin/guilt-trip", async (req, res): Promise<void> => {
  const parsed = GuiltTripBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { missingWorkout, missingJournal } = parsed.data;

  if (!missingWorkout && !missingJournal) {
    res.json({ message: "" });
    return;
  }

  const missingBoth = !!missingWorkout && !!missingJournal;
  const missingList = [
    missingWorkout && "workout",
    missingJournal && "journal",
  ].filter(Boolean).join(" and ");

  try {
    let message = "";

    // Flag-gated: AGENT_RUNTIME_CHECKIN=true routes through runtime;
    // default false keeps legacy inline prompt + hardcoded TONY_PERSONAL_DOC.
    if (isAgentRuntimeEnabled("checkin")) {
      const userMessage = `Tony is about to start his day. He has NOT done his ${missingList}. ${
        missingBoth ? "He is skipping BOTH. This is serious. Go harder." : "He is skipping one habit. Be direct but focused."
      } Generate the guilt trip using his own words.`;

      const result = await runAgent("checkin", "accountability", {
        userMessage,
        caller: "direct",
        meta: { missingList, missingBoth },
      });
      message = result.text;
    } else {
      const response = await createTrackedMessage("checkin_accountability", {
        model: "claude-haiku-4-5",
        max_tokens: 8192,
        system: `You are Tony's personal accountability system. You have access to his entire personal document — his own words, his own commitments, his own warnings to himself. Your job is to reflect his words back at him when he tries to skip what he committed to.

Here is Tony's personal document — his own words:

${TONY_PERSONAL_DOC}

INSTRUCTIONS:
- Tony is trying to start his day without completing: ${missingList}.
- ${missingBoth ? "He is skipping BOTH. This is serious. Go harder." : "He is skipping one habit. Be direct but focused."}
- Pull SPECIFIC phrases and sentences from his document VERBATIM. Quote him to himself.
- Call out the "awareness loop" — he's aware this matters but choosing not to act.
- Reference "ego over obedience" — is he choosing comfort over the standard he set?
- Reference "what goes on top" — these go BEFORE everything else, not after.
- Close with one of his specific commitments from the document.
- Keep it under 150 words. No fluff. No generic motivation. His words, his standard, his choice.
- Do NOT use bullet points or lists. Write it as a direct, confrontational paragraph.
- Speak directly to him as "you" — like a coach who knows him deeply.`,
        messages: [
          {
            role: "user",
            content: `Tony is about to start his day. He has NOT done his ${missingList}. Generate the guilt trip using his own words.`,
          },
        ],
      });

      const block = response.content[0];
      message = block.type === "text" ? block.text : "";
    }

    res.json({ message });
  } catch (err) {
    req.log.error({ err }, "[checkin] Guilt trip generation failed");
    res.status(500).json({ message: "Failed to generate accountability check." });
  }
});

export default router;
