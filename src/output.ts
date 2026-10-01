// 出力用の組版と、画像の画質・容量の見積もり。
// 画面側（容量の目安の表示）と Worker 側（実際の出力）の両方から使うので、重いライブラリには依存しない。
import { HORIZONTAL_PRINT, type LayoutEngine, type Layout, type Measure } from "./layout";
import type { ImageQuality, Settings } from "./settings";

export interface OutputSource {
  title: string;
  text: string;
  settings: Settings;
}

/** 出力用の組版。横書きは画面と違い、A4 縦でページを分ける */
export function printLayout(engine: LayoutEngine, { title, text, settings }: OutputSource, measure: Measure, fontKey: string): Layout {
  switch (settings.mode) {
    case "genko":
      return engine.genko(text, settings.paper, title);
    case "vertical":
      return engine.vertical(text);
    case "horizontal":
      return engine.horizontal(text, HORIZONTAL_PRINT, measure, fontKey);
  }
}

/** 画質ごとの解像度。利用者には用途の名前だけを見せる */
export const IMAGE_QUALITIES: Record<ImageQuality, { label: string; dpi: number }> = {
  screen: { label: "画面で見る・SNS 用", dpi: 100 },
  print: { label: "印刷用", dpi: 200 },
};

/** JPEG の画質。文字の輪郭がにじまないよう高めにする */
export const JPEG_QUALITY = 0.92;

/** ページの大きさ（mm）から画像の画素数を求める */
export function imageSize(pageW: number, pageH: number, quality: ImageQuality): { w: number; h: number } {
  const px = IMAGE_QUALITIES[quality].dpi / 25.4;
  return { w: Math.round(pageW * px), h: Math.round(pageH * px) };
}

/** 画像の長辺（px） */
export function imageLongSide(layout: Layout, quality: ImageQuality): number {
  const p = layout.pages[0];
  const { w, h } = imageSize(p.w, p.h, quality);
  return Math.max(w, h);
}

/**
 * 容量の目安に使う代表ページ（いちばん行の多いページ）。
 * 画像の容量は字の大きさ・密度・マス目の有無で大きく変わり、定数では見積もれないので、
 * このページを実際に画像にした大きさにページ数を掛けて目安とする。
 */
export function representativePage(layout: Layout): number {
  let best = 0;
  layout.pages.forEach((p, i) => {
    if (p.lines.length > layout.pages[best].lines.length) best = i;
  });
  return best;
}

/** 容量の目安が変わりうる設定（変わったら代表ページを測り直す） */
export function imageEstimateKey(s: Settings): string {
  return [s.mode, s.paper, s.bg, s.fg, s.font, s.imageFormat, s.imageQuality].join(":");
}

/** 容量を「約 45 MB」のように丸めて表す */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `約 ${Math.max(10, Math.round(bytes / 1024 / 10) * 10)} KB`;
  if (mb < 10) return `約 ${mb.toFixed(1)} MB`;
  return `約 ${Math.round(mb)} MB`;
}
