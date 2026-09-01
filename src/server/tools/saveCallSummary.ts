import type { CallSummary } from "../types.js";
import { writeJsonFile } from "../storage/jsonStore.js";

export const saveCallSummary = async (
  summary: CallSummary,
): Promise<{ id: string; path: string; summary: CallSummary }> => {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const id = `${summary.leadId}-${timestamp}`;
  const filePath = await writeJsonFile(summary, "logs", "summaries", `${id}.json`);

  return { id, path: filePath, summary };
};
