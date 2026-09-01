import { Router } from "express";
import {
  runInteractiveLlmTurn,
  startInteractiveLlmCall,
} from "../agent/llmCallOrchestrator.js";
import { runCall } from "../calls/callOrchestrator.js";
import { agentConfig } from "../config/agent.config.js";
import type { AgentMode, CallTranscriptEntry } from "../types.js";

export const callsRouter = Router();

callsRouter.get("/agent", (_req, res) => {
  res.json({ agent: agentConfig });
});

callsRouter.post("/calls", async (req, res, next) => {
  try {
    const { leadId, mode } = req.body as {
      leadId?: string;
      mode?: AgentMode;
    };

    if (!leadId) {
      res.status(400).json({ error: "leadId is required" });
      return;
    }

    res.status(201).json({ call: await runCall(leadId, mode) });
  } catch (error) {
    next(error);
  }
});

callsRouter.post("/calls/interactive/start", async (req, res, next) => {
  try {
    const { leadId, mode } = req.body as {
      leadId?: string;
      mode?: AgentMode;
    };

    if (!leadId) {
      res.status(400).json({ error: "leadId is required" });
      return;
    }

    if (mode !== "llm") {
      res.status(400).json({ error: "Interactive Mode requires mode=llm." });
      return;
    }

    res.status(201).json({ call: await startInteractiveLlmCall(leadId) });
  } catch (error) {
    next(error);
  }
});

callsRouter.post("/calls/interactive/turn", async (req, res, next) => {
  try {
    const { callId, leadId, transcript, leadReply } = req.body as {
      callId?: string;
      leadId?: string;
      transcript?: CallTranscriptEntry[];
      leadReply?: string;
    };

    if (!leadId) {
      res.status(400).json({ error: "leadId is required" });
      return;
    }

    if (!Array.isArray(transcript)) {
      res.status(400).json({ error: "transcript is required" });
      return;
    }

    if (!leadReply?.trim()) {
      res.status(400).json({ error: "leadReply is required" });
      return;
    }

    res.status(201).json({
      call: await runInteractiveLlmTurn({
        callId,
        leadId,
        transcript,
        leadReply: leadReply.trim(),
      }),
    });
  } catch (error) {
    next(error);
  }
});
