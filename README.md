# 原稿エディタ（プロトタイプ）

原稿用紙・マス目なし縦書き・行のみの横書きで書けるエディタ。仕様と検討の経緯は [design.md](design.md) を参照。

## 開発

```sh
npm install
npm run dev       # 開発サーバー（http://localhost:5173）
npm run build     # 型チェックとビルド（dist/ へ出力）
npm run preview   # ビルド結果の確認（Service Worker も有効になる）
npm run deploy    # ビルドして Cloudflare Workers へ配信（wrangler のログインが必要）
```

## 構成

| ファイル | 役割 |
|---|---|
| `src/layout.ts` | 組版。3 形式それぞれの字の位置（mm）・カーソル位置・禁則処理 |
| `src/paint.ts` | ページの描画手順。画面・PNG（Canvas）と PDF（PDFKit）で共通 |
| `src/fonts.ts` | フォントの読み込みと字形のキャッシュ（fontkit で縦書き用字形に切り替える） |
| `src/editor.ts` | エディタ本体。入力（IME を含む）、カーソル・選択、スクロール |
| `src/output.ts` | 出力用の組版、画像の画質（用途と解像度）、容量の目安に使う代表ページの選び方 |
| `src/render.ts` | PDF 生成（PDFKit）と画像（PNG / JPEG）の zip 生成（fflate）。DOM を使わない |
| `src/export.worker.ts` | 出力用の Web Worker。`render.ts` を呼び、出力中も画面を止めない |
| `src/export.ts` | 画面側の出力処理。Worker への依頼、進み具合の受け取り、ダウンロード |
| `src/storage.ts` | IndexedDB への保存。将来サーバー保存に差し替えられるよう `Store` として分けている |
| `src/settings.ts` | 表示設定と配色（読めない組み合わせを選べないようにする） |
| `public/fonts/` | 源ノ明朝・源ノ角ゴシック（SIL Open Font License） |
| `public/sw.js` | オフライン用の Service Worker |

画面表示・PDF・PNG はどれも `layout.ts` の同じ組版結果を `paint.ts` の同じ手順で描くので、見た目が一致する。

## 配信（GitHub Actions）

`main` に push すると `.github/workflows/deploy.yml` がビルドし、Cloudflare Workers へ配信する。プルリクエストではビルド（型チェックを含む）だけを行う。

最初に、リポジトリの Settings → Secrets and variables → Actions に次の 2 つを登録する。未登録の間は配信を飛ばし、警告だけを出す。

| シークレット | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare の API トークン（「Edit Cloudflare Workers」テンプレートで作成） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |

## ライセンス

このプロジェクトのコードは [MIT License](LICENSE)。

- フォント（源ノ明朝・源ノ角ゴシック）は SIL Open Font License 1.1。ライセンス文は `public/fonts/LICENSE-*.txt`。
- 配信物に含まれるライブラリのライセンス文は、ビルド時に `dist/THIRD_PARTY_LICENSES.txt` にまとめられ、画面下の「ライセンス」から見られる。
