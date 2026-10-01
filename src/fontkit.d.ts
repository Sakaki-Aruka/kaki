// fontkit には型定義が同梱されていないため、使う範囲だけ宣言する
declare module "fontkit" {
  export interface Path {
    toSVG(): string;
  }
  export interface Glyph {
    id: number;
    path: Path;
    advanceWidth: number;
  }
  export interface GlyphRun {
    glyphs: Glyph[];
  }
  export interface Font {
    unitsPerEm: number;
    layout(text: string, features?: string[]): GlyphRun;
  }
  export function create(buffer: Uint8Array): Font;
}
