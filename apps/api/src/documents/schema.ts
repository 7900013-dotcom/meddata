import { z } from "zod";

export const DOCUMENT_KINDS = ["lab_result", "prescription", "discharge_summary", "consultation", "imaging", "other"] as const;

const nul = <T extends z.ZodType>(t: T) => t.nullable();

export const Medicine = z.object({
  name: z.string().describe("Medicine name exactly as written; put [?] in place of illegible letters"),
  dose: nul(z.string()).describe("Strength and amount, e.g. '500 mg, 1 tablet'"),
  frequency: nul(z.string()).describe("e.g. '3 times a day'"),
  duration: nul(z.string()).describe("e.g. '7 days'"),
  route: nul(z.string()),
  notes: nul(z.string()),
  uncertain: z.boolean().describe("true if any part of this line was hard to read"),
});

export const LabValue = z.object({
  test: z.string().describe("Test name as printed, e.g. 'Hemoglobina'"),
  value: nul(z.number()).describe("Numeric value, or null if not numeric"),
  value_text: z.string().describe("The result exactly as printed, e.g. '5.2' or 'negativ'"),
  unit: nul(z.string()),
  ref_low: nul(z.number()),
  ref_high: nul(z.number()),
  uncertain: z.boolean(),
});

export const Extraction = z.object({
  document_kind: z.enum(DOCUMENT_KINDS),
  investigation_date: nul(z.string()).describe("Date the sample was taken / visit happened, YYYY-MM-DD; null if not found"),
  institution: nul(z.string()),
  doctor_name: nul(z.string()),
  title: z.string().describe("Short title in the document's language, e.g. 'Hemoleucogramă completă'"),
  summary: z.string().describe("Two or three plain sentences on what the document says, in the document's language"),
  transcription: z.string().describe("Full text of the document, line by line, [?] for anything illegible"),
  diagnoses: z.array(z.string()),
  medicines: z.array(Medicine),
  lab_values: z.array(LabValue),
  uncertain_fields: z.array(z.string()).describe("Which fields the patient should double-check, and why"),
});

export type Extraction = z.infer<typeof Extraction>;
export type Medicine = z.infer<typeof Medicine>;
