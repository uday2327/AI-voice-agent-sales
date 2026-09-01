import { Router } from "express";
import { runInteractiveLlmTurn } from "../agent/llmCallOrchestrator.js";
import type { CallTranscriptEntry } from "../types.js";
import {
  getVapiConfig,
  handleVapiCustomLlmCompletion,
  handleVapiWebhook,
  startVapiVoiceCall,
} from "../vapi/vapiVoiceService.js";

export const vapiRouter = Router();

vapiRouter.get("/vapi/config", (_req, res) => {
  res.json({ vapi: getVapiConfig() });
});

vapiRouter.post("/vapi/calls", async (req, res, next) => {
  try {
    const { leadId, customerNumber } = req.body as {
      leadId?: string;
      customerNumber?: string;
    };

    if (!leadId) {
      res.status(400).json({ error: "leadId is required" });
      return;
    }

    res.status(201).json({
      vapi: await startVapiVoiceCall({ leadId, customerNumber }),
    });
  } catch (error) {
    next(error);
  }
});

vapiRouter.post("/vapi/webhook", async (req, res, next) => {
  try {
    res.json(await handleVapiWebhook(req.body));
  } catch (error) {
    next(error);
  }
});

vapiRouter.post("/vapi/chat/completions", async (req, res, next) => {
  try {
    res.json(await handleVapiCustomLlmCompletion(req.body));
  } catch (error) {
    next(error);
  }
});

vapiRouter.post("/vapi/turn", async (req, res, next) => {
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

    const call = await runInteractiveLlmTurn({
      callId,
      leadId,
      transcript,
      leadReply: leadReply.trim(),
    });

    res.status(201).json({
      call,
      message: call.transcript[call.transcript.length - 1]?.message,
    });
  } catch (error) {
    next(error);
  }
});
