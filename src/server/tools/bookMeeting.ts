import type { Meeting } from "../types.js";
import { writeJsonFile } from "../storage/jsonStore.js";
import { getCalendarSlots } from "./checkCalendarAvailability.js";
import { getLeadContext } from "./getLeadContext.js";

export const bookMeeting = async (
  leadId: string,
  slotId: string,
  notes = "",
): Promise<Meeting> => {
  await getLeadContext(leadId);

  const slots = await getCalendarSlots();
  const slot = slots.find((item) => item.id === slotId);

  if (!slot) {
    throw new Error(`Calendar slot not found: ${slotId}`);
  }

  if (!slot.available) {
    throw new Error(`Calendar slot is not available: ${slotId}`);
  }

  slot.available = false;
  slot.bookedByLeadId = leadId;
  slot.notes = notes;

  await writeJsonFile(slots, "logs", "calendar-state.json");

  return {
    leadId,
    slotId: slot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    salesRep: slot.salesRep,
    notes,
  };
};
