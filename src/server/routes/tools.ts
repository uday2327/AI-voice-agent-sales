import { Router } from "express";
import { bookMeeting } from "../tools/bookMeeting.js";
import { checkCalendarAvailability } from "../tools/checkCalendarAvailability.js";
import { classifyLeadOutcome } from "../tools/classifyLeadOutcome.js";
import { getAllLeads, getLeadContext } from "../tools/getLeadContext.js";
import { saveCallSummary } from "../tools/saveCallSummary.js";

export const toolsRouter = Router();

toolsRouter.get("/leads", async (_req, res, next) => {
  try {
    res.json({ leads: await getAllLeads() });
  } catch (error) {
    next(error);
  }
});

toolsRouter.get("/leads/:leadId", async (req, res, next) => {
  try {
    res.json({ lead: await getLeadContext(req.params.leadId) });
  } catch (error) {
    next(error);
  }
});

toolsRouter.get("/calendar/availability", async (req, res, next) => {
  try {
    const preferredDate =
      typeof req.query.preferredDate === "string"
        ? req.query.preferredDate
        : undefined;

    res.json({
      slots: await checkCalendarAvailability(preferredDate),
    });
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/meetings", async (req, res, next) => {
  try {
    const { leadId, slotId, notes } = req.body as {
      leadId?: string;
      slotId?: string;
      notes?: string;
    };

    if (!leadId || !slotId) {
      res.status(400).json({ error: "leadId and slotId are required" });
      return;
    }

    res.status(201).json({
      meeting: await bookMeeting(leadId, slotId, notes),
    });
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/call-summaries", async (req, res, next) => {
  try {
    res.status(201).json(await saveCallSummary(req.body));
  } catch (error) {
    next(error);
  }
});

toolsRouter.post("/lead-outcomes/classify", (req, res, next) => {
  try {
    const { transcript, summary } = req.body as {
      transcript?: string;
      summary?: Parameters<typeof classifyLeadOutcome>[1];
    };

    res.json({
      classification: classifyLeadOutcome(transcript, summary),
    });
  } catch (error) {
    next(error);
  }
});
