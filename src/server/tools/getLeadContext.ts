import type { Lead } from "../types.js";
import { readJsonFile } from "../storage/jsonStore.js";

export const getAllLeads = async (): Promise<Lead[]> =>
  readJsonFile<Lead[]>("src", "server", "data", "crm.mock.json");

export const getLeadContext = async (leadId: string): Promise<Lead> => {
  const leads = await getAllLeads();
  const lead = leads.find((item) => item.id === leadId);

  if (!lead) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  return lead;
};
