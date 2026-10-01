// 文字の分類・変換・計数

/** 行頭に置けず、枠外へぶら下げる文字（句読点） */
const HANGING = new Set([..."、。，．､｡"]);

/** 行頭禁則の閉じ括弧類 */
const CLOSING = new Set([..."」』）］｝〕〉》】〙〗’”)]}"]);

/** 行末禁則の開き括弧類 */
const OPENING = new Set([..."「『（［｛〔〈《【〘〖‘“([{"]);

export const isHanging = (ch: string) => HANGING.has(ch);
export const isClosing = (ch: string) => CLOSING.has(ch);
export const isOpening = (ch: string) => OPENING.has(ch);
export const isLineHeadProhibited = (ch: string) => HANGING.has(ch) || CLOSING.has(ch);

/** 半角英数字・記号を全角に変換する（縦組用） */
export function toFullWidth(ch: string): string {
  const c = ch.codePointAt(0)!;
  if (c === 0x20) return "　";
  if (c >= 0x21 && c <= 0x7e) return String.fromCodePoint(c + 0xfee0);
  return ch;
}

/** 文字数（空白・改行を含む / 含まない） */
export function countChars(text: string): { all: number; visible: number } {
  let all = 0;
  let visible = 0;
  for (const ch of text) {
    all++;
    if (!/\s/u.test(ch)) visible++;
  }
  return { all, visible };
}

/** 文字列をコードポイント単位に分割し、元の UTF-16 位置を添える */
export function splitChars(text: string): { ch: string; start: number; end: number }[] {
  const out: { ch: string; start: number; end: number }[] = [];
  let i = 0;
  for (const ch of text) {
    out.push({ ch, start: i, end: i + ch.length });
    i += ch.length;
  }
  return out;
}

/** 位置 i をコードポイントの境界に揃えた上で、1 文字前・後の位置を返す */
export function prevOffset(text: string, i: number): number {
  if (i <= 0) return 0;
  const c = text.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return i - 2;
  return i - 1;
}

export function nextOffset(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) return i + 2;
  return i + 1;
}
