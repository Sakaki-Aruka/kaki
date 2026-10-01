// 表示設定と配色
import type { FontFamily } from "./fonts";
import type { Mode, Paper } from "./layout";
import type { Theme } from "./paint";

export type Background = "black" | "darkgray" | "blackboard" | "white";
export type Foreground = "black" | "white" | "lightgray";
export type ImageFormat = "png" | "jpeg";
/** 画像の画質（用途）。screen：画面で見る・SNS 用、print：印刷用 */
export type ImageQuality = "screen" | "print";

export const BACKGROUNDS: Record<Background, { label: string; color: string }> = {
  black: { label: "黒", color: "#000000" },
  darkgray: { label: "濃い灰色", color: "#2b2b2b" },
  blackboard: { label: "黒板", color: "#123f36" },
  white: { label: "白", color: "#ffffff" },
};

export const FOREGROUNDS: Record<Foreground, { label: string; color: string }> = {
  black: { label: "黒", color: "#1a1a1a" },
  white: { label: "白", color: "#f4f4f0" },
  lightgray: { label: "薄い灰色", color: "#b4b4b0" },
};

/** 読める組み合わせだけを許す */
export const ALLOWED_FG: Record<Background, Foreground[]> = {
  black: ["white", "lightgray"],
  darkgray: ["white", "lightgray"],
  blackboard: ["white", "lightgray"],
  white: ["black"],
};

export interface Settings {
  mode: Mode;
  paper: Paper;
  bg: Background;
  fg: Foreground;
  font: FontFamily;
  /** 原稿用紙・縦書きの拡大率 */
  zoom: number;
  /** 横書きの文字サイズ（px） */
  hFontPx: number;
  /** 画像出力の形式 */
  imageFormat: ImageFormat;
  imageQuality: ImageQuality;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "genko",
  paper: "B4",
  bg: "white",
  fg: "black",
  font: "serif",
  zoom: 1,
  hFontPx: 18,
  imageFormat: "png",
  imageQuality: "screen",
};

export function normalizeSettings(s: Partial<Settings> | undefined): Settings {
  const out = { ...DEFAULT_SETTINGS, ...s };
  if (!(out.bg in BACKGROUNDS)) out.bg = DEFAULT_SETTINGS.bg;
  if (!ALLOWED_FG[out.bg].includes(out.fg)) out.fg = ALLOWED_FG[out.bg][0];
  if (out.imageFormat !== "png" && out.imageFormat !== "jpeg") out.imageFormat = DEFAULT_SETTINGS.imageFormat;
  if (out.imageQuality !== "screen" && out.imageQuality !== "print") out.imageQuality = DEFAULT_SETTINGS.imageQuality;
  return out;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (v: number, sh: number) => (v >> sh) & 255;
  const m = (sh: number) => Math.round(ch(pa, sh) * (1 - t) + ch(pb, sh) * t);
  return "#" + ((m(16) << 16) | (m(8) << 8) | m(0)).toString(16).padStart(6, "0");
}

export function themeOf(s: Settings): Theme {
  const bg = BACKGROUNDS[s.bg].color;
  const fg = FOREGROUNDS[s.fg].color;
  return { bg, fg, line: mix(bg, fg, 0.4), selection: mix(bg, fg, 0.25) };
}
