// 配信するバンドルに含まれるライブラリのライセンス文を dist/THIRD_PARTY_LICENSES.txt にまとめる。
// バンドルの圧縮で著作権表示が消えても、MIT などが求める表示を配信物に残すため。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

const entries = [];
for (const [key, info] of Object.entries(lock.packages)) {
  if (!key || info.dev) continue; // ルートと開発用の依存は除く
  const dir = path.join(root, key);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  let text;
  if (file) {
    text = fs.readFileSync(path.join(dir, file), "utf8").trim();
  } else if (pkg.license === "MIT") {
    // ライセンス文のファイルを同梱していないパッケージは、package.json の作者名で MIT の標準文を補う
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    if (!author) throw new Error(`作者名が見つかりません: ${pkg.name}`);
    text = mitText(author);
  } else {
    throw new Error(`ライセンス文が見つかりません: ${pkg.name}（${pkg.license}）`);
  }
  entries.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? "", text });
}
function mitText(holder) {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

entries.sort((a, b) => a.name.localeCompare(b.name));

const sep = "\n\n" + "-".repeat(78) + "\n\n";
const header =
  "このサイトは以下のライブラリを含みます。\n" +
  "フォント（源ノ明朝・源ノ角ゴシック）のライセンスは fonts/ 以下の LICENSE-*.txt を参照してください。";
const body = entries.map((e) => `${e.name}@${e.version} (${e.license})\n\n${e.text}`).join(sep);
fs.writeFileSync(path.join(root, "dist", "THIRD_PARTY_LICENSES.txt"), header + sep + body + "\n");
console.log(`dist/THIRD_PARTY_LICENSES.txt: ${entries.length} 件`);
