// 組版処理。画面表示・PDF・PNG で同じ結果を使う。座標の単位はすべて mm。
//
// 長い本文でも入力のたびに全体を組み直さずに済むよう、2 段階に分けている。
// 1. 段落ごとの組版（行分け・禁則・行内の相対位置）。段落は改行で区切られ、互いの組み方に
//    影響しないので、段落の文字列をキーにキャッシュする（LayoutEngine）。
// 2. 全体の組み立て。各行にページと原点を割り当てるだけで、字ごとの処理はしない。
//    字の絶対座標は描画時に lineGlyphs() で見える行の分だけ求める。
import { isClosing, isHanging, isLineHeadProhibited, isOpening, splitChars, toFullWidth } from "./text";

export type Mode = "genko" | "vertical" | "horizontal";
export type Paper = "B4" | "A4";

/** 描画用の字（絶対座標） */
export interface Glyph {
  /** 表示する文字（全角変換後） */
  ch: string;
  vertical: boolean;
  /** 字面の枠（em box）の左上 */
  x: number;
  y: number;
  size: number;
  /** 選択範囲の表示に使う枠 */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** 元の本文上の範囲（UTF-16） */
  start: number;
  end: number;
}

/** 段落内の字（行内の相対位置） */
interface RelGlyph {
  ch: string;
  /** 行方向の位置（縦組はマス単位、横組は mm） */
  pos: number;
  /** 送り幅（横組のみ、mm） */
  adv: number;
  /** 行方向のずらし量（マス単位。句点と同じマスに入れる閉じ括弧に使う） */
  shift: number;
  /** 段落の先頭からの位置 */
  start: number;
  end: number;
}

export interface Caret {
  /** 段落の先頭からの位置 */
  offset: number;
  /** 行方向の位置（縦組はマス単位、横組は mm） */
  pos: number;
}

/** 段落の中の 1 行。同じ文字列の段落どうしで共有される */
interface ParaLine {
  glyphs: RelGlyph[];
  carets: Caret[];
}

/** 形式ごとに共通の行の寸法 */
interface LineGeom {
  vertical: boolean;
  /** 行方向の 1 単位の長さ（縦組は 1 マスの長さ、横組は 1） */
  unit: number;
  /** 字の大きさ */
  size: number;
  /** 行の太さ（縦組の 1 マスの幅、横組の行の高さ） */
  thickness: number;
}

export interface Line {
  index: number;
  page: number;
  /** 行の原点（縦組は行の左上、横組は本文の左端と行の上端） */
  ox: number;
  oy: number;
  /** 行の帯。クリック判定とカーソル表示に使う */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** この行が属する段落の本文上の先頭位置 */
  base: number;
  /** 本文上で、この行の最初と最後のカーソル位置 */
  first: number;
  last: number;
  geom: LineGeom;
  src: ParaLine;
}

export interface Label {
  text: string;
  x: number;
  y: number;
  size: number;
  align: "left" | "right" | "center";
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Page {
  w: number;
  h: number;
  lines: Line[];
  /** 題名など、本文以外の文字 */
  extraGlyphs: Glyph[];
  /** 原稿用紙のマス */
  cells: Rect[];
  /** 太い枠線 */
  frames: Rect[];
  /** 罫線（横書き） */
  rules: { x0: number; x1: number; y: number }[];
  labels: Label[];
}

export interface Layout {
  mode: Mode;
  pages: Page[];
  /** 本文の順に並んだ全行 */
  lines: Line[];
}

/** 文字の送り幅（em 単位）を返す関数 */
export type Measure = (ch: string) => number;

// ---------------------------------------------------------------------------
// 段落ごとの組版

/** 1 マス 1 文字で組む縦組（原稿用紙・マス目なし縦書き）の段落 */
function gridParagraph(text: string, cols: number): ParaLine[] {
  const lines: ParaLine[] = [];
  let cur!: ParaLine;
  let row = 0;
  // 直前に置いた字（句点＋閉じ括弧を 1 マスに収めるため）
  let last: { glyph: RelGlyph; ch: string; line: ParaLine; combined: boolean } | null = null;

  const newLine = () => {
    cur = { glyphs: [], carets: [] };
    lines.push(cur);
    row = 0;
  };

  newLine();
  for (const { ch, start, end } of splitChars(text)) {
    const d = toFullWidth(ch);

    // 「。」」のように句読点の直後の閉じ括弧は同じマスに入れる
    if (isClosing(d) && last && last.line === cur && !last.combined && isHanging(last.ch)) {
      const r = last.glyph.pos;
      addCaret(cur, start, r + 0.5);
      cur.glyphs.push({ ch: d, pos: r, adv: 1, shift: 0.4, start, end });
      addCaret(cur, end, r + 1);
      last.combined = true;
      continue;
    }

    if (row >= cols) {
      // 行頭禁則の文字は 1 字だけ枠外へぶら下げる
      if (!(row === cols && isLineHeadProhibited(d))) newLine();
    } else if (row === cols - 1 && isOpening(d)) {
      // 行末禁則：開き括弧は次の行へ送る
      newLine();
    }
    addCaret(cur, start, row);
    const g: RelGlyph = { ch: d, pos: row, adv: 1, shift: 0, start, end };
    cur.glyphs.push(g);
    row++;
    addCaret(cur, end, row);
    last = { glyph: g, ch: d, line: cur, combined: false };
  }
  addCaret(cur, text.length, row);
  return lines;
}

/** 横組の段落 */
function horizontalParagraph(text: string, width: number, size: number, measure: Measure): ParaLine[] {
  const lines: ParaLine[] = [];
  let cur!: ParaLine;
  let x = 0;
  let hung = false;
  const chars = splitChars(text);

  const newLine = () => {
    cur = { glyphs: [], carets: [] };
    lines.push(cur);
    x = 0;
    hung = false;
  };

  newLine();
  for (let k = 0; k < chars.length; k++) {
    const { ch, start, end } = chars[k];
    const adv = measure(ch) * size;
    if (x + adv > width + 1e-6 && x > 0) {
      // 行頭禁則の文字は 1 字だけ行末からぶら下げる
      if (isLineHeadProhibited(ch) && !hung) hung = true;
      else newLine();
    } else if (isOpening(ch) && x > 0) {
      // 行末禁則：開き括弧の後ろに 1 字も入らないなら次の行へ送る
      const next = chars[k + 1];
      if (next && x + adv + measure(next.ch) * size > width + 1e-6) newLine();
    }
    addCaret(cur, start, x);
    cur.glyphs.push({ ch, pos: x, adv, shift: 0, start, end });
    x += adv;
    addCaret(cur, end, x);
  }
  addCaret(cur, text.length, x);
  return lines;
}

function addCaret(line: ParaLine, offset: number, pos: number) {
  const cs = line.carets;
  if (cs.length && cs[cs.length - 1].offset === offset) cs[cs.length - 1].pos = pos;
  else cs.push({ offset, pos });
}

// ---------------------------------------------------------------------------
// 全体の組み立て

/**
 * 段落の組版結果をキャッシュしながら全体を組む。
 * 入力のたびに同じインスタンスを使えば、変わった段落だけが組み直される。
 */
export class LayoutEngine {
  private cache = new Map<string, ParaLine[]>();
  private cacheKey = "";

  /** 本文を段落に分け、段落ごとの組版結果を返す */
  private paragraphs(text: string, key: string, fn: (p: string) => ParaLine[]): { text: string; base: number; lines: ParaLine[] }[] {
    if (key !== this.cacheKey) {
      this.cache.clear();
      this.cacheKey = key;
    }
    // 今回使った段落だけを残し、古い版の段落はキャッシュから外す
    const next = new Map<string, ParaLine[]>();
    const out: { text: string; base: number; lines: ParaLine[] }[] = [];
    let base = 0;
    for (const p of text.split("\n")) {
      let lines = next.get(p) ?? this.cache.get(p);
      if (!lines) lines = fn(p);
      next.set(p, lines);
      out.push({ text: p, base, lines });
      base += p.length + 1;
    }
    this.cache = next;
    return out;
  }

  private assembleGrid(text: string, mode: Mode, p: GridParams): Layout {
    const geom: LineGeom = { vertical: true, unit: p.pitch, size: p.glyphSize, thickness: p.lineW };
    const pages: Page[] = [];
    const lines: Line[] = [];
    const ensurePage = (i: number) => {
      while (pages.length <= i) {
        const pg = newPage(p.pageW, p.pageH);
        p.decorate(pg, pages.length);
        pages.push(pg);
      }
    };
    for (const para of this.paragraphs(text, `grid:${p.cols}`, (s) => gridParagraph(s, p.cols))) {
      for (const src of para.lines) {
        const index = lines.length;
        const page = Math.floor(index / p.linesPerPage);
        ensurePage(page);
        const x = p.lineX(index % p.linesPerPage);
        const line: Line = {
          index,
          page,
          ox: x,
          oy: p.top,
          x0: x - p.lineBandPad,
          x1: x + p.lineW + p.lineBandPad,
          y0: p.top,
          y1: p.top + p.pitch * (p.cols + 1),
          base: para.base,
          first: para.base + src.carets[0].offset,
          last: para.base + src.carets[src.carets.length - 1].offset,
          geom,
          src,
        };
        lines.push(line);
        pages[page].lines.push(line);
      }
    }
    ensurePage(0);
    return { mode, pages, lines };
  }

  genko(text: string, paper: Paper, title: string): Layout {
    return this.assembleGrid(text, "genko", genkoParams(paper, title));
  }

  vertical(text: string): Layout {
    return this.assembleGrid(text, "vertical", verticalParams());
  }

  /** fontKey は measure の元になったフォント（キャッシュの区別に使う） */
  horizontal(text: string, p: HorizontalParams, measure: Measure, fontKey: string): Layout {
    const width = p.pageW - p.marginL - p.marginR;
    const lpp = Number.isFinite(p.pageH) ? Math.max(1, Math.floor((p.pageH - p.marginT - p.marginB) / p.pitch)) : Infinity;
    const geom: LineGeom = { vertical: false, unit: 1, size: p.size, thickness: p.pitch };
    const pages: Page[] = [];
    const lines: Line[] = [];
    const ensurePage = (i: number) => {
      while (pages.length <= i) pages.push(newPage(p.pageW, p.pageH));
    };
    const key = `h:${width.toFixed(3)}:${p.size}:${fontKey}`;
    for (const para of this.paragraphs(text, key, (s) => horizontalParagraph(s, width, p.size, measure))) {
      for (const src of para.lines) {
        const index = lines.length;
        const page = Number.isFinite(lpp) ? Math.floor(index / lpp) : 0;
        ensurePage(page);
        const y = p.marginT + (Number.isFinite(lpp) ? index % lpp : index) * p.pitch;
        const line: Line = {
          index,
          page,
          ox: p.marginL,
          oy: y,
          x0: 0,
          x1: p.pageW,
          y0: y,
          y1: y + p.pitch,
          base: para.base,
          first: para.base + src.carets[0].offset,
          last: para.base + src.carets[src.carets.length - 1].offset,
          geom,
          src,
        };
        lines.push(line);
        pages[page].lines.push(line);
      }
    }
    ensurePage(0);

    // 罫線と 10 行ごとの行番号
    const total = Math.max(lines.length, p.minLines ?? 0);
    const rulesPerPage = Number.isFinite(lpp) ? lpp : total;
    pages.forEach((pg, pi) => {
      for (let i = 0; i < rulesPerPage; i++) {
        const n = pi * rulesPerPage + i + 1; // 通し行番号
        const y = p.marginT + (i + 1) * p.pitch;
        pg.rules.push({ x0: p.marginL, x1: p.pageW - p.marginR, y });
        if (n % 10 === 0) {
          pg.labels.push({ text: String(n), x: p.marginL - p.size * 0.6, y: y - p.pitch * 0.3, size: p.size * 0.5, align: "right" });
        }
      }
      if (!Number.isFinite(p.pageH)) pg.h = p.marginT + total * p.pitch + p.marginB;
    });
    return { mode: "horizontal", pages, lines };
  }
}

function newPage(w: number, h: number): Page {
  return { w, h, lines: [], extraGlyphs: [], cells: [], frames: [], rules: [], labels: [] };
}

/** 行の字を絶対座標で返す */
export function lineGlyphs(line: Line): Glyph[] {
  const { vertical, unit, size, thickness } = line.geom;
  return line.src.glyphs.map((g) => {
    if (vertical) {
      const cellY = line.oy + g.pos * unit;
      return {
        ch: g.ch,
        vertical,
        x: line.ox + (thickness - size) / 2,
        y: cellY + (unit - size) / 2 + g.shift * unit,
        size,
        bx: line.ox,
        by: cellY,
        bw: thickness,
        bh: unit,
        start: line.base + g.start,
        end: line.base + g.end,
      };
    }
    const x = line.ox + g.pos;
    const y = line.oy + (thickness - size) / 2;
    return {
      ch: g.ch,
      vertical,
      x,
      y,
      size,
      bx: x,
      by: y - size * 0.15,
      bw: g.adv,
      bh: size * 1.3,
      start: line.base + g.start,
      end: line.base + g.end,
    };
  });
}

// ---------------------------------------------------------------------------
// 形式ごとの寸法

interface GridParams {
  pageW: number;
  pageH: number;
  cols: number;
  linesPerPage: number;
  /** 行の左端の x（ページ内の行番号から） */
  lineX: (i: number) => number;
  /** 行の太さ（字の送り方向と直交する方向） */
  lineW: number;
  /** クリック判定用に行の帯を左右に広げる量 */
  lineBandPad: number;
  top: number;
  /** 1 マスの長さ（字送り） */
  pitch: number;
  glyphSize: number;
  decorate: (page: Page, pageIndex: number) => void;
}

/** 原稿用紙（20 字 × 20 行、中央に柱） */
export const PAPER_SIZE: Record<Paper, { w: number; h: number }> = {
  B4: { w: 364, h: 257 },
  A4: { w: 297, h: 210 },
};

function genkoParams(paper: Paper, title: string): GridParams {
  const { w: W, h: H } = PAPER_SIZE[paper];
  const f = W / 364; // B4 横を基準に拡大縮小
  const CELL = 11 * f;
  const GUT = 3.5 * f; // 行間（ルビ用の余白）
  const PILLAR = 16 * f;
  const PITCH = CELL + GUT;
  const gridW = PITCH * 20 + PILLAR;
  const gridH = CELL * 20;
  const top = (H - gridH) / 2;
  const right = (W - gridW) / 2;
  const lineX = (i: number) => W - right - GUT / 2 - i * PITCH - (i >= 10 ? PILLAR : 0) - CELL;
  const pillarX = W - right - 10 * PITCH - PILLAR;

  // マス目は全ページ共通なので 1 つの配列を共有する
  const cells: Rect[] = [];
  for (let i = 0; i < 20; i++) {
    for (let r = 0; r < 20; r++) cells.push({ x: lineX(i), y: top + r * CELL, w: CELL, h: CELL });
  }
  cells.push({ x: pillarX, y: top, w: PILLAR, h: gridH });
  const frames: Rect[] = [{ x: right, y: top, w: gridW, h: gridH }];

  const decorate = (pg: Page, pageIndex: number) => {
    pg.cells = cells;
    pg.frames = frames;
    if (pageIndex === 0 && title) {
      // 題名はマス目の外、右の余白に縦書きで置く
      const size = CELL * 0.8;
      const x = W - right / 2 - size / 2;
      let y = top + CELL;
      for (const { ch } of splitChars(title)) {
        if (y + size > top + gridH) break;
        pg.extraGlyphs.push({ ch: toFullWidth(ch), vertical: true, x, y, size, bx: x, by: y, bw: size, bh: size, start: -1, end: -1 });
        y += size * 1.05;
      }
    }
    pg.labels.push({ text: String(pageIndex + 1), x: W / 2, y: H - top / 2 + 1.5 * f, size: 3.2 * f, align: "center" });
  };

  return {
    pageW: W,
    pageH: H,
    cols: 20,
    linesPerPage: 20,
    lineX,
    lineW: CELL,
    lineBandPad: GUT / 2,
    top,
    pitch: CELL,
    glyphSize: CELL * 0.78,
    decorate,
  };
}

/** マス目なし縦書き（文庫本程度：38 字 × 16 行、A6 判） */
export const BUNKO = { w: 105, h: 148 };

function verticalParams(): GridParams {
  const { w: W, h: H } = BUNKO;
  const S = 3.15;
  const PITCH = S * 1.7;
  const cols = 38;
  const lpp = 16;
  const blockW = PITCH * (lpp - 1) + S;
  const right = (W - blockW) / 2;
  const top = (H - cols * S) / 2;
  return {
    pageW: W,
    pageH: H,
    cols,
    linesPerPage: lpp,
    lineX: (i) => W - right - S - i * PITCH,
    lineW: S,
    lineBandPad: (PITCH - S) / 2,
    top,
    pitch: S,
    glyphSize: S,
    decorate: (pg, i) => pg.labels.push({ text: String(i + 1), x: W / 2, y: H - top / 2 + 1, size: 2.4, align: "center" }),
  };
}

/** 行のみ表示の横書き */
export interface HorizontalParams {
  pageW: number;
  /** ページの高さ。画面表示では Infinity（ページ区切りなし） */
  pageH: number;
  marginL: number;
  marginR: number;
  marginT: number;
  marginB: number;
  size: number;
  pitch: number;
  /** 画面表示で、本文が短くても罫線を引いておく最低行数 */
  minLines?: number;
}

/** 横書きの PDF・画像出力用（A4 縦） */
export const HORIZONTAL_PRINT: HorizontalParams = {
  pageW: 210,
  pageH: 297,
  marginL: 22,
  marginR: 20,
  marginT: 22,
  marginB: 22,
  size: 3.7,
  pitch: 3.7 * 1.9,
};

// ---------------------------------------------------------------------------
// カーソル位置・クリック位置の計算

/** カーソルの行方向の絶対座標 */
function caretPos(line: Line, c: Caret): number {
  return (line.geom.vertical ? line.oy : line.ox) + c.pos * line.geom.unit;
}

export function caretAt(layout: Layout, offset: number): { line: Line; pos: number } | null {
  // offset を含む最後の行（行の境目では次の行の先頭にカーソルを出す）を二分探索で探す
  const lines = layout.lines;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].first <= offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const line = lines[found];
  const rel = offset - line.base;
  const c = line.src.carets.find((c) => c.offset === rel);
  return c ? { line, pos: caretPos(line, c) } : null;
}

/** 行の中で、行方向の絶対座標 pos に最も近いカーソル位置（本文上の位置） */
export function nearestInLine(line: Line, pos: number): number {
  let best = line.first;
  let bestD = Infinity;
  for (const c of line.src.carets) {
    const d = Math.abs(caretPos(line, c) - pos);
    if (d < bestD) {
      bestD = d;
      best = line.base + c.offset;
    }
  }
  return best;
}

/** ページ内の点 (x, y) に最も近いカーソル位置 */
export function hitTest(layout: Layout, pageIndex: number, x: number, y: number): number | null {
  const page = layout.pages[pageIndex];
  if (!page || page.lines.length === 0) {
    // 空のページ：最終行の末尾
    const last = layout.lines[layout.lines.length - 1];
    return last ? last.last : 0;
  }
  let best: Line | null = null;
  let bestD = Infinity;
  for (const l of page.lines) {
    const d = l.geom.vertical ? distTo(x, l.x0, l.x1) : distTo(y, l.y0, l.y1);
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  if (!best) return null;
  return nearestInLine(best, best.geom.vertical ? y : x);
}

const distTo = (v: number, a: number, b: number) => (v < a ? a - v : v > b ? v - b : 0);
