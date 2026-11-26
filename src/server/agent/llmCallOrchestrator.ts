import OpenAI from "openai";
import { z } from "zod";
import { carlaSystemPrompt } from "./carlaSystemPrompt.js";
import { agentConfig } from "../config/agent.config.js";
import { writeJsonFile } from "../storage/jsonStore.js";
import { bookMeeting } from "../tools/bookMeeting.js";
import { checkCalendarAvailability } from "../tools/checkCalendarAvailability.js";
import { classifyLeadOutcome } from "../tools/classifyLeadOutcome.js";
import { getLeadContext } from "../tools/getLeadContext.js";
import { saveCallSummary } from "../tools/saveCallSummary.js";
import type {
  CalendarSlot,
  CallResult,
  CallStatus,
  CallTranscriptEntry,
  CallSummary,
  CallToolCall,
  Lead,
  LeadIntentDetection,
} from "../types.js";

type CarlaTurn = {
  reply: string;
  detectedPainPoints: string[];
  detectedObjections: string[];
  interestLevel: "high" | "medium" | "low" | "none";
  recommendedToolCall: {
    name:
      | "getLeadContext"
      | "checkCalendarAvailability"
      | "bookMeeting"
      | "saveCallSummary"
      | "classifyLeadOutcome"
      | "none";
    reason: string;
  };
  outcome:
    | "meeting_booked"
    | "interested"
    | "send_follow_up"
    | "call_back_later"
    | "not_interested"
    | "unqualified";
  nextBestAction: string;
};

type LeadScriptTurn = {
  lead: string;
};

type LeadContextForLlm = Omit<Lead, "scenario">;

const carlaTurnSchema = z.object({
  reply: z.string().trim().min(1),
  detectedPainPoints: z.array(z.string()),
  detectedObjections: z.array(z.string()),
  interestLevel: z.enum(["high", "medium", "low", "none"]),
  recommendedToolCall: z.object({
    name: z.enum(["getLeadContext", "checkCalendarAvailability", "bookMeeting", "saveCallSummary", "classifyLeadOutcome", "none"]),
    reason: z.string(),
  }),
  outcome: z.enum(["meeting_booked", "interested", "send_follow_up", "call_back_later", "not_interested", "unqualified"]),
  nextBestAction: z.string(),
});

const leadIntentSchema = z.object({
  leadMessage: z.string(),
  intent: z.enum(["interested", "objection", "send_follow_up", "call_back_later", "not_interested", "unqualified"]),
  objectionType: z.enum(["budget", "timing", "existing_tools", "authority", "fit", "none"]),
  shouldCheckCalendar: z.boolean(),
  shouldBookMeeting: z.boolean(),
  nextAgentMove: z.enum(["ask_discovery", "handle_objection", "offer_meeting", "offer_email", "close"]),
  reasoning: z.string(),
});

const interactiveTurnSchema = z.object({
  carlaTurn: carlaTurnSchema,
  leadIntent: leadIntentSchema,
});

const carlaTurnJsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string" },
    detectedPainPoints: { type: "array", items: { type: "string" } },
    detectedObjections: { type: "array", items: { type: "string" } },
    interestLevel: { type: "string", enum: ["high", "medium", "low", "none"] },
    recommendedToolCall: {
      type: "object",
      properties: {
        name: { type: "string", enum: ["getLeadContext", "checkCalendarAvailability", "bookMeeting", "saveCallSummary", "classifyLeadOutcome", "none"] },
        reason: { type: "string" },
      },
      required: ["name", "reason"],
      additionalProperties: false,
    },
    outcome: { type: "string", enum: ["meeting_booked", "interested", "send_follow_up", "call_back_later", "not_interested", "unqualified"] },
    nextBestAction: { type: "string" },
  },
  required: ["reply", "detectedPainPoints", "detectedObjections", "interestLevel", "recommendedToolCall", "outcome", "nextBestAction"],
  additionalProperties: false,
} as const;

const leadIntentJsonSchema = {
  type: "object",
  properties: {
    leadMessage: { type: "string" },
    intent: { type: "string", enum: ["interested", "objection", "send_follow_up", "call_back_later", "not_interested", "unqualified"] },
    objectionType: { type: "string", enum: ["budget", "timing", "existing_tools", "authority", "fit", "none"] },
    shouldCheckCalendar: { type: "boolean" },
    shouldBookMeeting: { type: "boolean" },
    nextAgentMove: { type: "string", enum: ["ask_discovery", "handle_objection", "offer_meeting", "offer_email", "close"] },
    reasoning: { type: "string" },
  },
  required: ["leadMessage", "intent", "objectionType", "shouldCheckCalendar", "shouldBookMeeting", "nextAgentMove", "reasoning"],
  additionalProperties: false,
} as const;

const interactiveTurnJsonSchema = {
  type: "object",
  properties: {
    carlaTurn: carlaTurnJsonSchema,
    leadIntent: leadIntentJsonSchema,
  },
  required: ["carlaTurn", "leadIntent"],
  additionalProperties: false,
} as const;

const interactiveSystemPrompt = `You are Carla, an AI SDR calling a business lead. Be concise, natural, and ask one question at a time. Qualify the lead and handle objections calmly. Explain only that AI agents can help sales teams with follow-up and prioritization; do not invent pricing, integrations, customer examples, or product guarantees. If asked about price or cost, say you do not have confirmed pricing details and a sales representative can confirm current pricing. Use the full conversation context and address the latest lead message directly. Classify intent only from what the lead said. Check calendar only when the lead explicitly asks to discuss or schedule a meeting. Never book from interest alone; booking is handled by the server only after explicit acceptance of a specific offered slot. Do not invoke functions or tools; the recommendedToolCall field is JSON data for the backend. Return the required structured fields with concise reasoning.`;

const model = () =>
  process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";

const maxOutputTokens = () => {
  const parsed = Number(process.env.MAX_OUTPUT_TOKENS ?? 220);

  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 220;
};

const maxTurns = () => {
  const parsed = Number(process.env.MAX_CALL_TURNS ?? 8);

  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 8;
};

const maxInteractiveLeadTurns = () => {
  const parsed = Number(process.env.MAX_INTERACTIVE_LEAD_TURNS ?? 6);

  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8) : 6;
};

const callId = (leadId: string) =>
  `${leadId}-llm-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;

const interactiveCallId = (leadId: string) =>
  `${leadId}-interactive-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;

const requireApiKey = () => {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || apiKey === "replace_me") {
    throw new Error("GROQ_API_KEY is missing in .env");
  }

  return apiKey;
};

let groqClient: OpenAI | undefined;
const createLlmClient = () => {
  if (groqClient) return groqClient;
  groqClient = new OpenAI({
    apiKey: requireApiKey(),
    baseURL: "https://api.groq.com/openai/v1",
    maxRetries: 0,
    timeout: 25_000,
  });
  return groqClient;
};

const modelError = (error: unknown) => {
  if (error instanceof OpenAI.APIError) {
    const code = typeof error.code === "string" ? ` ${error.code}` : "";
    if (error.status === 401 || error.status === 403) return Object.assign(new Error(`Groq rejected GROQ_API_KEY: ${error.message}`), { status: 502 });
    if (error.status === 429) return Object.assign(new Error(`Groq rate limit reached (429). Wait for the TPM window to reset and try again. ${error.message}`), { status: 429 });
    if (error.status === 400) return Object.assign(new Error(`Groq rejected structured output for model ${model()}${code}: ${error.message}`), { status: 502 });
    return Object.assign(new Error(`Groq API error${error.status ? ` (${error.status})` : ""}${code}: ${error.message}`), { status: 502 });
  }
  return error instanceof Error ? error : new Error("Unexpected Groq request failure.");
};

const jsonValidationFailure = (error: unknown) =>
  error instanceof OpenAI.APIError && error.status === 400 &&
  (error.code === "json_validate_failed" || error.code === "tool_use_failed" || error.code === "output_parse_failed" || /json_validate_failed|output_parse_failed|failed to validate json|parsing failed.*output could not be parsed|tool choice is none.*model called a tool/i.test(error.message));

class InvalidStructuredResponseError extends Error {
  status = 502;
}

const parseStructuredContent = <T>(
  content: string | null | undefined,
  schema: z.ZodType<T>,
  schemaName: string,
): T => {
  if (!content?.trim()) throw new InvalidStructuredResponseError(`Groq returned an empty ${schemaName} response.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InvalidStructuredResponseError(`Groq returned malformed JSON for ${schemaName}.`);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new InvalidStructuredResponseError(`Groq returned a ${schemaName} response that did not match its schema: ${validated.error.issues.map((issue) => issue.path.join(".") || "response").join(", ")}.`);
  }
  return validated.data;
};

const requestCompletion = async <T>(
  client: OpenAI,
  request: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "response_format">,
  schemaName: string,
  schema: typeof carlaTurnJsonSchema | typeof leadIntentJsonSchema | typeof interactiveTurnJsonSchema,
  validator: z.ZodType<T>,
): Promise<T> => {
  const structuredRequest: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    ...request,
    response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await client.chat.completions.create(structuredRequest);
      return parseStructuredContent(response.choices[0]?.message.content, validator, schemaName);
    } catch (error) {
      const canRetry = attempt === 0 && (jsonValidationFailure(error) || error instanceof InvalidStructuredResponseError);
      if (!canRetry) {
        if (error instanceof InvalidStructuredResponseError) throw error;
        throw modelError(error);
      }
      structuredRequest.messages = [
        { role: "system", content: "Retry once. Follow the strict JSON schema exactly; include every required field and enum. Do not invoke functions, tools, or tool calls. Put recommendedToolCall only in the JSON data." },
        ...structuredRequest.messages,
      ];
    }
  }
  throw new InvalidStructuredResponseError(`Groq could not return a valid ${schemaName} response after one retry.`);
};

export const runLlmCall = async (leadId: string): Promise<CallResult> => {
  const lead = await getLeadContext(leadId);
  const client = createLlmClient();
  const id = callId(lead.id);
  const transcript: CallResult["transcript"] = [];
  const statusEvents: CallResult["statusEvents"] = [];
  const toolCalls: CallToolCall[] = [
    {
      name: "getLeadContext",
      input: { leadId },
      output: lead,
    },
  ];
  const painPoints = new Set<string>();
  const objections = new Set<string>();
  const intentDetections: LeadIntentDetection[] = [];
  let interestLevel: CallSummary["interestLevel"] = "low";
  let meetingStatus: CallSummary["meetingStatus"] = "not_booked";
  let bookedSlotId: string | undefined;
  let nextBestAction = "Review the LLM call transcript and choose the next step.";

  const setStatus = (status: CallStatus, label: string) => {
    statusEvents.push({ status, label });
  };

  const agentSays = (message: string) => {
    setStatus("agent_speaking", `${agentConfig.name} speaking`);
    transcript.push({ speaker: "agent", name: agentConfig.name, message });
  };

  const leadSays = (message: string) => {
    setStatus("lead_speaking", `${lead.name} speaking`);
    transcript.push({ speaker: "lead", name: lead.name, message });
  };

  setStatus("thinking", "Loading lead context");
  const leadTurns = leadScriptFor(lead).slice(0, maxTurns());

  setStatus("thinking", "Carla is preparing the opening");
  const openingTurn = await generateCarlaTurn(client, lead, transcript);
  collectSignals(openingTurn, painPoints, objections);
  interestLevel = openingTurn.interestLevel;
  nextBestAction = openingTurn.nextBestAction;
  agentSays(openingTurn.reply);

  for (const leadTurn of leadTurns) {
    leadSays(leadTurn.lead);
    setStatus("thinking", "Reading lead intent");
    const leadIntent = await detectLeadIntent(client, lead, transcript, leadTurn.lead);
    intentDetections.push(leadIntent);

    if (shouldForceScriptedBooking(lead, leadTurn.lead)) {
      setStatus("thinking", "Checking calendar availability");
      const slots = await checkCalendarAvailability();
      toolCalls.push({
        name: "checkCalendarAvailability",
        input: {},
        output: slots,
      });

      const slot = slots[0];
      if (slot) {
        agentSays(`I checked the calendar and have ${formatSlot(slot)} with ${slot.salesRep}. Does that work?`);
        leadSays("Yes, that works. Please send the invite.");
        setStatus("thinking", "Booking meeting");
        const meeting = await bookMeeting(
          lead.id,
          slot.id,
          "Qualified AI scripted call: Sarah asked to book a workflow-focused demo.",
        );
        toolCalls.push({
          name: "bookMeeting",
          input: { leadId: lead.id, slotId: slot.id },
          output: meeting,
        });
        bookedSlotId = meeting.slotId;
        meetingStatus = "booked";
        interestLevel = "high";
        nextBestAction = "Send calendar invite and prepare a workflow-focused demo.";
        agentSays(
          `Perfect, I booked the demo with ${meeting.salesRep}. We will send the invite to ${lead.workEmail}. Thanks ${lead.name}.`,
        );
      } else {
        meetingStatus = "follow_up_needed";
        nextBestAction = `Email available demo times to ${lead.workEmail}.`;
        agentSays(
          `I do not see an open slot in the calendar right now, so I will have the team send available demo times to ${lead.workEmail}.`,
        );
      }
      break;
    }

    setStatus("thinking", "Carla is reasoning from lead response");
    const carlaTurn = await generateCarlaTurn(client, lead, transcript);
    collectSignals(carlaTurn, painPoints, objections);
    interestLevel = carlaTurn.interestLevel;
    nextBestAction = carlaTurn.nextBestAction;
    agentSays(carlaTurn.reply);

    if (leadIntent.shouldCheckCalendar && leadIntent.nextAgentMove === "offer_meeting") {
      setStatus("thinking", "Checking calendar availability");
      const slots = await checkCalendarAvailability();
      toolCalls.push({
        name: "checkCalendarAvailability",
        input: {},
        output: slots,
      });

      const slot = slots[0];
      if (slot) {
        agentSays(`I have ${slot.startsAt} with ${slot.salesRep}. Would that work?`);
        leadSays("Yes, that works.");
        setStatus("thinking", "Booking meeting");
        const meeting = await bookMeeting(
          lead.id,
          slot.id,
          "Qualified LLM call: lead agreed to a meeting.",
        );
        toolCalls.push({
          name: "bookMeeting",
          input: { leadId: lead.id, slotId: slot.id },
          output: meeting,
        });
        bookedSlotId = meeting.slotId;
        meetingStatus = "booked";
        interestLevel = "high";
        nextBestAction = "Send calendar invite and prepare sales rep with call context.";
        agentSays(`Great, I booked it with ${meeting.salesRep}. Thanks ${lead.name}.`);
      } else {
        meetingStatus = "follow_up_needed";
        nextBestAction = "Have sales follow up with available meeting times.";
      }
      break;
    }

    if (leadIntent.intent !== "interested" && leadIntent.nextAgentMove !== "ask_discovery") {
      meetingStatus =
        leadIntent.intent === "not_interested" || leadIntent.intent === "unqualified"
          ? "not_booked"
          : "follow_up_needed";
      nextBestAction = nextBestActionFor(leadIntent);
    }
  }

  const summary: CallSummary = {
    leadId: lead.id,
    leadName: lead.name,
    company: lead.company,
    painPoints: [...painPoints],
    objections: [...objections],
    interestLevel,
    meetingStatus,
    bookedSlotId,
    recommendedNextAction: nextBestAction,
    shortSummaryForSales: shortSummaryFor(lead, interestLevel, meetingStatus, nextBestAction),
  };
  const transcriptText = transcript.map((entry) => entry.message).join("\n");
  const classification = classifyLeadOutcome(transcriptText, summary);

  setStatus("thinking", "Saving call summary");
  const savedSummary = await saveCallSummary(summary);
  toolCalls.push({
    name: "saveCallSummary",
    input: { summary },
    output: { id: savedSummary.id, path: savedSummary.path },
  });

  const result: CallResult = {
    callId: id,
    mode: "llm",
    agent: {
      name: agentConfig.name,
      role: agentConfig.role,
      company: agentConfig.company,
    },
    lead,
    statusEvents: [...statusEvents, { status: "idle", label: "Call ended" }],
    transcript,
    toolCalls,
    intentDetections,
    summary,
    classification,
  };

  await writeJsonFile(result, "logs", "calls", `${id}.json`);

  return result;
};

export const startInteractiveLlmCall = async (leadId: string): Promise<CallResult> => {
  const lead = await getLeadContext(leadId);
  const client = createLlmClient();
  const transcript: CallResult["transcript"] = [];
  const statusEvents: CallResult["statusEvents"] = [{ status: "thinking", label: "Loading lead context" }];
  const toolCalls: CallToolCall[] = [
    {
      name: "getLeadContext",
      input: { leadId },
      output: lead,
    },
  ];

  statusEvents.push({ status: "thinking", label: "Carla is preparing the opening" });
  const openingTurn = await generateCarlaTurn(client, lead, transcript);
  statusEvents.push({ status: "agent_speaking", label: `${agentConfig.name} speaking` });
  transcript.push({ speaker: "agent", name: agentConfig.name, message: openingTurn.reply });

  const result = interactiveCallResult({
    callId: interactiveCallId(lead.id),
    lead,
    transcript,
    toolCalls,
    statusEvents,
    intentDetections: [],
    latestTurn: openingTurn,
  });
  await saveCallSummary(result.summary);
  await writeJsonFile(result, "logs", "calls", `${result.callId}.json`);
  return result;
};

export const runInteractiveLlmTurn = async ({
  callId,
  leadId,
  transcript,
  leadReply,
}: {
  callId?: string;
  leadId: string;
  transcript: CallTranscriptEntry[];
  leadReply: string;
}): Promise<CallResult> => {
  const lead = await getLeadContext(leadId);
  const client = createLlmClient();
  const toolCalls: CallToolCall[] = [];
  const nextTranscript: CallResult["transcript"] = [
    ...transcript,
    { speaker: "lead", name: lead.name, message: leadReply },
  ];
  const statusEvents: CallResult["statusEvents"] = [
    { status: "lead_speaking", label: `${lead.name} speaking` },
    { status: "thinking", label: "Carla is processing the lead response" },
  ];
  if (shouldSendTimeSlotsByEmail(leadReply, transcript)) {
    const intent = ruleIntent(leadReply, "send_follow_up", "offer_email", "Lead explicitly requested follow-up by email.");
    const summary: CallSummary = {
      leadId: lead.id,
      leadName: lead.name,
      company: lead.company,
      painPoints: [],
      objections: [],
      interestLevel: "high",
      meetingStatus: "follow_up_needed",
      recommendedNextAction: `Email available meeting time slots to ${lead.workEmail}.`,
      shortSummaryForSales: `${lead.name} at ${lead.company} wants available meeting time slots sent by email.`,
    };
    const savedSummary = await saveCallSummary(summary);
    toolCalls.push({
      name: "saveCallSummary",
      input: { summary },
      output: { id: savedSummary.id, path: savedSummary.path },
    });
    const message = `Absolutely, ${lead.name}. I will send available meeting time slots to ${lead.workEmail} so you can choose one there. Thanks for your time.`;
    statusEvents.push({ status: "agent_speaking", label: `${agentConfig.name} speaking` });
    nextTranscript.push({ speaker: "agent", name: agentConfig.name, message });

    const result = interactiveCallResult({
      callId: callId ?? interactiveCallId(lead.id),
      lead,
      transcript: nextTranscript,
      toolCalls,
      statusEvents,
      intentDetections: [intent],
      summaryOverride: summary,
      forceFinal: true,
      latestTurn: {
        reply: message,
        detectedPainPoints: [],
        detectedObjections: [],
        interestLevel: "high",
        recommendedToolCall: {
          name: "saveCallSummary",
          reason: "Lead asked to receive available meeting slots by email.",
        },
        outcome: "send_follow_up",
        nextBestAction: `Email available meeting time slots to ${lead.workEmail}.`,
      },
    });

    await writeJsonFile(result, "logs", "calls", `${result.callId}.json`);

    return result;
  }

  const acceptedCalendarOption = acceptedCalendarOptionFromReply(transcript, leadReply);
  if (acceptedCalendarOption) {
    const intent = ruleIntent(leadReply, "interested", "close", "Lead explicitly accepted a specific offered meeting slot.", true);
    statusEvents.push({ status: "thinking", label: "Booking meeting" });
    const slots = await checkCalendarAvailability();
    toolCalls.push({
      name: "checkCalendarAvailability",
      input: {},
      output: slots,
    });
    const slot = slots.find((availableSlot) =>
      offeredSlotMatches(availableSlot, acceptedCalendarOption.details),
    );

    if (slot) {
      const meeting = await bookMeeting(
        lead.id,
        slot.id,
        "Qualified interactive LLM call: lead agreed to an available meeting slot.",
      );
      const summary: CallSummary = {
        leadId: lead.id,
        leadName: lead.name,
        company: lead.company,
        painPoints: [],
        objections: [],
        interestLevel: "high",
        meetingStatus: "booked",
        bookedSlotId: meeting.slotId,
        recommendedNextAction: "Send calendar invite and prepare sales rep with call context.",
        shortSummaryForSales: `${lead.name} at ${lead.company} booked a meeting with ${meeting.salesRep} for ${formatSlot(slot)}.`,
      };
      toolCalls.push({
        name: "bookMeeting",
        input: { leadId: lead.id, slotId: slot.id },
        output: meeting,
      });
      const savedSummary = await saveCallSummary(summary);
      toolCalls.push({
        name: "saveCallSummary",
        input: { summary },
        output: { id: savedSummary.id, path: savedSummary.path },
      });
      const message = `Perfect, I booked ${formatSlot(slot)} with ${slot.salesRep}. Thanks ${lead.name}; we will send the invite to ${lead.workEmail}.`;
      statusEvents.push({ status: "agent_speaking", label: `${agentConfig.name} speaking` });
      nextTranscript.push({ speaker: "agent", name: agentConfig.name, message });

      const result = interactiveCallResult({
        callId: callId ?? interactiveCallId(lead.id),
        lead,
        transcript: nextTranscript,
        toolCalls,
        statusEvents,
        intentDetections: [intent],
        summaryOverride: summary,
        latestTurn: {
          reply: message,
          detectedPainPoints: [],
          detectedObjections: [],
          interestLevel: "high",
          recommendedToolCall: {
            name: "bookMeeting",
            reason: "Lead agreed to a meeting slot.",
          },
          outcome: "meeting_booked",
          nextBestAction: "Send calendar invite and prepare sales rep with call context.",
        },
      });

      await writeJsonFile(result, "logs", "calls", `${result.callId}.json`);

      return result;
    }

    const message = calendarOptionsMessage(slots, isPricingQuestion(leadReply));
    const unavailableIntent = ruleIntent(
      leadReply,
      "interested",
      "offer_meeting",
      "The lead accepted an offered slot, but it is no longer available.",
    );
    statusEvents.push({ status: "agent_speaking", label: `${agentConfig.name} speaking` });
    nextTranscript.push({ speaker: "agent", name: agentConfig.name, message });
    const result = interactiveCallResult({
      callId: callId ?? interactiveCallId(lead.id),
      lead,
      transcript: nextTranscript,
      toolCalls,
      statusEvents,
      intentDetections: [unavailableIntent],
      latestTurn: {
        reply: message,
        detectedPainPoints: [],
        detectedObjections: [],
        interestLevel: "high",
        recommendedToolCall: {
          name: "checkCalendarAvailability",
          reason: "The previously offered time is no longer available.",
        },
        outcome: "interested",
        nextBestAction: "Wait for the lead to choose an available slot.",
      },
    });
    const savedSummary = await saveCallSummary(result.summary);
    toolCalls.push({
      name: "saveCallSummary",
      input: { summary: result.summary },
      output: { id: savedSummary.id, path: savedSummary.path },
    });
    await writeJsonFile(result, "logs", "calls", `${result.callId}.json`);
    return result;
  }

  const { carlaTurn, leadIntent: intent } = await generateInteractiveTurn(client, lead, nextTranscript, leadReply);

  if (shouldOfferCalendarOptions(leadReply, transcript)) {
    statusEvents.push({ status: "thinking", label: "Checking calendar availability" });
    const slots = await checkCalendarAvailability();
    toolCalls.push({
      name: "checkCalendarAvailability",
      input: {},
      output: slots,
    });
    const message = calendarOptionsMessage(slots);
    statusEvents.push({ status: "agent_speaking", label: `${agentConfig.name} speaking` });
    nextTranscript.push({ speaker: "agent", name: agentConfig.name, message });

    const result = interactiveCallResult({
      callId: callId ?? interactiveCallId(lead.id),
      lead,
      transcript: nextTranscript,
      toolCalls,
      statusEvents,
      intentDetections: [intent],
      latestTurn: {
        ...carlaTurn,
        reply: message,
        interestLevel: "high",
        recommendedToolCall: {
          name: "checkCalendarAvailability",
          reason: "Lead asked to book or discuss a meeting.",
        },
        outcome: "interested",
        nextBestAction: "Wait for the lead to choose or confirm one of the offered slots.",
      },
    });

    const savedSummary = await saveCallSummary(result.summary);
    toolCalls.push({
      name: "saveCallSummary",
      input: { summary: result.summary },
      output: { id: savedSummary.id, path: savedSummary.path },
    });
    await writeJsonFile(result, "logs", "calls", `${result.callId}.json`);

    return result;
  }

  statusEvents.push({ status: "thinking", label: "Carla is reasoning from lead response" });
  if (carlaPromisedCalendarCheck(carlaTurn)) {
    statusEvents.push({ status: "thinking", label: "Checking calendar availability" });
    const slots = await checkCalendarAvailability();
    toolCalls.push({
      name: "checkCalendarAvailability",
      input: {},
      output: slots,
    });
    carlaTurn.reply = calendarOptionsMessage(slots, isPricingQuestion(leadReply));
    carlaTurn.recommendedToolCall = {
      name: "checkCalendarAvailability",
      reason: "Carla promised to check calendar availability.",
    };
    carlaTurn.outcome = "interested";
    carlaTurn.nextBestAction = "Wait for the lead to choose or confirm one of the offered slots.";
  }
  if (isPricingQuestion(leadReply)) {
    carlaTurn.reply = pricingAnswer();
  }
  statusEvents.push({ status: "agent_speaking", label: `${agentConfig.name} speaking` });
  nextTranscript.push({ speaker: "agent", name: agentConfig.name, message: carlaTurn.reply });

  const result = interactiveCallResult({
    callId: callId ?? interactiveCallId(lead.id),
    lead,
    transcript: nextTranscript,
    toolCalls,
    statusEvents,
    intentDetections: [intent],
    latestTurn: carlaTurn,
  });

  const savedSummary = await saveCallSummary(result.summary);
  toolCalls.push({
    name: "saveCallSummary",
    input: { summary: result.summary },
    output: { id: savedSummary.id, path: savedSummary.path },
  });

  await writeJsonFile(result, "logs", "calls", `${result.callId}.json`);

  return result;
};

const generateInteractiveTurn = async (
  client: OpenAI,
  lead: Lead,
  transcript: CallResult["transcript"],
  latestLeadMessage: string,
) => {
  const response = await requestCompletion(client, {
    model: model(),
    max_tokens: maxOutputTokens(),
    reasoning_effort: "low",
    messages: [
      { role: "system", content: interactiveSystemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          lead: leadContextForLlm(lead),
          conversation: transcriptForModel(transcript.slice(0, -1)),
          latestLeadMessage,
        }),
      },
    ],
  }, "carla_interactive_turn", interactiveTurnJsonSchema, interactiveTurnSchema);

  return {
    carlaTurn: response.carlaTurn,
    leadIntent: { ...response.leadIntent, leadMessage: latestLeadMessage },
  };
};

const ruleIntent = (
  leadMessage: string,
  intent: LeadIntentDetection["intent"],
  nextAgentMove: LeadIntentDetection["nextAgentMove"],
  reasoning: string,
  shouldBookMeeting = false,
): LeadIntentDetection => ({
  leadMessage,
  intent,
  objectionType: "none",
  shouldCheckCalendar: false,
  shouldBookMeeting,
  nextAgentMove,
  reasoning,
});

const generateCarlaTurn = async (
  client: OpenAI,
  lead: Lead,
  transcript: CallResult["transcript"],
): Promise<CarlaTurn> => {
  return requestCompletion(client, {
    model: model(),
    max_tokens: maxOutputTokens(),
    reasoning_effort: "low",
    messages: [
      { role: "system", content: `${carlaSystemPrompt}\n\nReturn one JSON object conforming exactly to the provided strict schema.` },
      {
        role: "user",
        content: JSON.stringify({
          lead: leadContextForLlm(lead),
          transcript: transcriptForModel(transcript),
        }),
      },
    ],
  }, "carla_turn", carlaTurnJsonSchema, carlaTurnSchema);
};

const interactiveCallResult = ({
  callId,
  lead,
  transcript,
  toolCalls,
  statusEvents,
  intentDetections,
  latestTurn,
  summaryOverride,
  forceFinal,
}: {
  callId: string;
  lead: Lead;
  transcript: CallResult["transcript"];
  toolCalls: CallToolCall[];
  statusEvents: CallResult["statusEvents"];
  intentDetections: LeadIntentDetection[];
  latestTurn: CarlaTurn;
  summaryOverride?: CallSummary;
  forceFinal?: boolean;
}): CallResult => {
  const summary: CallSummary = summaryOverride ?? {
    leadId: lead.id,
    leadName: lead.name,
    company: lead.company,
    painPoints: latestTurn.detectedPainPoints ?? [],
    objections: latestTurn.detectedObjections ?? [],
    interestLevel: latestTurn.interestLevel,
    meetingStatus: "not_booked",
    recommendedNextAction: latestTurn.nextBestAction,
    shortSummaryForSales: `Interactive call in progress with ${lead.name} at ${lead.company}.`,
  };
  const classification = classifyLeadOutcome(
    transcript.map((entry) => entry.message).join("\n"),
    summary,
  );
  const leadTurnCount = transcript.filter((entry) => entry.speaker === "lead").length;
  const isFinal =
    forceFinal || summary.meetingStatus === "booked" || leadTurnCount >= maxInteractiveLeadTurns();

  return {
    callId,
    mode: "llm",
    agent: {
      name: agentConfig.name,
      role: agentConfig.role,
      company: agentConfig.company,
    },
    lead,
    statusEvents: [
      ...statusEvents,
      { status: "idle", label: isFinal ? "Call ended" : "Waiting for lead reply" },
    ],
    transcript,
    toolCalls,
    intentDetections,
    summary,
    classification,
  };
};

const detectLeadIntent = async (
  client: OpenAI,
  lead: Lead,
  transcript: CallResult["transcript"],
  leadMessage: string,
): Promise<LeadIntentDetection> => {
  const intent = await requestCompletion(client, {
    model: model(),
    max_tokens: maxOutputTokens(),
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content: "Classify the lead's latest message in this sales conversation. Copy the latest message exactly into leadMessage. Do not generate a reply.",
      },
      {
        role: "user",
        content: JSON.stringify({
          leadContext: leadContextForLlm(lead),
          transcript: transcriptForModel(transcript.slice(0, -1)),
          latestLeadMessage: leadMessage,
        }),
      },
    ],
  }, "lead_intent", leadIntentJsonSchema, leadIntentSchema);
  return { ...intent, leadMessage };
};

const transcriptForModel = (transcript: CallResult["transcript"]) => {
  const recent = transcript.slice(-14).map((entry) => ({
    speaker: entry.speaker,
    message: entry.message.slice(0, 400),
  }));
  const earlierLeadMessages = transcript.slice(0, -14)
    .filter((entry) => entry.speaker === "lead")
    .slice(-6)
    .map((entry) => entry.message.slice(0, 200));

  return {
    earlierLeadContext: earlierLeadMessages.length ? earlierLeadMessages : undefined,
    recentConversation: recent,
  };
};

const leadContextForLlm = (lead: Lead): LeadContextForLlm => {
  const { scenario: _scenario, ...context } = lead;

  return context;
};

const shouldForceScriptedBooking = (lead: Lead, leadReply: string) =>
  lead.id === "lead_interested" &&
  /\b(book|schedule|set up|set-up)\b.{0,32}\b(demo|meeting|call)\b/.test(
    leadReply.toLowerCase(),
  );

const shouldOfferCalendarOptions = (
  leadReply: string,
  transcript: CallTranscriptEntry[],
) => {
  const normalized = leadReply.toLowerCase();
  const previousAgentMessage =
    [...transcript].reverse().find((entry) => entry.speaker === "agent")?.message.toLowerCase() ?? "";
  const carlaAlreadySaidSheWillCheck =
    /\b(check|checking|look|looking)\b.{0,40}\b(calendar|availability|available times|time slots|slots)\b/.test(
      previousAgentMessage,
    );
  const leadAsksForCheckResult =
    /\b(did you check|have you checked|any update|what did you find|do you have times|what times|which slots|what slots)\b/.test(
      normalized,
    );
  const explicitlyAskedToSchedule =
    /\b(book|schedule|set up|set-up|arrange|plan)\b.{0,40}\b(meeting|demo|demonstration|call|time|slot)\b/.test(
      normalized,
    ) ||
    /\b(meeting|demo|demonstration|call|time slot|time slots|availability|calendar)\b.{0,40}\b(book|schedule|available|work|works)\b/.test(
      normalized,
    ) ||
    /\b(when are you available|what times|which time|send.*time slot|send.*available time|can we (?:schedule|book|arrange).{0,40}\b(demo|demonstration|meeting|call)\b)\b/.test(
      normalized,
    );
  const shouldContinuePromisedCalendarCheck =
    carlaAlreadySaidSheWillCheck && leadAsksForCheckResult;

  return shouldContinuePromisedCalendarCheck || explicitlyAskedToSchedule;
};

const carlaPromisedCalendarCheck = (turn: CarlaTurn) => {
  const reply = turn.reply.toLowerCase();

  return (
    turn.recommendedToolCall.name === "checkCalendarAvailability" ||
    /\b(i'?ll|i will|let me|i can|going to)\b.{0,48}\b(check|look|find)\b.{0,48}\b(calendar|availability|available times|time slots|slots|openings)\b/.test(
      reply,
    ) ||
    /\b(check|look|find)\b.{0,48}\b(calendar|availability|available times|time slots|slots|openings)\b/.test(
      reply,
    )
  );
};

const shouldSendTimeSlotsByEmail = (
  leadReply: string,
  transcript: CallTranscriptEntry[],
) => {
  const normalized = leadReply.toLowerCase();
  const previousAgentMessage =
    [...transcript].reverse().find((entry) => entry.speaker === "agent")?.message.toLowerCase() ?? "";
  const asksForSlots = /\b(time slot|time slots|slot|slots|available time|available times|availability)\b/.test(
    normalized,
  );
  const mentionsEmail = /\b(email|send|mail)\b/.test(normalized);
  const followsNoSlotMessage =
    previousAgentMessage.includes("do not see an open slot") ||
    previousAgentMessage.includes("available times");

  return asksForSlots && (mentionsEmail || followsNoSlotMessage);
};

const acceptedCalendarOptionFromReply = (transcript: CallTranscriptEntry[], leadReply: string) => {
  const normalized = leadReply.toLowerCase();
  const previousAgentMessage = [...transcript]
    .reverse()
    .find((entry) => entry.speaker === "agent")?.message.toLowerCase();
  if (!previousAgentMessage?.includes("option 1")) return null;
  const offeredOptions = [...previousAgentMessage.matchAll(/option\s+(\d+):\s*([^;]+)/g)];
  if (offeredOptions.length === 0) return null;
  const explicitAgreement = /\b(ok|yes|works|book|confirm|that works|sounds good|go ahead)\b/.test(normalized);
  if (!explicitAgreement) return null;
  if (offeredOptions.length === 1) {
    const [, number, details] = offeredOptions[0];
    return { number: Number(number), details };
  }
  for (const [, number, details] of offeredOptions) {
    if (new RegExp(`\\boption\\s*${number}\\b`).test(normalized)) {
      return { number: Number(number), details };
    }
    const time = details.match(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i)?.[0];
    const date = details.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/i)?.[0];
    if (time && normalized.includes(time.toLowerCase()) && (!date || normalized.includes(date.toLowerCase()))) {
      return { number: Number(number), details };
    }
  }
  return null;
};

const offeredSlotMatches = (slot: CalendarSlot, offeredDetails: string) => {
  const offered = offeredDetails.match(/^(.*?)\s+with\s+(.+)$/i);
  return Boolean(
    offered &&
    formatSlot(slot).toLowerCase() === offered[1].trim().toLowerCase() &&
    slot.salesRep.toLowerCase() === offered[2].trim().toLowerCase(),
  );
};

const isPricingQuestion = (message: string) =>
  /\b(price|pricing|cost|how much|what does .* cost)\b/i.test(message);

const pricingAnswer = () =>
  "I don’t have confirmed pricing details to share. A sales representative can confirm current pricing for you.";

const calendarOptionsMessage = (slots: CalendarSlot[], includePricingAnswer = false) => {
  const availableSlots = slots.slice(0, 2);
  const pricingLeadIn = includePricingAnswer ? `${pricingAnswer()} ` : "";

  if (availableSlots.length === 0) {
    return `${pricingLeadIn}I do not see an open slot in the mock calendar right now, so I will have the sales team follow up with available times.`;
  }

  const options = availableSlots
    .map((slot, index) => `Option ${index + 1}: ${formatSlot(slot)} with ${slot.salesRep}`)
    .join("; ");

  return `${pricingLeadIn}I checked the calendar and can offer ${options}. Which one works best for you?`;
};

const formatSlot = (slot: CalendarSlot) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(slot.startsAt));

const collectSignals = (
  turn: CarlaTurn,
  painPoints: Set<string>,
  objections: Set<string>,
) => {
  for (const painPoint of turn.detectedPainPoints ?? []) {
    painPoints.add(painPoint);
  }

  for (const objection of turn.detectedObjections ?? []) {
    objections.add(objection);
  }
};

const leadScriptFor = (lead: Lead): LeadScriptTurn[] => {
  const first = "Yes, sure.";

  switch (lead.scenario) {
    case "interested":
      return [
        {
          lead: "Yes, I have a few minutes. We downloaded your guide because outbound follow-up is getting hard to keep consistent.",
        },
        {
          lead: "We use HubSpot and Outreach, but reps still duplicate follow-up work and sometimes high-intent leads wait too long.",
        },
        {
          lead: "That sounds relevant, but I would want to see how this fits our current workflow before considering anything.",
        },
        { lead: "Yes, let's book a short demo." },
      ];
    case "budget_objection":
      return [
        { lead: first },
        {
          lead: "Budget is tight, but we do spend too much time on repetitive follow-up.",
        },
      ];
    case "busy":
      return [{ lead: "I am about to join a meeting. Can you call me later?" }];
    case "not_interested":
      return [{ lead: "I do not think this is relevant for us right now." }];
    case "send_email":
      return [{ lead: "Can you send me an email instead?" }];
    case "existing_crm":
      return [
        { lead: "We already use Salesforce and Outreach." },
        { lead: "Send me a brief overview first." },
      ];
    case "authority_objection":
      return [
        { lead: "I can answer a few questions, but our CRO would need to approve anything like this." },
        { lead: "Send me something brief that I can forward." },
      ];
    case "security_concern":
      return [
        { lead: "This sounds interesting, but security review is usually the hard part for us." },
        { lead: "Send me details first. I do not want a generic pitch." },
      ];
  }
};

const nextBestActionFor = (intent: LeadIntentDetection) => {
  switch (intent.intent) {
    case "send_follow_up":
      return "Send a concise follow-up email tailored to the lead's question.";
    case "call_back_later":
      return "Schedule or note a better time to call the lead back.";
    case "not_interested":
      return "Respect the decline and avoid further outreach unless the lead re-engages.";
    case "unqualified":
      return "Mark the lead as unqualified and document the reason.";
    case "objection":
      return `Follow up on the ${intent.objectionType} objection without pushing for a meeting.`;
    case "interested":
      return "Continue discovery and offer a meeting only if the lead shows fit.";
  }
};

const shortSummaryFor = (
  lead: Lead,
  interestLevel: CallSummary["interestLevel"],
  meetingStatus: CallSummary["meetingStatus"],
  nextBestAction: string,
) =>
  `${lead.name} at ${lead.company} completed an LLM-assisted call. Interest: ${interestLevel}. Meeting status: ${meetingStatus}. Next action: ${nextBestAction}`;
