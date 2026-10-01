// ページの描画。画面・PNG（Canvas）と PDF（PDFKit）で同じ手順を使う。
import { ASCENT, type LoadedFont } from "./fonts";
import { lineGlyphs, type Glyph, type Label, type Line, type Page, type Rect } from "./layout";

export interface Theme {
  bg: string;
  fg: string;
  /** 罫線 */
  line: string;
  /** 選択範囲 */
  selection: string;
}

export interface Painter {
  fillRect(r: Rect, color: string): void;
  strokeRect(r: Rect, color: string, width: number): void;
  line(x0: number, y0: number, x1: number, y1: number, color: string, width: number): void;
  glyph(g: Glyph, color: string): void;
  label(l: Label, color: string): void;
}

export interface Overlay {
  selStart: number;
  selEnd: number;
  caret?: { line: Line; pos: number } | null;
  /** IME で変換中の範囲 */
  preedit?: [number, number] | null;
}

/** ページの大きさを基準にした線幅（横書きの画面表示は縦に長いので、高さは幅の 2 倍までで見る） */
const lineWidth = (page: Page) => Math.max(page.w, Math.min(page.h, page.w * 2)) / 1400;

/**
 * ページを描く。view を渡すと、その範囲（ページ内の mm）に掛からない要素は描かない。
 * 横書きの画面表示は本文全体が 1 ページなので、見えている範囲だけ描くために使う。
 */
export function drawPage(p: Painter, page: Page, pageIndex: number, theme: Theme, overlay?: Overlay, view?: Rect): void {
  const lw = lineWidth(page);
  const visible = (x: number, y: number, w: number, h: number) =>
    !view || (x + w >= view.x && x <= view.x + view.w && y + h >= view.y && y <= view.y + view.h);
  const glyphs: Glyph[] = [];
  for (const l of page.lines) {
    if (visible(l.x0, l.y0, l.x1 - l.x0, l.y1 - l.y0)) glyphs.push(...lineGlyphs(l));
  }

  p.fillRect({ x: 0, y: 0, w: page.w, h: view ? Math.min(page.h, view.y + view.h) : page.h }, theme.bg);

  if (overlay && overlay.selEnd > overlay.selStart) {
    for (const g of glyphs) {
      if (g.start >= overlay.selStart && g.end <= overlay.selEnd) {
        p.fillRect({ x: g.bx, y: g.by, w: g.bw, h: g.bh }, theme.selection);
      }
    }
  }

  for (const c of page.cells) p.strokeRect(c, theme.line, lw);
  for (const f of page.frames) p.strokeRect(f, theme.line, lw * 2.4);
  for (const r of page.rules) if (visible(r.x0, r.y, r.x1 - r.x0, 0)) p.line(r.x0, r.y, r.x1, r.y, theme.line, lw);

  for (const g of glyphs) p.glyph(g, theme.fg);
  for (const g of page.extraGlyphs) p.glyph(g, theme.fg);
  for (const l of page.labels) if (visible(l.x - l.size * 4, l.y - l.size, l.size * 8, l.size * 2)) p.label(l, theme.line);

  if (overlay?.preedit) {
    const [s, e] = overlay.preedit;
    for (const g of glyphs) {
      if (g.start < s || g.end > e) continue;
      if (g.vertical) p.line(g.bx + g.bw + lw * 2, g.by, g.bx + g.bw + lw * 2, g.by + g.bh, theme.fg, lw * 1.5);
      else p.line(g.bx, g.by + g.bh, g.bx + g.bw, g.by + g.bh, theme.fg, lw * 1.5);
    }
  }

  const c = overlay?.caret;
  if (c && c.line.page === pageIndex) {
    const l = c.line;
    if (l.geom.vertical) {
      const pad = (l.x1 - l.x0) * 0.12;
      p.line(l.x0 + pad, c.pos, l.x1 - pad, c.pos, theme.fg, lw * 1.8);
    } else {
      const pad = (l.y1 - l.y0) * 0.18;
      p.line(c.pos, l.y0 + pad, c.pos, l.y1 - pad, theme.fg, lw * 1.8);
    }
  }
}

/** Canvas 用。ctx には mm 単位の座標変換を設定しておく */
export class CanvasPainter implements Painter {
  constructor(
    private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    private font: LoadedFont,
  ) {}

  fillRect(r: Rect, color: string) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  strokeRect(r: Rect, color: string, width: number) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    this.ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string, width: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  glyph(g: Glyph, color: string) {
    this.drawShape(g.ch, g.vertical, g.x, g.y, g.size, color);
  }

  label(l: Label, color: string) {
    let w = 0;
    for (const ch of l.text) w += this.font.measure(ch) * l.size;
    let x = l.align === "left" ? l.x : l.align === "right" ? l.x - w : l.x - w / 2;
    for (const ch of l.text) {
      this.drawShape(ch, false, x, l.y - l.size / 2, l.size, color);
      x += this.font.measure(ch) * l.size;
    }
  }

  private drawShape(ch: string, vertical: boolean, x: number, y: number, size: number, color: string) {
    const ctx = this.ctx;
    const s = size / this.font.upm;
    ctx.save();
    ctx.translate(x, y + ASCENT * size);
    ctx.scale(s, -s);
    ctx.fillStyle = color;
    ctx.fill(this.font.shape(ch, vertical).path);
    ctx.restore();
  }
}
