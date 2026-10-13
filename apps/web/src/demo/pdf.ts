/** Browser port of the server's per-date PDF (apps/api/src/documents/pdf.ts) for the demo build. */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { demo, toast } from "./shim";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const KIND_LABEL: Record<string, string> = { lab_result: "Lab result", prescription: "Prescription", discharge_summary: "Discharge summary", consultation: "Consultation", imaging: "Imaging", other: "Document" };

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
    for (const para of s.split("\n"))
      for (const line of wrap(para, font, size, width)) {
        if (this.y < MARGIN + size) this.newPage();
        this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font, color: rgb(...(opts.color ?? [0.1, 0.1, 0.12])) });
        this.y -= size * 1.4;
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

const dataBytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
let fonts: Promise<[ArrayBuffer, ArrayBuffer]> | null = null;
const loadFonts = () => (fonts ??= Promise.all([fetch("fonts/DejaVuSans.ttf").then((r) => r.arrayBuffer()), fetch("fonts/DejaVuSans-Bold.ttf").then((r) => r.arrayBuffer())]));

export async function downloadDatePdf(base: string, date: string) {
  const data = demo.pdfRecords(base, date);
  if (!data || !data.records.length) return toast("No records for this date.");
  const [reg, bld] = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(reg, { subset: true });
  const bold = await pdf.embedFont(bld, { subset: true });
  pdf.setTitle(`MedData ${date}`);
  pdf.setProducer("MedData (demo)");
  const w = new Writer(pdf, font, bold);
  w.text(`Medical records of ${date}`, { size: 18, bold: true });
  if (data.who) w.text(data.who, { size: 11, color: [0.35, 0.35, 0.4] });
  w.text("Transcribed from the originals and confirmed by the patient. Original pages follow.", { size: 8, color: [0.45, 0.45, 0.5], gap: 14 });
  for (const r of data.records) {
    w.text(`${KIND_LABEL[r.kind] ?? "Document"}: ${r.title}`, { size: 13, bold: true });
    const meta = [r.institution, r.doctor_name].filter(Boolean).join(" · ");
    if (meta) w.text(meta, { size: 9, color: [0.35, 0.35, 0.4] });
    if (r.summary) w.text(r.summary, { gap: 8 });
    if (r.data.diagnoses?.length) w.text(`Diagnoses: ${r.data.diagnoses.join("; ")}`, { gap: 8 });
    if (r.data.medicines?.length) {
      w.text("Medicines", { bold: true });
      for (const m of r.data.medicines) {
        const parts = [m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(", ");
        w.text(`• ${m.name}${parts ? ` — ${parts}` : ""}${m.notes ? ` (${m.notes})` : ""}`, { gap: 1 });
      }
      w.y -= 6;
    }
    if (r.labs.length) {
      w.text("Results", { bold: true });
      for (const v of r.labs) {
        const range = v.ref_low != null || v.ref_high != null ? `  [${v.ref_low ?? ""}–${v.ref_high ?? ""}]` : "";
        const out = v.value != null && ((v.ref_low != null && v.value < v.ref_low) || (v.ref_high != null && v.value > v.ref_high));
        w.text(`${v.test}: ${v.value_text}${v.unit ? ` ${v.unit}` : ""}${range}${out ? "  ← out of range" : ""}`, { gap: 1, color: out ? [0.7, 0.1, 0.1] : undefined });
      }
      w.y -= 6;
    }
    if (r.transcription) {
      w.text("Full transcription", { bold: true, size: 9 });
      w.text(r.transcription, { size: 8.5, color: [0.25, 0.25, 0.3], gap: 16 });
    }
  }
  for (const r of data.records) {
    const o = r.original;
    if (!o?.data) continue;
    const bytes = dataBytes(o.data);
    if (o.mime === "application/pdf") {
      const src = await PDFDocument.load(bytes);
      for (const p of await pdf.copyPages(src, src.getPageIndices())) pdf.addPage(p);
      continue;
    }
    const img = o.mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const page = pdf.addPage(A4);
    const s = Math.min((A4[0] - 40) / img.width, (A4[1] - 60) / img.height, 1);
    page.drawImage(img, { x: (A4[0] - img.width * s) / 2, y: (A4[1] - img.height * s) / 2 - 10, width: img.width * s, height: img.height * s });
    page.drawText(`Original: ${o.original_name}`, { x: 20, y: A4[1] - 24, size: 8, font, color: rgb(0.45, 0.45, 0.5) });
  }
  await showPdf(await pdf.save(), `meddata-${date}.pdf`);
}

/** The demo runs in a frame where file downloads are blocked, so the PDF is rendered page by page in a viewer instead. */
async function showPdf(bytes: Uint8Array, name: string) {
  const bg = document.createElement("div");
  bg.className = "modal-bg pdf-viewer";
  bg.innerHTML = `<div class="pdf-box"><div class="pdf-head"><strong>${name}</strong><span class="small muted">This is the PDF the app generates. In the hosted app it downloads; the demo frame shows it here.</span><button class="btn sm" type="button">Close</button></div><div class="pdf-pages"></div></div>`;
  bg.querySelector("button")!.onclick = () => bg.remove();
  document.body.appendChild(bg);
  const pages = bg.querySelector(".pdf-pages")!;
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1.5 });
    const c = document.createElement("canvas");
    c.width = vp.width;
    c.height = vp.height;
    pages.appendChild(c);
    await page.render({ canvasContext: c.getContext("2d")!, viewport: vp }).promise;
  }
}
