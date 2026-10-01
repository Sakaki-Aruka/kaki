// フォントの読み込みと、字形（Path2D）のキャッシュ
import { create, type Font } from "fontkit";

export type FontFamily = "serif" | "sans";

export const FONT_FILES: Record<FontFamily, string> = {
  serif: "/fonts/SourceHanSerifJP-Regular.otf",
  sans: "/fonts/SourceHanSansJP-Regular.otf",
};

/** 源ノ明朝・源ノ角ゴシックの字面の上端（em 単位、ベースラインから） */
export const ASCENT = 0.88;

export interface GlyphShape {
  path: Path2D;
  /** 送り幅（em） */
  advance: number;
}

export class LoadedFont {
  readonly upm: number;
  private cache = new Map<string, GlyphShape>();

  constructor(
    readonly family: FontFamily,
    readonly data: Uint8Array,
    readonly font: Font,
  ) {
    this.upm = font.unitsPerEm;
  }

  shape(ch: string, vertical: boolean): GlyphShape {
    const key = vertical ? "v" + ch : "h" + ch;
    let s = this.cache.get(key);
    if (!s) {
      const run = this.font.layout(ch, vertical ? ["vert"] : []);
      const path = new Path2D();
      let adv = 0;
      for (const g of run.glyphs) {
        path.addPath(new Path2D(g.path.toSVG()), new DOMMatrix([1, 0, 0, 1, adv, 0]));
        adv += g.advanceWidth;
      }
      s = { path, advance: adv / this.upm };
      this.cache.set(key, s);
    }
    return s;
  }

  measure = (ch: string): number => this.shape(ch, false).advance;
}

const loading = new Map<FontFamily, Promise<LoadedFont>>();

export function loadFont(family: FontFamily): Promise<LoadedFont> {
  let p = loading.get(family);
  if (!p) {
    p = (async () => {
      const res = await fetch(FONT_FILES[family]);
      if (!res.ok) throw new Error(`フォントを読み込めませんでした: ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      return new LoadedFont(family, data, create(data));
    })();
    p.catch(() => loading.delete(family));
    loading.set(family, p);
  }
  return p;
}
