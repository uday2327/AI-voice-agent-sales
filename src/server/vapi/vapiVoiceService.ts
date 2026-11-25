import { VapiClient } from "@vapi-ai/server-sdk";
import {
  runInteractiveLlmTurn,
  startInteractiveLlmCall,
} from "../agent/llmCallOrchestrator.js";
import { agentConfig } from "../config/agent.config.js";
import { getLeadContext } from "../tools/getLeadContext.js";
import type { CallTranscriptEntry } from "../types.js";

const vapiAssistantPrompt =
  "You are Carla, an AI SDR. Follow the backend-provided conversation instructions and use the configured tools. Keep responses concise, natural, and professional.";

let outboundCallsCreated = 0;

const envFlag = (value: string | undefined) => value?.toLowerCase() === "true";

const envNumber = (name: string, fallback: number, max: number) => {
  const parsed = Number(process.env[name] ?? fallback);

  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const requireVapiApiKey = () => {
  const apiKey = process.env.VAPI_API_KEY;

  if (!apiKey || apiKey === "replace_me") {
    throw new Error("VAPI_API_KEY is required for Vapi voice calls.");
  }

  return apiKey;
};

const publicBaseUrl = () =>
  (process.env.VAPI_PUBLIC_BASE_URL?.trim() || "http://localhost:3001").replace(/\/$/, "");

const maxOutboundCalls = () => envNumber("VAPI_MAX_OUTBOUND_CALLS", 2, 10);

const maxCallDurationSeconds = () => envNumber("VAPI_MAX_CALL_DURATION_SECONDS", 300, 900);

const canPlaceOutboundCall = () => envFlag(process.env.VAPI_ALLOW_OUTBOUND_CALLS);

type StartVapiVoiceCallInput = {
  leadId: string;
  customerNumber?: string;
};

type VapiCustomLlmMessage = {
  role?: string;
  content?: string | Array<{ text?: string; type?: string }>;
};

type VapiCustomLlmBody = {
  messages?: VapiCustomLlmMessage[];
  call?: {
    id?: string;
    metadata?: {
      leadId?: string;
    };
    assistantOverrides?: {
      metadata?: {
        leadId?: string;
      };
      variableValues?: {
        leadId?: string;
      };
    };
    variableValues?: {
      leadId?: string;
    };
  };
  metadata?: {
    leadId?: string;
  };
  assistantOverrides?: {
    metadata?: {
      leadId?: string;
    };
    variableValues?: {
      leadId?: string;
    };
  };
};

export const getVapiConfig = () => ({
  enabled: Boolean(process.env.VAPI_API_KEY && process.env.VAPI_API_KEY !== "replace_me"),
  allowOutboundCalls: canPlaceOutboundCall(),
  maxOutboundCalls: maxOutboundCalls(),
  outboundCallsCreated,
  maxCallDurationSeconds: maxCallDurationSeconds(),
  publicBaseUrl: publicBaseUrl(),
  assistantPrompt: vapiAssistantPrompt,
  voiceLayerOnly: true,
});

export const startVapiVoiceCall = async ({
  leadId,
  customerNumber,
}: StartVapiVoiceCallInput) => {
  const lead = await getLeadContext(leadId);
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID || undefined;
  const plannedCall = {
    name: `Carla voice call - ${lead.name}`,
    phoneNumberId: phoneNumberId && phoneNumberId !== "replace_me" ? phoneNumberId : undefined,
    customer: customerNumber
      ? {
          number: customerNumber,
          name: lead.name,
        }
      : undefined,
    assistantId,
    assistantOverrides: assistantId
      ? {
          maxDurationSeconds: maxCallDurationSeconds(),
          serverUrl: `${publicBaseUrl()}/api/vapi/webhook`,
        }
      : undefined,
    metadata: {
      leadId: lead.id,
      source: "ai-sdr",
      backendBrain: true,
      voiceLayerOnly: true,
    },
  };

  if (!canPlaceOutboundCall()) {
    return {
      status: "dry_run",
      reason:
        "VAPI_ALLOW_OUTBOUND_CALLS is not true. No paid Vapi call was created.",
      lead,
      plannedCall,
    };
  }

  requireVapiApiKey();

  if (outboundCallsCreated >= maxOutboundCalls()) {
    throw new Error(
      `Vapi outbound call budget reached for this server process: ${outboundCallsCreated}/${maxOutboundCalls()}.`,
    );
  }

  if (!plannedCall.phoneNumberId) {
    throw new Error("VAPI_PHONE_NUMBER_ID is required when VAPI_ALLOW_OUTBOUND_CALLS=true.");
  }

  if (!plannedCall.assistantId) {
    throw new Error(
      "VAPI_ASSISTANT_ID is required when VAPI_ALLOW_OUTBOUND_CALLS=true. Keep the Vapi assistant prompt minimal and use this backend for agent logic.",
    );
  }

  if (!plannedCall.customer?.number) {
    throw new Error("customerNumber is required when creating a real Vapi outbound call.");
  }

  const vapi = new VapiClient({ token: requireVapiApiKey() });
  const call = await vapi.calls.create(plannedCall as Parameters<typeof vapi.calls.create>[0]);
  outboundCallsCreated += 1;

  return {
    status: "created",
    lead,
    call,
    budget: {
      outboundCallsCreated,
      maxOutboundCalls: maxOutboundCalls(),
      maxCallDurationSeconds: maxCallDurationSeconds(),
    },
  };
};

export const handleVapiWebhook = async (body: unknown) => {
  const message = (body as { message?: { type?: string } })?.message;

  return {
    received: true,
    messageType: message?.type ?? "unknown",
    note:
      "Vapi webhook received. Configure Vapi Custom LLM to POST /api/vapi/chat/completions so Carla's backend remains the agent brain.",
  };
};

export const handleVapiCustomLlmCompletion = async (body: unknown) => {
  const parsedBody = body as VapiCustomLlmBody;
  const leadId =
    parsedBody.call?.metadata?.leadId ??
    parsedBody.metadata?.leadId ??
    parsedBody.call?.assistantOverrides?.metadata?.leadId ??
    parsedBody.call?.assistantOverrides?.variableValues?.leadId ??
    parsedBody.assistantOverrides?.metadata?.leadId ??
    parsedBody.assistantOverrides?.variableValues?.leadId ??
    parsedBody.call?.variableValues?.leadId;

  if (!leadId) {
    throw new Error(
      "Vapi Custom LLM requests must include call.metadata.leadId or metadata.leadId.",
    );
  }

  const lead = await getLeadContext(leadId);
  const messages = parsedBody.messages ?? [];
  const userMessageIndex = messages.findLastIndex((message) => message.role === "user");
  const latestLeadReply =
    userMessageIndex >= 0 ? messageContentToText(messages[userMessageIndex]) : "";
  const callId = parsedBody.call?.id ? `${lead.id}-vapi-${parsedBody.call.id}` : undefined;
  const call = latestLeadReply
    ? await runInteractiveLlmTurn({
        callId,
        leadId,
        transcript: messagesToTranscript(messages.slice(0, userMessageIndex), lead.name),
        leadReply: latestLeadReply,
      })
    : await startInteractiveLlmCall(leadId);
  const reply =
    [...call.transcript].reverse().find((entry) => entry.speaker === "agent")?.message ??
    "Thanks. I will have the sales team follow up with the next best step.";

  return {
    id: `carla-${call.callId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "carla-backend",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    metadata: {
      callId: call.callId,
      leadId: lead.id,
      outcome: call.classification.outcome,
      meetingStatus: call.summary.meetingStatus,
      backendBrain: true,
      voiceLayerOnly: true,
    },
  };
};

const messageContentToText = (message: VapiCustomLlmMessage) => {
  if (typeof message.content === "string") {
    return message.content.trim();
  }

  return (
    message.content
      ?.map((part) => part.text ?? "")
      .join(" ")
      .trim() ?? ""
  );
};

const messagesToTranscript = (
  messages: VapiCustomLlmMessage[],
  leadName: string,
): CallTranscriptEntry[] =>
  messages
    .filter((message) => message.role === "assistant" || message.role === "user")
    .map((message) => ({
      speaker: message.role === "assistant" ? ("agent" as const) : ("lead" as const),
      name: message.role === "assistant" ? agentConfig.name : leadName,
      message: messageContentToText(message),
    }))
    .filter((entry) => entry.message);
