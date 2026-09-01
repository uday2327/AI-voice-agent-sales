export type LeadScenario =
  | "interested"
  | "busy"
  | "not_interested"
  | "budget_objection"
  | "send_email"
  | "existing_crm"
  | "authority_objection"
  | "security_concern";

export type Lead = {
  id: string;
  scenario: LeadScenario;
  name: string;
  title: string;
  company: string;
  industry: string;
  companySize: string;
  currentTools: string[];
  painHint: string;
  discussionTopic: string;
  previousInteraction: string;
  workEmail: string;
};

export type CalendarSlot = {
  id: string;
  startsAt: string;
  endsAt: string;
  salesRep: string;
  available: boolean;
  bookedByLeadId?: string;
  notes?: string;
};

export type Meeting = {
  leadId: string;
  slotId: string;
  startsAt: string;
  endsAt: string;
  salesRep: string;
  notes: string;
};

export type InterestLevel = "high" | "medium" | "low" | "none";

export type MeetingStatus = "booked" | "not_booked" | "follow_up_needed";

export type LeadOutcome =
  | "meeting_booked"
  | "send_email"
  | "call_back_later"
  | "not_interested"
  | "disqualified"
  | "needs_human_follow_up";

export type CallSummary = {
  leadId: string;
  leadName: string;
  company: string;
  painPoints: string[];
  objections: string[];
  interestLevel: InterestLevel;
  meetingStatus: MeetingStatus;
  bookedSlotId?: string;
  recommendedNextAction: string;
  shortSummaryForSales: string;
};

export type LeadOutcomeClassification = {
  outcome: LeadOutcome;
  recommendedNextAction: string;
  reason: string;
};

export type AgentMode = "deterministic" | "llm";

export type CallMode = "demo" | "interactive";

export type CallStatus = "agent_speaking" | "lead_speaking" | "thinking" | "idle";

export type CallSpeaker = "agent" | "lead";

export type CallTranscriptEntry = {
  speaker: CallSpeaker;
  name: string;
  message: string;
};

export type CallStatusEvent = {
  status: CallStatus;
  label: string;
};

export type CallToolCall = {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
};

export type LeadIntentDetection = {
  leadMessage: string;
  intent:
    | "interested"
    | "objection"
    | "send_follow_up"
    | "call_back_later"
    | "not_interested"
    | "unqualified";
  objectionType: "budget" | "timing" | "existing_tools" | "authority" | "fit" | "none";
  shouldCheckCalendar: boolean;
  shouldBookMeeting: boolean;
  nextAgentMove:
    | "ask_discovery"
    | "handle_objection"
    | "offer_meeting"
    | "offer_email"
    | "close";
  reasoning: string;
};

export type CallResult = {
  callId: string;
  mode: AgentMode;
  agent: {
    name: string;
    role: string;
    company: string;
  };
  lead: Lead;
  statusEvents: CallStatusEvent[];
  transcript: CallTranscriptEntry[];
  toolCalls: CallToolCall[];
  intentDetections?: LeadIntentDetection[];
  summary: CallSummary;
  classification: LeadOutcomeClassification;
};
