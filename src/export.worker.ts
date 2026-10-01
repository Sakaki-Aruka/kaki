// 出力用の Web Worker。組版から PDF・画像の生成までをここで行い、画面を止めない。
/// <reference lib="webworker" />
import { loadFont } from "./fonts";
import { measureImagePage, renderImageZip, renderPdf, type ExportKind, type RenderInput, type RenderResult } from "./render";

export interface ExportRequest {
  id: number;
  /** measure：容量の目安用に代表ページ 1 枚の画像の大きさを測る */
  kind: ExportKind | "measure";
  input: RenderInput;
}

export type ExportResponse =
  | { id: number; type: "progress"; done: number; total: number }
  | { id: number; type: "done"; result: RenderResult }
  | { id: number; type: "measured"; bytes: number }
  | { id: number; type: "error"; message: string };

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: ExportResponse) => self.postMessage(msg);

self.addEventListener("message", async (e: MessageEvent<ExportRequest>) => {
  const { id, kind, input } = e.data;
  try {
    // フォントは Worker 側でも読み込む（Service Worker・HTTP キャッシュに載っていれば再取得はない）
    const font = await loadFont(input.settings.font);
    if (kind === "measure") {
      post({ id, type: "measured", bytes: await measureImagePage(input, font) });
      return;
    }
    const progress = (done: number, total: number) => post({ id, type: "progress", done, total });
    const result = kind === "pdf" ? await renderPdf(input, font, progress) : await renderImageZip(input, font, progress);
    post({ id, type: "done", result });
  } catch (err) {
    console.error(err);
    post({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
});
