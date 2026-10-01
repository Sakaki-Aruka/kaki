// 本文と表示設定の保存。将来サーバー側への保存に差し替えられるよう、入出力をこの形に限る。
import type { Settings } from "./settings";

export interface SavedState {
  title: string;
  text: string;
  settings: Partial<Settings>;
  savedAt: number;
}

export interface Store {
  load(): Promise<SavedState | null>;
  save(state: SavedState): Promise<void>;
}

const DB_NAME = "web-kaki";
const STORE = "documents";
const KEY = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbStore implements Store {
  private db = openDb();

  async load(): Promise<SavedState | null> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as SavedState) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async save(state: SavedState): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
