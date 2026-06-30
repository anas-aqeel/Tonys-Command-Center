// send_eod_report — orchestrator wrapper. Triggers EOD report send.

import type { ToolHandler } from "../index.js";
import { sendAutoEod } from "../../../routes/tcc/eod.js";

const handler: ToolHandler = async () => {
  const result = await sendAutoEod();
  if (result.alreadySent) return `✓ EOD report already sent today — no duplicate sent.`;
  if (!result.ok) return `✗ EOD report failed to generate.`;
  return `✓ EOD report sent!\n- Calls: ${result.callsMade ?? 0}\n- Demos: ${result.demosBooked ?? 0}\n- Tasks completed: ${result.tasksCompleted ?? 0}\n\n${(process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0]}'s summary → ${process.env.TCC_USER_EMAIL || "tony@flipiq.com"}\nAccountability brief → ${process.env.TCC_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com"}`;
};

export default handler;
