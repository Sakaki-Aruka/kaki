// 出力の依頼（画面側）。生成は Web Worker（export.worker.ts）で行い、ここではダウンロードだけを行う。
import type { ExportRequest, ExportResponse } from "./export.worker";
import type { ExportKind, RenderInput } from "./render";

let worker: Worker | null = null;
let nextId = 1;

/** Worker はフォントの解析結果を持ち回れるよう、一度作ったら使い回す */
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module", name: "export" });
  }
  return worker;
}

/** Worker に 1 件依頼し、終わりの応答（progress 以外）を返す */
function request(
  kind: ExportRequest["kind"],
  input: RenderInput,
  onProgress?: (done: number, total: number) => void,
): Promise<Exclude<ExportResponse, { type: "progress" | "error" }>> {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<ExportResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.(msg.done, msg.total);
        return;
      }
      cleanup();
      if (msg.type === "error") reject(new Error(msg.message));
      else resolve(msg);
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      // 壊れた Worker は捨て、次回は作り直す
      worker?.terminate();
      worker = null;
      reject(new Error(e.message || "Worker でエラーが起きました"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    const req: ExportRequest = { id, kind, input };
    w.postMessage(req);
  });
}

export async function exportFile(kind: ExportKind, input: RenderInput, onProgress: (done: number, total: number) => void): Promise<void> {
  const msg = await request(kind, input, onProgress);
  if (msg.type === "done") download(msg.result.blob, msg.result.fileName);
}

/** 容量の目安用に、代表ページ 1 枚を画像にした大きさ（バイト）を測る */
export async function measureImagePage(input: RenderInput): Promise<number> {
  const msg = await request("measure", input);
  return msg.type === "measured" ? msg.bytes : 0;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
