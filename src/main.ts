import "./style.css";
import { Editor } from "./editor";
import { exportFile, measureImagePage } from "./export";
import { loadFont, type FontFamily } from "./fonts";
import { LayoutEngine } from "./layout";
import { formatBytes, IMAGE_QUALITIES, imageEstimateKey, imageLongSide, printLayout } from "./output";
import {
  ALLOWED_FG,
  BACKGROUNDS,
  FOREGROUNDS,
  normalizeSettings,
  type Background,
  type Foreground,
  type ImageFormat,
  type ImageQuality,
  type Settings,
} from "./settings";
import { IndexedDbStore, type SavedState } from "./storage";
import { countChars } from "./text";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  title: $<HTMLInputElement>("title"),
  mode: $<HTMLSelectElement>("mode"),
  paper: $<HTMLSelectElement>("paper"),
  paperField: $<HTMLElement>("paper-field"),
  bg: $<HTMLSelectElement>("bg"),
  fg: $<HTMLSelectElement>("fg"),
  font: $<HTMLSelectElement>("font"),
  sizeDown: $<HTMLButtonElement>("size-down"),
  sizeUp: $<HTMLButtonElement>("size-up"),
  sizeValue: $<HTMLElement>("size-value"),
  undo: $<HTMLButtonElement>("undo"),
  redo: $<HTMLButtonElement>("redo"),
  exportPdf: $<HTMLButtonElement>("export-pdf"),
  exportImage: $<HTMLButtonElement>("export-image"),
  imageFormat: $<HTMLSelectElement>("image-format"),
  imageQuality: $<HTMLSelectElement>("image-quality"),
  imageEstimate: $<HTMLElement>("image-estimate"),
  fullscreen: $<HTMLButtonElement>("fullscreen"),
  count: $<HTMLElement>("count"),
  sheets: $<HTMLElement>("sheets"),
  saveState: $<HTMLElement>("save-state"),
  exportState: $<HTMLElement>("export-state"),
  loading: $<HTMLElement>("loading"),
};

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const HFONT_STEPS = [12, 14, 16, 18, 20, 22, 24, 28, 32, 40];

const store = new IndexedDbStore();
/** 原稿用紙以外の形式で、原稿用紙の枚数を数えるための組版 */
const sheetEngine = new LayoutEngine();
/** 画像の容量の目安を出すための、出力用の組版（横書きは画面と違い A4 縦でページを分ける） */
const printEngine = new LayoutEngine();
let editor: Editor;
let settings: Settings;

// ---------------------------------------------------------------------------
// 起動

async function main() {
  for (const [k, v] of Object.entries(BACKGROUNDS)) ui.bg.add(new Option(v.label, k));
  for (const [k, v] of Object.entries(FOREGROUNDS)) ui.fg.add(new Option(v.label, k));
  for (const [k, v] of Object.entries(IMAGE_QUALITIES)) ui.imageQuality.add(new Option(v.label, k));

  let saved: SavedState | null = null;
  try {
    saved = await store.load();
  } catch (e) {
    console.error("保存内容を読み込めませんでした", e);
  }
  settings = normalizeSettings(saved?.settings);
  applyChrome();

  let font;
  try {
    font = await loadFont(settings.font);
  } catch {
    settings.font = "serif";
    font = await loadFont("serif");
  }

  editor = new Editor($("editor"), font, settings, { onChange: onTextChange });
  editor.setDocument(saved?.title ?? "", saved?.text ?? "");
  ui.title.value = editor.title;
  syncControls();
  updateStatus();
  ui.loading.hidden = true;
  editor.focusInput();

  bindControls();
  registerServiceWorker();
}

// ---------------------------------------------------------------------------
// 保存

let saveTimer = 0;

function scheduleSave() {
  ui.saveState.textContent = "未保存の変更があります";
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 1000);
}

async function saveNow() {
  clearTimeout(saveTimer);
  try {
    await store.save({ title: editor.title, text: editor.text, settings, savedAt: Date.now() });
    ui.saveState.textContent = `保存しました（${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}）`;
  } catch (e) {
    console.error(e);
    ui.saveState.textContent = "保存できませんでした";
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && editor) void saveNow();
});

// ---------------------------------------------------------------------------
// 状態表示

let statusTimer = 0;

function onTextChange() {
  scheduleSave();
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(updateStatus, 200);
}

function updateStatus() {
  const { all, visible } = countChars(editor.text);
  ui.count.textContent = `${all.toLocaleString()} 字（空白・改行を含む） / ${visible.toLocaleString()} 字（含まない）`;
  const sheets = editor.settings.mode === "genko" ? editor.layout.pages.length : sheetEngine.genko(editor.text, settings.paper, "").pages.length;
  ui.sheets.textContent = `原稿用紙 ${sheets} 枚`;
  updateImageEstimate();
}

// 画像出力の容量の目安（押す前に大きさに気づけるように）。
// 代表ページ 1 枚を Worker で実際に画像にした大きさ × ページ数で見積もる。
// 測り直すのは、目安に関わる設定かページ数が変わったときだけ。

/** 最後に測った代表ページの大きさ */
let imageSample: { key: string; pages: number; bytesPerPage: number } | null = null;
let measureTimer = 0;
let measuring = false;

function updateImageEstimate() {
  const layout = printLayout(printEngine, { title: editor.title, text: editor.text, settings }, editor.font.measure, editor.font.family);
  const pages = layout.pages.length;
  const key = imageEstimateKey(settings);
  const sample = imageSample?.key === key ? imageSample : null;
  ui.imageEstimate.textContent = sample ? `${formatBytes(sample.bytesPerPage * pages)}（${pages} 枚）` : `計算中…（${pages} 枚）`;
  ui.imageEstimate.title = `画像の長辺 約 ${imageLongSide(layout, settings.imageQuality).toLocaleString()}px。容量はおおよその目安です`;
  if (!sample || sample.pages !== pages) scheduleMeasure();
}

function scheduleMeasure() {
  clearTimeout(measureTimer);
  measureTimer = window.setTimeout(async () => {
    if (measuring) return scheduleMeasure();
    measuring = true;
    const s = { ...settings };
    const pages = printLayout(printEngine, { title: editor.title, text: editor.text, settings: s }, editor.font.measure, editor.font.family).pages.length;
    try {
      const bytes = await measureImagePage({ title: editor.title, text: editor.text, settings: s });
      imageSample = { key: imageEstimateKey(s), pages, bytesPerPage: bytes };
    } catch (e) {
      console.error(e);
    } finally {
      measuring = false;
    }
    updateImageEstimate();
  }, 800);
}

// ---------------------------------------------------------------------------
// 表示設定

function applyChrome() {
  document.documentElement.dataset.dark = String(settings.bg !== "white");
}

function syncControls() {
  ui.mode.value = settings.mode;
  ui.paper.value = settings.paper;
  ui.paperField.hidden = settings.mode !== "genko";
  ui.bg.value = settings.bg;
  for (const opt of ui.fg.options) opt.disabled = !ALLOWED_FG[settings.bg].includes(opt.value as Foreground);
  ui.fg.value = settings.fg;
  ui.font.value = settings.font;
  ui.imageFormat.value = settings.imageFormat;
  ui.imageQuality.value = settings.imageQuality;
  ui.sizeValue.textContent = settings.mode === "horizontal" ? `${settings.hFontPx}px` : `${Math.round(settings.zoom * 100)}%`;
}

function update(patch: Partial<Settings>) {
  settings = normalizeSettings({ ...settings, ...patch });
  applyChrome();
  syncControls();
  editor.setSettings(settings);
  updateStatus();
  scheduleSave();
}

function stepSize(dir: number) {
  if (settings.mode === "horizontal") {
    const i = nearestIndex(HFONT_STEPS, settings.hFontPx) + dir;
    update({ hFontPx: HFONT_STEPS[Math.max(0, Math.min(HFONT_STEPS.length - 1, i))] });
  } else {
    const i = nearestIndex(ZOOM_STEPS, settings.zoom) + dir;
    update({ zoom: ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i))] });
  }
}

const nearestIndex = (xs: number[], v: number) => xs.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(xs[best] - v) ? i : best), 0);

async function changeFont(family: FontFamily) {
  ui.font.disabled = true;
  const prev = ui.saveState.textContent;
  ui.saveState.textContent = "フォントを読み込んでいます…";
  try {
    const font = await loadFont(family);
    settings = { ...settings, font: family };
    editor.setSettings(settings);
    editor.setFont(font);
    updateStatus();
    scheduleSave();
  } catch (e) {
    console.error(e);
    ui.font.value = settings.font;
  ui.imageFormat.value = settings.imageFormat;
  ui.imageQuality.value = settings.imageQuality;
    ui.saveState.textContent = "フォントを読み込めませんでした";
    return;
  } finally {
    ui.font.disabled = false;
  }
  ui.saveState.textContent = prev;
}

/** 出力は Web Worker で行うので、その間も書き続けられる */
async function runExport(kind: "pdf" | "image") {
  const buttons = [ui.exportPdf, ui.exportImage];
  for (const b of buttons) b.disabled = true;
  const label = kind === "pdf" ? "PDF" : settings.imageFormat === "jpeg" ? "JPEG" : "PNG";
  ui.exportState.textContent = `${label}を出力しています…`;
  try {
    await exportFile(kind, { title: editor.title, text: editor.text, settings: { ...settings } }, (done, total) => {
      ui.exportState.textContent = done < total ? `${label}を出力しています（${done} / ${total} ページ）` : `${label}を仕上げています…`;
    });
    ui.exportState.textContent = `${label}を出力しました`;
  } catch (e) {
    console.error(e);
    ui.exportState.textContent = `${label}の出力に失敗しました`;
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

function bindControls() {
  ui.title.addEventListener("input", () => {
    editor.setTitle(ui.title.value);
    scheduleSave();
  });
  ui.title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) editor.focusInput();
  });
  ui.mode.addEventListener("change", () => update({ mode: ui.mode.value as Settings["mode"] }));
  ui.paper.addEventListener("change", () => update({ paper: ui.paper.value as Settings["paper"] }));
  ui.bg.addEventListener("change", () => update({ bg: ui.bg.value as Background }));
  ui.fg.addEventListener("change", () => update({ fg: ui.fg.value as Foreground }));
  ui.font.addEventListener("change", () => void changeFont(ui.font.value as FontFamily));
  ui.sizeDown.addEventListener("click", () => stepSize(-1));
  ui.sizeUp.addEventListener("click", () => stepSize(1));
  ui.undo.addEventListener("click", () => editor.undo());
  ui.redo.addEventListener("click", () => editor.redo());
  ui.exportPdf.addEventListener("click", () => void runExport("pdf"));
  ui.exportImage.addEventListener("click", () => void runExport("image"));
  ui.imageFormat.addEventListener("change", () => update({ imageFormat: ui.imageFormat.value as ImageFormat }));
  ui.imageQuality.addEventListener("change", () => update({ imageQuality: ui.imageQuality.value as ImageQuality }));
  ui.fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  });
  // ツールバーの操作のあとは本文に戻る
  for (const el of [ui.mode, ui.paper, ui.bg, ui.fg, ui.font, ui.imageFormat, ui.imageQuality]) el.addEventListener("change", () => editor.focusInput());
  for (const el of [ui.sizeDown, ui.sizeUp, ui.undo, ui.redo, ui.fullscreen, ui.exportPdf, ui.exportImage]) {
    el.addEventListener("mousedown", (e) => e.preventDefault());
  }
}

function registerServiceWorker() {
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("Service Worker を登録できませんでした", e));
  }
}

main().catch((e) => {
  console.error(e);
  ui.loading.textContent = "読み込みに失敗しました。再読み込みしてください。";
});
