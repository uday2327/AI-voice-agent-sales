import type { CalendarSlot } from "../types.js";
import { readJsonFile, resolveFromProjectRoot } from "../storage/jsonStore.js";
import { access } from "node:fs/promises";

const runtimeCalendarPath = ["logs", "calendar-state.json"] as const;
const seedCalendarPath = ["src", "server", "data", "calendar.mock.json"] as const;

const fileExists = async (...segments: string[]) => {
  try {
    await access(resolveFromProjectRoot(...segments));
    return true;
  } catch {
    return false;
  }
};

export const getCalendarSlots = async (): Promise<CalendarSlot[]> => {
  if (await fileExists(...runtimeCalendarPath)) {
    const runtimeSlots = await readJsonFile<CalendarSlot[]>(...runtimeCalendarPath);

    const hasFutureSlot = runtimeSlots.some(
      (slot) => slot.available && new Date(slot.startsAt).getTime() > Date.now(),
    );
    if (hasFutureSlot) {
      return runtimeSlots;
    }
  }

  return readJsonFile<CalendarSlot[]>(...seedCalendarPath);
};

export const checkCalendarAvailability = async (
  preferredDate?: string,
): Promise<CalendarSlot[]> => {
  const slots = await getCalendarSlots();

  return slots
    .filter((slot) => slot.available)
    .filter((slot) => new Date(slot.startsAt).getTime() > Date.now())
    .filter((slot) =>
      preferredDate ? slot.startsAt.startsWith(preferredDate) : true,
    )
    .slice(0, 3);
};
