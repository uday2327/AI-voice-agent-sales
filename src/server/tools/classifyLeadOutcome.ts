import type {
  CallSummary,
  LeadOutcomeClassification,
  MeetingStatus,
} from "../types.js";

const textIncludes = (text: string, phrases: string[]) =>
  phrases.some((phrase) => text.includes(phrase));

export const classifyLeadOutcome = (
  transcript = "",
  summary?: Partial<CallSummary>,
): LeadOutcomeClassification => {
  const normalizedTranscript = transcript.toLowerCase();
  const meetingStatus = summary?.meetingStatus as MeetingStatus | undefined;

  if (meetingStatus === "booked" || summary?.bookedSlotId) {
    return {
      outcome: "meeting_booked",
      recommendedNextAction: "Send calendar invite and prep sales rep with call summary.",
      reason: "A meeting was booked during the call.",
    };
  }

  if (
    textIncludes(normalizedTranscript, ["send me an email", "email me", "send info"]) ||
    summary?.recommendedNextAction?.toLowerCase().includes("email")
  ) {
    return {
      outcome: "send_email",
      recommendedNextAction: "Send a concise follow-up email tailored to the lead's stated interest.",
      reason: "The lead requested information by email.",
    };
  }

  if (textIncludes(normalizedTranscript, ["busy", "not a good time", "call me later"])) {
    return {
      outcome: "call_back_later",
      recommendedNextAction: "Schedule a short callback attempt at the lead's preferred time.",
      reason: "The lead was busy but did not reject the conversation.",
    };
  }

  if (
    textIncludes(normalizedTranscript, ["not interested", "no thanks", "remove me"]) ||
    summary?.interestLevel === "none"
  ) {
    return {
      outcome: "not_interested",
      recommendedNextAction: "Respectfully stop active outreach unless a future trigger appears.",
      reason: "The lead showed no interest or asked to end outreach.",
    };
  }

  if (summary?.interestLevel === "low") {
    return {
      outcome: "needs_human_follow_up",
      recommendedNextAction: "Have a human sales rep review the context before the next touch.",
      reason: "The lead had low interest and needs careful follow-up.",
    };
  }

  return {
    outcome: "needs_human_follow_up",
    recommendedNextAction: "Review the transcript and decide whether to send a follow-up or retry later.",
    reason: "The call did not contain enough signal for a confident automated outcome.",
  };
};
