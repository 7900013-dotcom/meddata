import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Ctx } from "../context.js";
import { many } from "../db.js";
import type { Scope } from "./service.js";

const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");
const REGULAR = readFileSync(path.join(fontsDir, "DejaVuSans.ttf"));
const BOLD = readFileSync(path.join(fontsDir, "DejaVuSans-Bold.ttf"));

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const KIND_LABEL: Record<string, string> = {
  lab_result: "Lab result",
  prescription: "Prescription",
  discharge_summary: "Discharge summary",
  consultation: "Consultation",
  imaging: "Imaging",
  other: "Document",
};

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }
  text(s: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const width = A4[0] - MARGIN * 2;
    for (const para of s.split("\n")) {
      for (const line of wrap(para, font, size, width)) {
        if (this.y < MARGIN + size) this.newPage();
        this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font, color: rgb(...(opts.color ?? [0.1, 0.1, 0.12])) });
        this.y -= size * 1.4;
      }
    }
    this.y -= opts.gap ?? 4;
  }
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/(\s+)/)) {
    const next = cur + word;
    if (font.widthOfTextAtSize(next, size) <= width) cur = next;
    else {
      if (cur.trim()) lines.push(cur.trimEnd());
      cur = word.trimStart();
      while (font.widthOfTextAtSize(cur, size) > width) {
        let i = cur.length;
        while (i > 1 && font.widthOfTextAtSize(cur.slice(0, i), size) > width) i--;
        lines.push(cur.slice(0, i));
        cur = cur.slice(i);
      }
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/**
 * One PDF for one investigation date: the transcribed, readable version of every
 * record from that day, followed by the untouched original pages.
 */
export async function buildDatePdf(ctx: Ctx, patientId: string, date: string, scope: Scope = "all"): Promise<Buffer | null> {
  const kinds = scope === "labs" ? ["lab_result"] : scope === "prescriptions" ? ["prescription"] : null;
  const records = await many(
    ctx.db,
    `SELECT r.*, d.storage_key, d.mime, d.original_name, u.first_name, u.last_name
       FROM records r JOIN documents d ON d.id = r.document_id JOIN users u ON u.id = r.patient_id
      WHERE r.patient_id = $1 AND r.investigation_date = $2 AND ($3::text[] IS NULL OR r.kind = ANY($3))
      ORDER BY r.confirmed_at`,
    [patientId, date, kinds],
  );
  if (!records.length) return null;

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(REGULAR, { subset: true });
  const bold = await pdf.embedFont(BOLD, { subset: true });
  pdf.setTitle(`MedData ${date}`);
  pdf.setProducer("MedData");

  const w = new Writer(pdf, font, bold);
  const who = [records[0].first_name, records[0].last_name].filter(Boolean).join(" ");
  w.text(`Medical records of ${date}`, { size: 18, bold: true });
  if (who) w.text(who, { size: 11, color: [0.35, 0.35, 0.4] });
  w.text("Transcribed from the originals and confirmed by the patient. Original pages follow.", { size: 8, color: [0.45, 0.45, 0.5], gap: 14 });

  for (const r of records) {
    w.text(`${KIND_LABEL[r.kind] ?? "Document"}: ${r.title}`, { size: 13, bold: true });
    const meta = [r.institution, r.doctor_name].filter(Boolean).join(" · ");
    if (meta) w.text(meta, { size: 9, color: [0.35, 0.35, 0.4] });
    if (r.summary) w.text(r.summary, { gap: 8 });
    const data = r.data ?? {};
    if (data.diagnoses?.length) w.text(`Diagnoses: ${data.diagnoses.join("; ")}`, { gap: 8 });
    if (data.medicines?.length) {
      w.text("Medicines", { bold: true });
      for (const m of data.medicines) {
        const parts = [m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(", ");
        w.text(`• ${m.name}${parts ? ` — ${parts}` : ""}${m.notes ? ` (${m.notes})` : ""}`, { gap: 1 });
      }
      w.y -= 6;
    }
    const labs = await many(ctx.db, "SELECT * FROM lab_values WHERE record_id = $1 ORDER BY test_name", [r.id]);
    if (labs.length) {
      w.text("Results", { bold: true });
      for (const v of labs) {
        const range = v.ref_low != null || v.ref_high != null ? `  [${v.ref_low ?? ""}–${v.ref_high ?? ""}]` : "";
        const out = v.value != null && ((v.ref_low != null && +v.value < +v.ref_low) || (v.ref_high != null && +v.value > +v.ref_high));
        w.text(`${v.test_name}: ${v.value_text}${v.unit ? ` ${v.unit}` : ""}${range}${out ? "  ← out of range" : ""}`, {
          gap: 1,
          color: out ? [0.7, 0.1, 0.1] : undefined,
        });
      }
      w.y -= 6;
    }
    if (r.transcription) {
      w.text("Full transcription", { bold: true, size: 9 });
      w.text(r.transcription, { size: 8.5, color: [0.25, 0.25, 0.3], gap: 16 });
    }
  }

  for (const r of records) {
    const original = await ctx.storage.get(r.storage_key);
    if (r.mime === "application/pdf") {
      const src = await PDFDocument.load(original);
      for (const p of await pdf.copyPages(src, src.getPageIndices())) pdf.addPage(p);
    } else {
      const img = r.mime === "image/png" ? await pdf.embedPng(original) : r.mime === "image/jpeg" ? await pdf.embedJpg(original) : null;
      const page = pdf.addPage(A4);
      if (!img) {
        page.drawText(`Original (${r.original_name}) is a ${r.mime} file; download it from the app.`, { x: MARGIN, y: A4[1] - MARGIN, size: 10, font });
        continue;
      }
      const s = Math.min((A4[0] - 40) / img.width, (A4[1] - 60) / img.height, 1);
      page.drawImage(img, { x: (A4[0] - img.width * s) / 2, y: (A4[1] - img.height * s) / 2 - 10, width: img.width * s, height: img.height * s });
      page.drawText(`Original: ${r.original_name}`, { x: 20, y: A4[1] - 24, size: 8, font, color: rgb(0.45, 0.45, 0.5) });
    }
  }
  return Buffer.from(await pdf.save());
}
