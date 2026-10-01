// PDF・画像（PNG / JPEG を zip にまとめる）の生成。画面と同じ組版結果を、画面と同じ手順（drawPage）で描く。
// DOM を使わないので Web Worker の中で動かせる（export.worker.ts から呼ぶ）。
import { ASCENT, type LoadedFont } from "./fonts";
import { LayoutEngine, type Glyph, type Label, type Layout, type Rect } from "./layout";
import { imageSize, JPEG_QUALITY, printLayout, representativePage, type OutputSource } from "./output";
import { CanvasPainter, drawPage, type Painter, type Theme } from "./paint";
import { themeOf, type Settings } from "./settings";

const MM = 72 / 25.4;

export type ExportKind = "pdf" | "image";


export type RenderInput = OutputSource;

/** 進み具合（done ページ / 全 total ページ） */
export type Progress = (done: number, total: number) => void;

export interface RenderResult {
  blob: Blob;
  fileName: string;
}

const layoutFor = (input: RenderInput, font: LoadedFont): Layout => printLayout(new LayoutEngine(), input, font.measure, font.family);

function baseName(title: string): string {
  const t = title.trim().replace(/[\\/:*?"<>|]/g, "_");
  return t || "原稿";
}

// ---------------------------------------------------------------------------
// PDF

// PDFKit の型定義は使わず、必要な範囲だけ宣言する
interface PdfDoc {
  addPage(opts: object): PdfDoc;
  scale(s: number): PdfDoc;
  rect(x: number, y: number, w: number, h: number): PdfDoc;
  moveTo(x: number, y: number): PdfDoc;
  lineTo(x: number, y: number): PdfDoc;
  lineWidth(w: number): PdfDoc;
  fill(color: string): PdfDoc;
  stroke(color: string): PdfDoc;
  fillColor(color: string): PdfDoc;
  font(name: string): PdfDoc;
  fontSize(size: number): PdfDoc;
  registerFont(name: string, src: Uint8Array): PdfDoc;
  text(s: string, x: number, y: number, opts: object): PdfDoc;
  on(ev: string, f: (chunk?: Uint8Array) => void): void;
  end(): void;
}

class PdfPainter implements Painter {
  constructor(
    private doc: PdfDoc,
    private font: LoadedFont,
  ) {}

  fillRect(r: Rect, color: string) {
    this.doc.rect(r.x, r.y, r.w, r.h).fill(color);
  }

  strokeRect(r: Rect, color: string, width: number) {
    this.doc.lineWidth(width).rect(r.x, r.y, r.w, r.h).stroke(color);
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string, width: number) {
    this.doc.lineWidth(width).moveTo(x0, y0).lineTo(x1, y1).stroke(color);
  }

  glyph(g: Glyph, color: string) {
    this.text(g.ch, g.vertical, g.x, g.y, g.size, color);
  }

  label(l: Label, color: string) {
    let w = 0;
    for (const ch of l.text) w += this.font.measure(ch) * l.size;
    const x = l.align === "left" ? l.x : l.align === "right" ? l.x - w : l.x - w / 2;
    this.text(l.text, false, x, l.y - l.size / 2, l.size, color);
  }

  private text(s: string, vertical: boolean, x: number, y: number, size: number, color: string) {
    this.doc
      .fontSize(size)
      .fillColor(color)
      .text(s, x, y + ASCENT * size, { baseline: "alphabetic", lineBreak: false, features: vertical ? ["vert"] : [] });
  }
}

export async function renderPdf(input: RenderInput, font: LoadedFont, progress: Progress): Promise<RenderResult> {
  const { default: PDFDocument } = await import("pdfkit");
  const layout = layoutFor(input, font);
  // ブラウザ版の PDFKit は標準フォント（Helvetica）を持たないので、既定のフォントを最初から渡す
  const doc = new PDFDocument({
    autoFirstPage: false,
    margin: 0,
    font: font.data,
    info: { Title: input.title || "原稿" },
  }) as unknown as PdfDoc;
  const chunks: Uint8Array[] = [];
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  doc.on("data", (c) => chunks.push(c!));

  doc.registerFont("main", font.data);
  const theme = themeOf(input.settings);
  const painter = new PdfPainter(doc, font);
  const total = layout.pages.length;
  layout.pages.forEach((page, i) => {
    doc.addPage({ size: [page.w * MM, page.h * MM], margin: 0 });
    doc.scale(MM);
    doc.font("main");
    drawPage(painter, page, i, theme);
    progress(i + 1, total);
  });
  doc.end();
  await done;
  return {
    blob: new Blob(chunks as BlobPart[], { type: "application/pdf" }),
    fileName: `${baseName(input.title)}.pdf`,
  };
}

// ---------------------------------------------------------------------------
// 画像（1 ページ 1 枚を zip にまとめる。形式は設定の imageFormat、解像度は imageQuality）

export async function renderImageZip(input: RenderInput, font: LoadedFont, progress: Progress): Promise<RenderResult> {
  const { zipSync } = await import("fflate");
  const layout = layoutFor(input, font);
  const theme = themeOf(input.settings);
  const name = baseName(input.title);
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  const total = layout.pages.length;
  const digits = String(total).length;
  const ext = input.settings.imageFormat === "jpeg" ? "jpg" : "png";

  for (let i = 0; i < total; i++) {
    const blob = await renderPageImage(layout, i, font, input.settings, theme);
    const n = String(i + 1).padStart(Math.max(3, digits), "0");
    files[`${name}-${n}.${ext}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
    progress(i + 1, total);
  }
  const zip = zipSync(files);
  return { blob: new Blob([zip as BlobPart], { type: "application/zip" }), fileName: `${name}.zip` };
}

async function renderPageImage(layout: Layout, i: number, font: LoadedFont, settings: Settings, theme: Theme): Promise<Blob> {
  const page = layout.pages[i];
  const { w, h } = imageSize(page.w, page.h, settings.imageQuality);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(w / page.w, 0, 0, h / page.h, 0, 0);
  drawPage(new CanvasPainter(ctx, font), page, i, theme);
  return canvas.convertToBlob(settings.imageFormat === "jpeg" ? { type: "image/jpeg", quality: JPEG_QUALITY } : { type: "image/png" });
}

/** 容量の目安用に、代表ページ 1 枚を画像にした大きさ（バイト）を返す */
export async function measureImagePage(input: RenderInput, font: LoadedFont): Promise<number> {
  const layout = layoutFor(input, font);
  const blob = await renderPageImage(layout, representativePage(layout), font, input.settings, themeOf(input.settings));
  return blob.size;
}
