import { agentConfig } from "../config/agent.config.js";
import { runLlmCall } from "../agent/llmCallOrchestrator.js";
import { writeJsonFile } from "../storage/jsonStore.js";
import { bookMeeting } from "../tools/bookMeeting.js";
import { checkCalendarAvailability } from "../tools/checkCalendarAvailability.js";
import { classifyLeadOutcome } from "../tools/classifyLeadOutcome.js";
import { getLeadContext } from "../tools/getLeadContext.js";
import { saveCallSummary } from "../tools/saveCallSummary.js";
import type {
  AgentMode,
  CallResult,
  CallStatus,
  CallSummary,
  CallToolCall,
  Lead,
} from "../types.js";

const getAgentMode = (requestedMode?: AgentMode): AgentMode =>
  requestedMode ?? (process.env.AGENT_MODE as AgentMode | undefined) ?? "deterministic";

const callId = (leadId: string) =>
  `${leadId}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;

export const runCall = async (
  leadId: string,
  requestedMode?: AgentMode,
): Promise<CallResult> => {
  const mode = getAgentMode(requestedMode);

  if (mode === "llm") {
    return runLlmCall(leadId);
  }

  const lead = await getLeadContext(leadId);
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
  agentSays(openingFor(lead));

  const summary = await runDeterministicScenario({
    lead,
    transcript,
    toolCalls,
    agentSays,
    leadSays,
    setStatus,
  });

  setStatus("thinking", "Classifying call outcome");
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
    mode,
    agent: {
      name: agentConfig.name,
      role: agentConfig.role,
      company: agentConfig.company,
    },
    lead,
    statusEvents: [...statusEvents, { status: "idle", label: "Call ended" }],
    transcript,
    toolCalls,
    summary,
    classification,
  };

  await writeJsonFile(result, "logs", "calls", `${id}.json`);

  return result;
};

type DeterministicContext = {
  lead: Lead;
  transcript: CallResult["transcript"];
  toolCalls: CallToolCall[];
  agentSays: (message: string) => void;
  leadSays: (message: string) => void;
  setStatus: (status: CallStatus, label: string) => void;
};

const openingFor = (lead: Lead) =>
  `Hi ${lead.name}, this is ${agentConfig.name}. I'll keep it brief. I saw your interest around ${lead.discussionTopic}, and wanted to understand if AI agents could help your team. Would it be okay if I ask a couple of quick questions?`;

const summaryBase = (lead: Lead): Pick<CallSummary, "leadId" | "leadName" | "company"> => ({
  leadId: lead.id,
  leadName: lead.name,
  company: lead.company,
});

const runDeterministicScenario = async (
  context: DeterministicContext,
): Promise<CallSummary> => {
  switch (context.lead.scenario) {
    case "interested":
      return runInterestedCall(context);
    case "busy":
      return runBusyCall(context);
    case "not_interested":
      return runNotInterestedCall(context);
    case "budget_objection":
      return runBudgetObjectionCall(context);
    case "send_email":
      return runSendEmailCall(context);
    case "existing_crm":
      return runExistingCrmCall(context);
    case "authority_objection":
      return runAuthorityObjectionCall(context);
    case "security_concern":
      return runSecurityConcernCall(context);
  }
};

const runInterestedCall = async ({
  lead,
  toolCalls,
  agentSays,
  leadSays,
  setStatus,
}: DeterministicContext): Promise<CallSummary> => {
  leadSays(
    "Yes, I have a few minutes. We downloaded your guide because outbound follow-up is getting hard to keep consistent.",
  );
  agentSays(
    `That makes sense. For a ${lead.companySize} company like ${lead.company}, follow-up can get messy once reps are moving between ${lead.currentTools.join(
      " and ",
    )}. Where does the process break down most often?`,
  );
  leadSays(
    "Our reps repeat the same follow-ups in HubSpot and Outreach, and sometimes the best leads wait too long after they engage.",
  );
  agentSays(
    "That is exactly the workflow this is built around. The AI agent can watch for high-intent activity, prepare the next step, and help reps act faster without replacing the CRM or the sales engagement tool.",
  );
  leadSays(
    "That sounds relevant, but I would need to understand how it fits with our existing stack. We are not looking to rip out tools.",
  );
  agentSays(
    `Completely fair. The goal would be to connect around ${lead.discussionTopic.toLowerCase()}, not replace ${lead.currentTools.join(
      " or ",
    )}. A short working session could map the exact handoff from lead signal to rep action. Would that be useful?`,
  );
  leadSays(
    "Yes, a short meeting would be useful if it focuses on our current workflow and not a generic pitch.",
  );

  setStatus("thinking", "Checking calendar availability");
  const slots = await checkCalendarAvailability();
  toolCalls.push({
    name: "checkCalendarAvailability",
    input: {},
    output: slots,
  });

  const slot = slots[0];
  if (!slot) {
    agentSays("I do not see an open slot right now, so I will mark this for human follow-up.");
    return {
      ...summaryBase(lead),
      painPoints: ["Manual follow-ups", "Missed lead prioritization"],
      objections: [],
      interestLevel: "high",
      meetingStatus: "follow_up_needed",
      recommendedNextAction: "Have sales follow up with available meeting times.",
      shortSummaryForSales:
        "Lead is interested in reducing manual follow-ups, but no calendar slot was available.",
    };
  }

  agentSays(`Great. I have ${slot.startsAt} with ${slot.salesRep}. Does that work?`);
  leadSays("Yes, that works. Please send the invite.");

  setStatus("thinking", "Booking meeting");
  const meeting = await bookMeeting(
    lead.id,
    slot.id,
    "Qualified deterministic call: interested in AI outbound workflow automation.",
  );
  toolCalls.push({
    name: "bookMeeting",
    input: { leadId: lead.id, slotId: slot.id },
    output: meeting,
  });

  agentSays(
    `Perfect, I booked it with ${meeting.salesRep}. Thanks ${lead.name}, and we will send the invite to ${lead.workEmail}.`,
  );

  return {
    ...summaryBase(lead),
    painPoints: [
      "Manual follow-ups across HubSpot and Outreach",
      "Delayed response to high-intent leads",
      "Needs workflow fit with existing tools",
    ],
    objections: ["Does not want to replace existing tools", "Wants a workflow-focused meeting"],
    interestLevel: "high",
    meetingStatus: "booked",
    bookedSlotId: meeting.slotId,
    recommendedNextAction: "Send calendar invite and prepare sales rep with CRM context.",
    shortSummaryForSales:
      "Sarah at Growthly booked a workflow-focused meeting to discuss AI agents for faster high-intent lead follow-up across HubSpot and Outreach.",
  };
};

const runBusyCall = ({ lead, agentSays, leadSays }: DeterministicContext): CallSummary => {
  leadSays("I am about to join a meeting, so now is not a good time.");
  agentSays(
    "No problem. I do not want to interrupt your day. Would tomorrow be better for a very short follow-up?",
  );
  leadSays("Tomorrow afternoon is better.");
  agentSays("Thanks. I will mark that as the next best step and keep the follow-up brief.");

  return {
    ...summaryBase(lead),
    painPoints: [lead.painHint],
    objections: ["Busy during initial call"],
    interestLevel: "medium",
    meetingStatus: "follow_up_needed",
    recommendedNextAction: "Call back tomorrow afternoon with a short opening.",
    shortSummaryForSales:
      "Lead was busy but open to a later callback. Keep the next touch concise.",
  };
};

const runNotInterestedCall = ({ lead, agentSays, leadSays }: DeterministicContext): CallSummary => {
  leadSays("I do not think this is relevant for us right now.");
  agentSays(
    "Understood. Just so I do not send irrelevant follow-up, are sales calls or customer engagement workflows a priority at all this quarter?",
  );
  leadSays("No, not this quarter.");
  agentSays("Thanks for being direct. I will close this out and will not push further. Have a good day.");

  return {
    ...summaryBase(lead),
    painPoints: [],
    objections: ["Not a current priority"],
    interestLevel: "none",
    meetingStatus: "not_booked",
    recommendedNextAction: "Stop active outreach unless a future engagement trigger appears.",
    shortSummaryForSales:
      "Lead is not interested and said sales/customer engagement workflows are not a priority this quarter.",
  };
};

const runBudgetObjectionCall = ({ lead, agentSays, leadSays }: DeterministicContext): CallSummary => {
  leadSays("Maybe, but budget is tight right now.");
  agentSays(
    "That is completely fair. I would not suggest adding spend unless there is a clear productivity case. Where are reps losing the most time today?",
  );
  leadSays("Mostly repetitive follow-up and deciding which accounts deserve attention.");
  agentSays(
    "That is exactly where AI agents can help: reducing repetitive follow-up and prioritizing the most relevant leads before the team spends more time. A short discovery call could confirm whether there is enough value before budget is discussed. Would that be reasonable?",
  );
  leadSays("Send me some details first, then maybe we can talk.");
  agentSays("Absolutely. I will send a focused follow-up around productivity and prioritization, not a generic pitch.");

  return {
    ...summaryBase(lead),
    painPoints: ["Repetitive follow-up", "Account prioritization"],
    objections: ["Budget is tight"],
    interestLevel: "medium",
    meetingStatus: "follow_up_needed",
    recommendedNextAction: "Send a value-focused email before asking for a meeting.",
    shortSummaryForSales:
      "Lead raised budget concerns but described productivity pain around follow-up and prioritization.",
  };
};

const runSendEmailCall = ({ lead, agentSays, leadSays }: DeterministicContext): CallSummary => {
  leadSays("Can you send me an email instead?");
  agentSays(
    `Of course. To make it useful, should I focus on ${lead.discussionTopic} and how AI agents connect with ${lead.currentTools.join(
      " and ",
    )}?`,
  );
  leadSays("Yes, that would be the most relevant.");
  agentSays(`Perfect. I will send a concise note to ${lead.workEmail}. Thanks for your time.`);

  return {
    ...summaryBase(lead),
    painPoints: [lead.painHint],
    objections: ["Requested email instead of live discussion"],
    interestLevel: "low",
    meetingStatus: "follow_up_needed",
    recommendedNextAction: `Send follow-up email to ${lead.workEmail} focused on ${lead.discussionTopic}.`,
    shortSummaryForSales:
      "Lead requested email follow-up and confirmed the most relevant topic for the message.",
  };
};

const runExistingCrmCall = ({ lead, agentSays, leadSays }: DeterministicContext): CallSummary => {
  leadSays("We already have a CRM and automation stack in place.");
  agentSays(
    `That makes sense. The goal would not be to replace ${lead.currentTools[0]}; the goal is to connect customer data, GTM workflows, and AI agents across the tools you already use. Where does work still feel fragmented?`,
  );
  leadSays("Handoffs across tools are still messy.");
  agentSays(
    "That is a good fit for a short discovery conversation. If there is no gap, we will know quickly, but if there is, AI agents may help reduce those handoff issues.",
  );
  leadSays("Send me a brief overview first.");
  agentSays("Will do. I will keep it focused on complementing your current GTM stack.");

  return {
    ...summaryBase(lead),
    painPoints: ["Fragmented GTM workflows", "Messy tool handoffs"],
    objections: ["Already has CRM and automation tools"],
    interestLevel: "medium",
    meetingStatus: "follow_up_needed",
    recommendedNextAction: "Send overview explaining how AI agents complement the current GTM stack.",
    shortSummaryForSales:
      "Lead already has CRM/automation tools but acknowledged fragmented handoffs across systems.",
  };
};

const runAuthorityObjectionCall = ({
  lead,
  agentSays,
  leadSays,
}: DeterministicContext): CallSummary => {
  leadSays("I can answer some questions, but I am not the person who would approve this.");
  agentSays(
    "That is helpful to know. I do not want to put you in the wrong conversation. Who usually owns decisions around outbound workflow or AI agent projects?",
  );
  leadSays("Our CRO would need to be involved if this looked useful.");
  agentSays(
    "Makes sense. I can send a short note you can forward, focused on reducing duplicate research and improving prioritization. Would that be useful?",
  );
  leadSays("Yes, send something brief and I can share it.");
  agentSays(`Great. I will send a concise note to ${lead.workEmail} that is easy to forward.`);

  return {
    ...summaryBase(lead),
    painPoints: ["Duplicate account research", "Needs executive buyer involvement"],
    objections: ["Not the decision maker"],
    interestLevel: "medium",
    meetingStatus: "follow_up_needed",
    recommendedNextAction: "Send a forwardable email for the lead to share with the CRO.",
    shortSummaryForSales:
      "Lead is not the buyer but can forward relevant information to the CRO if concise.",
  };
};

const runSecurityConcernCall = ({ lead, agentSays, leadSays }: DeterministicContext): CallSummary => {
  leadSays("This could be interesting, but security review is usually the hard part for us.");
  agentSays(
    "I hear you. For a cybersecurity team, it would be important to avoid vague claims. The useful next step may be a focused conversation about workflow fit and what details your team would need.",
  );
  leadSays("Yes, but I do not want a generic sales pitch.");
  agentSays(
    "Completely fair. I can position it as a short discovery call around customer engagement workflows, handoffs, and review requirements. Would that be worth exploring?",
  );
  leadSays("Send me details first.");
  agentSays(`Will do. I will send a focused note to ${lead.workEmail} and avoid overclaiming.`);

  return {
    ...summaryBase(lead),
    painPoints: ["Security review concerns", "Customer engagement handoff complexity"],
    objections: ["Security and review requirements"],
    interestLevel: "medium",
    meetingStatus: "follow_up_needed",
    recommendedNextAction: "Send a focused follow-up that offers a security-aware discovery call.",
    shortSummaryForSales:
      "Lead is interested but cautious about security review and wants details before a meeting.",
  };
};
