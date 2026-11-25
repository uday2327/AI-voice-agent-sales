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
  intent: z.enum(["interested", "objection", "send_follow_up", "call_back_later", "not_interested", "unqualified"]),
  objectionType: z.enum(["budget", "timing", "existing_tools", "authority", "fit", "none"]),
  shouldCheckCalendar: z.boolean(),
  shouldBookMeeting: z.boolean(),
  nextAgentMove: z.enum(["ask_discovery", "handle_objection", "offer_meeting", "offer_email", "close"]),
  reasoning: z.string(),
});

const jsonOnlyInstruction = "Return only one valid json object. Do not include Markdown, reasoning, or any text outside the json object. Use all required fields and exact enum values.";

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
    if (error.status === 401 || error.status === 403) return Object.assign(new Error("Groq rejected GROQ_API_KEY. Check that the key is valid and active."), { status: 502 });
    if (error.status === 429) return Object.assign(new Error("Groq rate limit or usage quota reached. Wait and retry, or check the Groq console."), { status: 429 });
    if (error.status === 400) return Object.assign(new Error(`Groq rejected the request (model ${model()}): ${error.message}`), { status: 502 });
    return Object.assign(new Error(`Groq API error${error.status ? ` (${error.status})` : ""}: ${error.message}`), { status: 502 });
  }
  return error instanceof Error ? error : new Error("Unexpected Groq request failure.");
};

const isStructuredOutputError = (error: unknown) =>
  error instanceof Error && /failed to (validate|generate) json/i.test(error.message);

const requestCompletion = async (
  client: OpenAI,
  request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
  try {
    return await client.chat.completions.create(request);
  } catch (error) {
    throw modelError(error);
  }
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
    { status: "thinking", label: "Reading lead intent" },
  ];
  const intent = await detectLeadIntent(client, lead, nextTranscript, leadReply);

  if (shouldSendTimeSlotsByEmail(leadReply, transcript)) {
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

  if (shouldBookFromReply(transcript, leadReply)) {
    statusEvents.push({ status: "thinking", label: "Booking meeting" });
    const slots = await checkCalendarAvailability();
    toolCalls.push({
      name: "checkCalendarAvailability",
      input: {},
      output: slots,
    });
    const slot = slots[0];

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
  }

  if (shouldOfferCalendarOptions(intent, leadReply, transcript)) {
    statusEvents.push({ status: "thinking", label: "Checking calendar availability" });
    const slots = await checkCalendarAvailability();
    toolCalls.push({
      name: "checkCalendarAvailability",
      input: {},
      output: slots,
    });
    const message = calendarOptionsMessage(slots, lead);
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
        reply: message,
        detectedPainPoints: [],
        detectedObjections: [],
        interestLevel: "high",
        recommendedToolCall: {
          name: "checkCalendarAvailability",
          reason: "Lead asked to book or discuss a meeting.",
        },
        outcome: "interested",
        nextBestAction: "Wait for the lead to choose or confirm one of the offered slots.",
      },
    });

    await writeJsonFile(result, "logs", "calls", `${result.callId}.json`);

    return result;
  }

  statusEvents.push({ status: "thinking", label: "Carla is reasoning from lead response" });
  const carlaTurn = await generateCarlaTurn(client, lead, nextTranscript);
  if (carlaPromisedCalendarCheck(carlaTurn)) {
    statusEvents.push({ status: "thinking", label: "Checking calendar availability" });
    const slots = await checkCalendarAvailability();
    toolCalls.push({
      name: "checkCalendarAvailability",
      input: {},
      output: slots,
    });
    carlaTurn.reply = `${carlaTurn.reply} ${calendarOptionsMessage(slots, lead)}`;
    carlaTurn.recommendedToolCall = {
      name: "checkCalendarAvailability",
      reason: "Carla promised to check calendar availability.",
    };
    carlaTurn.outcome = "interested";
    carlaTurn.nextBestAction = "Wait for the lead to choose or confirm one of the offered slots.";
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

const generateCarlaTurn = async (
  client: OpenAI,
  lead: Lead,
  transcript: CallResult["transcript"],
): Promise<CarlaTurn> => {
  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await requestCompletion(client, {
    model: model(),
    temperature: 0.3,
    max_tokens: maxOutputTokens(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${jsonOnlyInstruction}\n\n${carlaSystemPrompt}` },
      {
        role: "user",
        content: JSON.stringify({
          instruction:
            "Generate Carla's next call turn as JSON. Follow the structured output shape from the system prompt. Return exactly one valid JSON object. Do not use Markdown fences. Include every required field with the correct types. Use empty arrays where there are no detected items.",
          lead: leadContextForLlm(lead),
          transcript,
        }),
      },
    ],
    });
  } catch (error) {
    if (isStructuredOutputError(error)) return fallbackCarlaTurn(lead, transcript);
    throw error;
  }
  const content = response.choices[0]?.message.content;

  if (!content?.trim()) {
    return fallbackCarlaTurn(lead, transcript);
  }
  try {
    const parsed: unknown = JSON.parse(content);
    const validated = carlaTurnSchema.safeParse(parsed);
    return validated.success ? validated.data : fallbackCarlaTurn(lead, transcript);
  } catch {
    return fallbackCarlaTurn(lead, transcript);
  }
};

const fallbackCarlaTurn = (lead: Lead, transcript: CallResult["transcript"]): CarlaTurn => ({
  reply: transcript.length === 0
    ? `Hi ${lead.name}, this is Carla. I’m calling about ${lead.discussionTopic}. Is now a good time for a quick question?`
    : "I want to make sure I understand. Could you tell me a little more about what matters most to your team?",
  detectedPainPoints: [],
  detectedObjections: [],
  interestLevel: "none",
  recommendedToolCall: { name: "none", reason: "Using a neutral response because the model response could not be validated." },
  outcome: "interested",
  nextBestAction: "Continue discovery; no lead signals were inferred from the invalid model response.",
});

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
  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await requestCompletion(client, {
    model: model(),
    temperature: 0.1,
    max_tokens: 180,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You classify one lead reply in an outbound sales call. ${jsonOnlyInstruction} Do not write Carla's reply.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction:
            "Classify the latest lead message. Use the exact enum values from the response shape. Set shouldCheckCalendar true only when the lead explicitly asks to schedule, book, discuss calendar availability, or choose a meeting time. Mere interest in a demo/product/help is not enough. Set shouldBookMeeting true only if the lead agreed to a specific available slot, otherwise false. Return exactly one valid JSON object. No Markdown, no explanations outside JSON. All boolean and enum fields must have their required types.",
          responseShape: {
            intent:
              "interested | objection | send_follow_up | call_back_later | not_interested | unqualified",
            objectionType: "budget | timing | existing_tools | authority | fit | none",
            shouldCheckCalendar: "boolean",
            shouldBookMeeting: "boolean",
            nextAgentMove:
              "ask_discovery | handle_objection | offer_meeting | offer_email | close",
            reasoning: "brief reason",
          },
          leadContext: leadContextForLlm(lead),
          transcript,
          latestLeadMessage: leadMessage,
        }),
      },
    ],
    });
  } catch (error) {
    if (!isStructuredOutputError(error)) throw error;
    return {
      leadMessage, intent: "unqualified", objectionType: "none", shouldCheckCalendar: false,
      shouldBookMeeting: false, nextAgentMove: "ask_discovery",
      reasoning: "Intent could not be validated; no booking or calendar action was inferred.",
    };
  }
  const content = response.choices[0]?.message.content;

  let parsed: unknown;
  try { parsed = content?.trim() ? JSON.parse(content) : undefined; } catch { parsed = undefined; }
  const validated = leadIntentSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      leadMessage, intent: "unqualified", objectionType: "none", shouldCheckCalendar: false,
      shouldBookMeeting: false, nextAgentMove: "ask_discovery",
      reasoning: "Intent could not be validated; no booking or calendar action was inferred.",
    };
  }
  return { leadMessage, ...validated.data };
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
  intent: LeadIntentDetection,
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
    /\b(book|schedule|set up|set-up|arrange)\b.{0,32}\b(meeting|demo|call|time|slot)\b/.test(
      normalized,
    ) ||
    /\b(meeting|demo|call|time slot|time slots|availability|calendar)\b.{0,32}\b(book|schedule|available|work|works)\b/.test(
      normalized,
    ) ||
    /\b(when are you available|what times|which time|send.*time slot|send.*available time)\b/.test(
      normalized,
    );
  const shouldContinuePromisedCalendarCheck =
    carlaAlreadySaidSheWillCheck && leadAsksForCheckResult;

  return (
    shouldContinuePromisedCalendarCheck ||
    (explicitlyAskedToSchedule &&
      (intent.shouldCheckCalendar ||
        intent.nextAgentMove === "offer_meeting" ||
        /\b(book|meeting|demo|call|calendar|schedule|available|availability|time slot|time slots)\b/.test(
          normalized,
        )))
  );
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

const shouldBookFromReply = (transcript: CallTranscriptEntry[], leadReply: string) => {
  const normalized = leadReply.toLowerCase();
  const previousAgentMessage = [...transcript]
    .reverse()
    .find((entry) => entry.speaker === "agent")?.message.toLowerCase();
  if (!previousAgentMessage?.includes("option 1")) return false;
  const offeredOptions = [...previousAgentMessage.matchAll(/option\s+(\d+):\s*([^;]+)/g)];
  if (offeredOptions.length === 0) return false;
  const explicitAgreement = /\b(ok|yes|works|book|confirm|that works|sounds good|go ahead)\b/.test(normalized);
  if (!explicitAgreement) return false;
  if (offeredOptions.length === 1) return true;
  return offeredOptions.some(([, number, details]) => {
    if (new RegExp(`\\boption\\s*${number}\\b`).test(normalized)) return true;
    const time = details.match(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i)?.[0];
    const date = details.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/i)?.[0];
    return Boolean(time && normalized.includes(time.toLowerCase()) && (!date || normalized.includes(date.toLowerCase())));
  });
};

const calendarOptionsMessage = (slots: CalendarSlot[], lead: Lead) => {
  const availableSlots = slots.slice(0, 2);

  if (availableSlots.length === 0) {
    return "I do not see an open slot in the mock calendar right now, so I will have the sales team follow up with available times.";
  }

  const options = availableSlots
    .map((slot, index) => `Option ${index + 1}: ${formatSlot(slot)} with ${slot.salesRep}`)
    .join("; ");

  return `Absolutely. Since you are evaluating whether AI agents can help with ${lead.discussionTopic.toLowerCase()}, a short meeting is the right place to map that to your current workflow. I checked the calendar and can offer ${options}. Which one works best for you?`;
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
