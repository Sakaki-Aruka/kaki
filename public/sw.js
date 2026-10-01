// オフラインでも使えるよう、読み込んだファイルを保存しておく。
// - ページ本体：ネットワーク優先（更新をすぐ反映する）。つながらなければ保存したものを使う
// - それ以外（スクリプト・フォントなど）：保存したものを優先し、裏で更新する
const CACHE = "web-kaki-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/fonts/SourceHanSerifJP-Regular.otf"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) c.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      // フォントは大きく変わらないので、保存済みなら再取得しない
      if (hit && url.pathname.startsWith("/fonts/")) return hit;
      return hit ?? net;
    }),
  );
});
