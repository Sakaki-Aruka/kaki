// PDFKit のブラウザ版（ESM）。型は export.ts 側で必要な範囲だけ宣言する
declare module "pdfkit" {
  const PDFDocument: new (options?: object) => unknown;
  export default PDFDocument;
}
