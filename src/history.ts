// 元に戻す・やり直し

export interface Snapshot {
  text: string;
  selStart: number;
  selEnd: number;
}

const LIMIT = 500;
/** この時間内の連続した入力は 1 回分としてまとめる */
const MERGE_MS = 1000;

export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastPush = 0;
  private lastKind = "";

  /** 変更の直前の状態を記録する */
  record(before: Snapshot, kind: string) {
    const now = Date.now();
    const merge = kind === this.lastKind && kind !== "other" && now - this.lastPush < MERGE_MS;
    if (!merge) {
      this.undoStack.push(before);
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastPush = now;
    this.lastKind = kind;
  }

  undo(current: Snapshot): Snapshot | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(current);
    this.lastKind = "";
    return s;
  }

  redo(current: Snapshot): Snapshot | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(current);
    this.lastKind = "";
    return s;
  }
}
