import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Extraction } from "./schema.js";

export interface Extractor {
  extract(input: { buffer: Buffer; mime: string }): Promise<Extraction>;
}

export class ExtractionError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

const SYSTEM = `You read medical documents from Moldova for the patient they belong to: handwritten prescriptions,
discharge summaries, consultation notes and printed lab results. They are usually in Romanian or Russian, sometimes mixed,
with Latin abbreviations and dosing shorthand such as "1 cp x 2/zi".

Transcribe faithfully. Never guess silently: when a word, number or date is hard to read, write your best reading with [?]
in place of the unclear part, set "uncertain": true on that item, and name it in uncertain_fields. A wrong medicine name or dose
is far worse than a flagged one, because the patient reviews every item before it is saved.

Dates: use the date of the investigation or visit (sample collection date for lab results), not the print date, as YYYY-MM-DD.
Lab values: copy each test with its value, unit and reference range exactly as printed; fill value only when the result is numeric.`;

export class ClaudeExtractor implements Extractor {
  private client: Anthropic;
  constructor(apiKey: string | undefined, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract({ buffer, mime }: { buffer: Buffer; mime: string }): Promise<Extraction> {
    const data = buffer.toString("base64");
    const source =
      mime === "application/pdf"
        ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } } as const)
        : ({ type: "image", source: { type: "base64", media_type: mime as "image/jpeg" | "image/png" | "image/webp", data } } as const);

    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(Extraction) },
      system: SYSTEM,
      messages: [{ role: "user", content: [source, { type: "text", text: "Read this medical document." }] }],
    });

    if (res.stop_reason === "refusal") throw new ExtractionError("refused", "The document could not be read automatically. Enter it by hand.");
    if (res.stop_reason === "max_tokens") throw new ExtractionError("too_long", "The document is too long to read in one pass.");
    if (!res.parsed_output) throw new ExtractionError("unparseable");
    return res.parsed_output;
  }
}

/** Development stand-in: always returns the same sample lab result. */
export class DemoExtractor implements Extractor {
  async extract(): Promise<Extraction> {
    return {
      document_kind: "lab_result",
      investigation_date: new Date().toISOString().slice(0, 10),
      institution: "Synevo Moldova",
      doctor_name: null,
      title: "Hemoleucogramă (demo)",
      summary: "Demo reading. Set EXTRACTOR=claude and ANTHROPIC_API_KEY to read real documents.",
      transcription: "Hemoglobina 13.1 g/dL (12.0-15.5)\nGlucoza 6.3 mmol/L (3.9-5.8)",
      diagnoses: [],
      medicines: [],
      lab_values: [
        { test: "Hemoglobina", value: 13.1, value_text: "13.1", unit: "g/dL", ref_low: 12, ref_high: 15.5, uncertain: false },
        { test: "Glucoza", value: 6.3, value_text: "6.3", unit: "mmol/L", ref_low: 3.9, ref_high: 5.8, uncertain: true },
      ],
      uncertain_fields: ["Glucoza: the last digit is smudged"],
    };
  }
}
