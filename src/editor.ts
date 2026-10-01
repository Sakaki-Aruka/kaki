// エディタ本体：Canvas への描画、入力（IME を含む）、カーソル・選択、元に戻す
import type { LoadedFont } from "./fonts";
import { History, type Snapshot } from "./history";
import {
  BUNKO,
  PAPER_SIZE,
  caretAt,
  hitTest,
  LayoutEngine,
  nearestInLine,
  type HorizontalParams,
  type Layout,
} from "./layout";
import { CanvasPainter, drawPage } from "./paint";
import { themeOf, type Settings } from "./settings";
import { nextOffset, prevOffset } from "./text";

/** 画面表示用の横書きの寸法（mm）。文字サイズは拡大率で変える */
const H_SIZE = 4.2;
const PAGE_GAP = 28; // px

interface PageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditorCallbacks {
  onChange(): void;
}

export class Editor {
  text = "";
  title = "";
  settings: Settings;
  font: LoadedFont;

  private anchor = 0;
  private focus = 0;
  private preedit = "";
  private composing = false;
  /** 上下（縦組では左右）に行を移るときに保つ行方向の位置 */
  private goalPos: number | null = null;

  private history = new History();
  /** 段落ごとの組版結果を持ち回り、変わった段落だけを組み直す */
  private engine = new LayoutEngine();
  layout!: Layout;
  private boxes: PageBox[] = [];
  private scale = 1;
  private contentW = 0;
  private contentH = 0;

  private root: HTMLElement;
  private scroller: HTMLDivElement;
  private spacer: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ta: HTMLTextAreaElement;
  private caretVisible = true;
  private blinkTimer = 0;
  private drawQueued = false;
  private dragging = false;

  constructor(root: HTMLElement, font: LoadedFont, settings: Settings, private cb: EditorCallbacks) {
    this.root = root;
    this.font = font;
    this.settings = settings;
    root.classList.add("editor");
    root.innerHTML = "";

    this.scroller = document.createElement("div");
    this.scroller.className = "editor-scroller";
    this.spacer = document.createElement("div");
    this.spacer.className = "editor-spacer";
    this.scroller.append(this.spacer);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "editor-canvas";
    this.ctx = this.canvas.getContext("2d")!;

    this.ta = document.createElement("textarea");
    this.ta.className = "editor-input";
    this.ta.setAttribute("autocomplete", "off");
    this.ta.setAttribute("autocorrect", "off");
    this.ta.setAttribute("spellcheck", "false");
    this.ta.setAttribute("aria-label", "本文");

    root.append(this.canvas, this.scroller, this.ta);

    this.bindInput();
    this.bindMouse();
    this.scroller.addEventListener("scroll", () => this.requestDraw());
    new ResizeObserver(() => this.relayout()).observe(this.scroller);
    this.relayout();
    this.startBlink();
  }

  // -------------------------------------------------------------------------
  // 外から使う操作

  get selStart() {
    return Math.min(this.anchor, this.focus);
  }
  get selEnd() {
    return Math.max(this.anchor, this.focus);
  }

  setDocument(title: string, text: string) {
    this.title = title;
    this.text = text;
    this.anchor = this.focus = text.length;
    this.relayout();
    this.scrollToCaret();
  }

  setTitle(title: string) {
    this.title = title;
    this.relayout();
  }

  setSettings(s: Settings) {
    const modeChanged = s.mode !== this.settings.mode;
    this.settings = s;
    this.relayout();
    if (modeChanged) this.scrollToCaret(true);
  }

  setFont(font: LoadedFont) {
    this.font = font;
    this.relayout();
  }

  focusInput() {
    this.ta.focus({ preventScroll: true });
  }

  undo() {
    const s = this.history.undo(this.snapshot());
    if (s) this.restore(s);
  }

  redo() {
    const s = this.history.redo(this.snapshot());
    if (s) this.restore(s);
  }

  // -------------------------------------------------------------------------
  // 組版と配置

  /** 表示中の本文（変換中の文字を含む） */
  private displayText(): string {
    if (!this.preedit) return this.text;
    return this.text.slice(0, this.selStart) + this.preedit + this.text.slice(this.selEnd);
  }

  private horizontalParams(viewW: number, viewH: number): HorizontalParams {
    const pitch = H_SIZE * 1.9;
    const s = this.settings.hFontPx / H_SIZE;
    return {
      pageW: viewW / s,
      pageH: Infinity,
      marginL: H_SIZE * 3.2,
      marginR: H_SIZE * 1.5,
      marginT: H_SIZE * 1.2,
      marginB: H_SIZE * 4,
      size: H_SIZE,
      pitch,
      minLines: Math.ceil(viewH / s / pitch),
    };
  }

  relayout() {
    const viewW = this.scroller.clientWidth;
    const viewH = this.scroller.clientHeight;
    if (viewW === 0 || viewH === 0) return;
    const text = this.displayText();
    const { mode, paper, zoom } = this.settings;

    if (mode === "genko") {
      this.layout = this.engine.genko(text, paper, this.title);
      const pw = PAPER_SIZE[paper].w;
      this.scale = (Math.max(320, viewW - PAGE_GAP * 2) / pw) * zoom;
    } else if (mode === "vertical") {
      this.layout = this.engine.vertical(text);
      this.scale = (Math.max(240, viewH - PAGE_GAP * 2) / BUNKO.h) * zoom;
    } else {
      this.scale = this.settings.hFontPx / H_SIZE;
      this.layout = this.engine.horizontal(text, this.horizontalParams(viewW, viewH), this.font.measure, this.font.family);
    }

    // ページの配置（px）
    const s = this.scale;
    const pages = this.layout.pages;
    this.boxes = [];
    if (mode === "genko") {
      const pw = pages[0].w * s;
      const ph = pages[0].h * s;
      this.contentW = Math.max(viewW, pw + PAGE_GAP * 2);
      this.contentH = pages.length * (ph + PAGE_GAP) + PAGE_GAP;
      pages.forEach((_, i) => this.boxes.push({ x: (this.contentW - pw) / 2, y: PAGE_GAP + i * (ph + PAGE_GAP), w: pw, h: ph }));
    } else if (mode === "vertical") {
      // 右から左へ並べる。ページ全体が画面より狭いときは、左右の余白が均等になるよう中央に寄せる
      const pw = pages[0].w * s;
      const ph = pages[0].h * s;
      const pagesW = pages.length * (pw + PAGE_GAP) + PAGE_GAP;
      this.contentW = Math.max(viewW, pagesW);
      this.contentH = Math.max(viewH, ph + PAGE_GAP * 2);
      const right = this.contentW - (this.contentW - pagesW) / 2;
      pages.forEach((_, i) =>
        this.boxes.push({ x: right - (i + 1) * (pw + PAGE_GAP), y: (this.contentH - ph) / 2, w: pw, h: ph }),
      );
    } else {
      const pg = pages[0];
      this.contentW = viewW;
      this.contentH = pg.h * s;
      this.boxes.push({ x: 0, y: 0, w: pg.w * s, h: pg.h * s });
    }
    this.spacer.style.width = `${this.contentW}px`;
    this.spacer.style.height = `${this.contentH}px`;

    // canvas の大きさを設定すると中身が作り直されるので、変わったときだけにする
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(viewW * dpr);
    const ch = Math.round(viewH * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.style.width = `${viewW}px`;
      this.canvas.style.height = `${viewH}px`;
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.root.dataset.mode = mode;
    this.draw();
  }

  // -------------------------------------------------------------------------
  // 描画

  private requestDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const sl = this.scroller.scrollLeft;
    const st = this.scroller.scrollTop;
    const vw = this.scroller.clientWidth;
    const vh = this.scroller.clientHeight;
    const theme = themeOf(this.settings);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.root).getPropertyValue("--desk").trim() || "#888";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const caretOffset = this.preedit ? this.selStart + this.preedit.length : this.focus;
    const caret = this.caretVisible && document.activeElement === this.ta ? caretAt(this.layout, caretOffset) : null;
    const painter = new CanvasPainter(ctx, this.font);
    this.boxes.forEach((b, i) => {
      if (b.x - sl > vw || b.x + b.w - sl < 0 || b.y - st > vh || b.y + b.h - st < 0) return;
      ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * (b.x - sl), dpr * (b.y - st));
      const s = this.scale;
      const view = { x: (sl - b.x) / s, y: (st - b.y) / s, w: vw / s, h: vh / s };
      drawPage(
        painter,
        this.layout.pages[i],
        i,
        theme,
        {
          selStart: this.preedit ? 0 : this.selStart,
          selEnd: this.preedit ? 0 : this.selEnd,
          caret,
          preedit: this.preedit ? [this.selStart, this.selStart + this.preedit.length] : null,
        },
        view,
      );
    });
    this.placeInput();
  }

  private startBlink() {
    clearInterval(this.blinkTimer);
    this.caretVisible = true;
    this.blinkTimer = window.setInterval(() => {
      this.caretVisible = !this.caretVisible;
      this.requestDraw();
    }, 530);
  }

  /** カーソルの画面上の位置（scroller の表示領域基準の px） */
  private caretRect(): { x: number; y: number; w: number; h: number } | null {
    const offset = this.preedit ? this.selStart + this.preedit.length : this.focus;
    const c = caretAt(this.layout, offset);
    if (!c) return null;
    const b = this.boxes[c.line.page];
    if (!b) return null;
    const s = this.scale;
    const l = c.line;
    const sl = this.scroller.scrollLeft;
    const st = this.scroller.scrollTop;
    if (l.geom.vertical) return { x: b.x + l.x0 * s - sl, y: b.y + c.pos * s - st, w: (l.x1 - l.x0) * s, h: 2 };
    return { x: b.x + c.pos * s - sl, y: b.y + l.y0 * s - st, w: 2, h: (l.y1 - l.y0) * s };
  }

  /** IME の候補ウィンドウがカーソルの近くに出るよう、入力欄をカーソル位置へ動かす */
  private placeInput() {
    const r = this.caretRect();
    if (!r) return;
    const vertical = this.settings.mode !== "horizontal";
    this.ta.style.left = `${Math.round(vertical ? r.x : r.x)}px`;
    this.ta.style.top = `${Math.round(r.y)}px`;
    this.ta.style.fontSize = `${Math.max(12, Math.round(vertical ? r.w * 0.8 : r.h * 0.6))}px`;
  }

  private scrollToCaret(center = false) {
    const r = this.caretRect();
    if (!r) return;
    const sc = this.scroller;
    const vw = sc.clientWidth;
    const vh = sc.clientHeight;
    const m = 40;
    if (center) {
      sc.scrollLeft += r.x - vw / 2;
      sc.scrollTop += r.y - vh / 2;
    } else {
      if (r.x < m) sc.scrollLeft += r.x - m;
      else if (r.x + r.w > vw - m) sc.scrollLeft += r.x + r.w - (vw - m);
      if (r.y < m) sc.scrollTop += r.y - m;
      else if (r.y + r.h > vh - m) sc.scrollTop += r.y + r.h - (vh - m);
    }
    this.requestDraw();
  }

  // -------------------------------------------------------------------------
  // 編集

  private snapshot(): Snapshot {
    return { text: this.text, selStart: this.anchor, selEnd: this.focus };
  }

  private restore(s: Snapshot) {
    this.text = s.text;
    this.anchor = s.selStart;
    this.focus = s.selEnd;
    this.afterEdit();
  }

  private replaceSelection(str: string, kind: string) {
    const s = this.selStart;
    const e = this.selEnd;
    if (s === e && str === "") return;
    this.history.record(this.snapshot(), kind);
    this.text = this.text.slice(0, s) + str + this.text.slice(e);
    this.anchor = this.focus = s + str.length;
    this.afterEdit();
  }

  private afterEdit() {
    this.goalPos = null;
    this.relayout();
    this.startBlink();
    this.scrollToCaret();
    this.cb.onChange();
  }

  insert(str: string) {
    str = str.replace(/\r\n?/g, "\n");
    const kind = str.length <= 2 && !str.includes("\n") ? "type" : "other";
    this.replaceSelection(str, kind);
  }

  private deleteBackward() {
    if (this.selStart === this.selEnd) this.anchor = prevOffset(this.text, this.focus);
    this.replaceSelection("", "delete");
  }

  private deleteForward() {
    if (this.selStart === this.selEnd) this.anchor = nextOffset(this.text, this.focus);
    this.replaceSelection("", "delete");
  }

  private setCaret(offset: number, extend: boolean, keepGoal = false) {
    this.focus = Math.max(0, Math.min(this.text.length, offset));
    if (!extend) this.anchor = this.focus;
    if (!keepGoal) this.goalPos = null;
    this.startBlink();
    this.scrollToCaret();
  }

  /** 隣の行へ移る（dir: +1 で次の行） */
  private moveLine(dir: number, extend: boolean) {
    const c = caretAt(this.layout, this.focus);
    if (!c) return;
    if (this.goalPos === null) this.goalPos = c.pos;
    const target = this.layout.lines[c.line.index + dir];
    if (!target) {
      this.setCaret(dir < 0 ? 0 : this.text.length, extend);
      return;
    }
    this.setCaret(nearestInLine(target, this.goalPos), extend, true);
  }

  private lineEdge(end: boolean, extend: boolean) {
    const c = caretAt(this.layout, this.focus);
    if (!c) return;
    this.setCaret(end ? c.line.last : c.line.first, extend);
  }

  // -------------------------------------------------------------------------
  // 入力

  private bindInput() {
    const ta = this.ta;

    ta.addEventListener("compositionstart", () => {
      this.composing = true;
      if (this.selStart !== this.selEnd) this.replaceSelection("", "other");
    });
    ta.addEventListener("compositionend", () => {
      this.composing = false;
      const v = ta.value;
      ta.value = "";
      this.preedit = "";
      if (v) this.insert(v);
      else this.relayout();
    });
    ta.addEventListener("input", (e) => {
      if (this.composing || (e as InputEvent).isComposing) {
        this.preedit = ta.value;
        this.relayout();
        this.scrollToCaret();
        return;
      }
      const v = ta.value;
      ta.value = "";
      if (v) this.insert(v);
    });

    ta.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = e.clipboardData?.getData("text/plain");
      if (t) this.insert(t);
    });
    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (this.selStart === this.selEnd) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", this.text.slice(this.selStart, this.selEnd));
      if (cut) this.replaceSelection("", "other");
    };
    ta.addEventListener("copy", (e) => copy(e, false));
    ta.addEventListener("cut", (e) => copy(e, true));

    ta.addEventListener("focus", () => this.requestDraw());
    ta.addEventListener("blur", () => this.requestDraw());

    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      const vertical = this.settings.mode !== "horizontal";

      if (mod && !e.altKey) {
        const lk = k.toLowerCase();
        if (lk === "z" && !e.shiftKey) return this.handled(e, () => this.undo());
        if ((lk === "z" && e.shiftKey) || lk === "y") return this.handled(e, () => this.redo());
        if (lk === "a") {
          return this.handled(e, () => {
            this.anchor = 0;
            this.focus = this.text.length;
            this.requestDraw();
          });
        }
        if (k === "Home") return this.handled(e, () => this.setCaret(0, e.shiftKey));
        if (k === "End") return this.handled(e, () => this.setCaret(this.text.length, e.shiftKey));
        // コピー・切り取りは copy/cut イベントで扱う。
        // textarea が空だとブラウザが copy を発火しない場合があるので、選択文字列を入れておく
        if ((lk === "c" || lk === "x") && this.selStart !== this.selEnd) {
          ta.value = this.text.slice(this.selStart, this.selEnd);
          ta.select();
          setTimeout(() => (ta.value = ""), 0);
        }
        return;
      }

      const next = (ext: boolean) => {
        if (!ext && this.selStart !== this.selEnd) return this.setCaret(this.selEnd, false);
        this.setCaret(nextOffset(this.text, this.focus), ext);
      };
      const prev = (ext: boolean) => {
        if (!ext && this.selStart !== this.selEnd) return this.setCaret(this.selStart, false);
        this.setCaret(prevOffset(this.text, this.focus), ext);
      };
      const sh = e.shiftKey;
      switch (k) {
        case "Backspace":
          return this.handled(e, () => this.deleteBackward());
        case "Delete":
          return this.handled(e, () => this.deleteForward());
        case "ArrowDown":
          return this.handled(e, () => (vertical ? next(sh) : this.moveLine(1, sh)));
        case "ArrowUp":
          return this.handled(e, () => (vertical ? prev(sh) : this.moveLine(-1, sh)));
        case "ArrowLeft":
          return this.handled(e, () => (vertical ? this.moveLine(1, sh) : prev(sh)));
        case "ArrowRight":
          return this.handled(e, () => (vertical ? this.moveLine(-1, sh) : next(sh)));
        case "Home":
          return this.handled(e, () => this.lineEdge(false, sh));
        case "End":
          return this.handled(e, () => this.lineEdge(true, sh));
        case "Tab":
          return this.handled(e, () => this.insert("　"));
      }
    });
  }

  private handled(e: Event, f: () => void) {
    e.preventDefault();
    f();
  }

  // -------------------------------------------------------------------------
  // マウス

  private offsetAt(clientX: number, clientY: number): number | null {
    const r = this.scroller.getBoundingClientRect();
    const x = clientX - r.left + this.scroller.scrollLeft;
    const y = clientY - r.top + this.scroller.scrollTop;
    // 最も近いページ
    let bi = 0;
    let bd = Infinity;
    this.boxes.forEach((b, i) => {
      const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - b.x - b.w : 0;
      const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - b.y - b.h : 0;
      const d = dx + dy;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const b = this.boxes[bi];
    if (!b) return null;
    const off = hitTest(this.layout, bi, (x - b.x) / this.scale, (y - b.y) / this.scale);
    return off === null ? null : Math.min(off, this.text.length);
  }

  private bindMouse() {
    this.scroller.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // スクロールバー上のクリックは除く
      if (e.offsetX > this.scroller.clientWidth || e.offsetY > this.scroller.clientHeight) return;
      e.preventDefault();
      if (this.composing) return;
      const off = this.offsetAt(e.clientX, e.clientY);
      this.focusInput();
      if (off === null) return;
      this.setCaret(off, e.shiftKey);
      this.dragging = true;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      const off = this.offsetAt(e.clientX, e.clientY);
      if (off !== null && off !== this.focus) this.setCaret(off, true);
    });
    window.addEventListener("mouseup", () => (this.dragging = false));
  }
}
