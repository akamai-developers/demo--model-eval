import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractPdf(data: Uint8Array, name: string, byteLimit: number): Promise<string> {
  const task = getDocument({ data, useWorkerFetch: false, useWasm: false, disableFontFace: true });
  const encoder = new TextEncoder();
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 40) throw new Error(`${name} exceeds the 40-page PDF limit.`);
    const pages: string[] = [];
    let size = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const reader = page.streamTextContent().getReader();
      const lines: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of value.items) {
          if (!("str" in item)) continue;
          const part = item.str + (item.hasEOL ? "\n" : " ");
          size += encoder.encode(part).length;
          if (size > byteLimit) throw new Error(`${name} exceeds the 128 KiB extracted text limit. Choose fewer pages.`);
          lines.push(part);
        }
      }
      const text = lines.join("").trim();
      if (text) pages.push(text);
      page.cleanup();
    }
    if (!pages.length) throw new Error(`${name} has no selectable text. Attach a page image or a PDF with a text layer.`);
    return pages.join("\n\n");
  } catch (cause) {
    if (cause instanceof Error) {
      if (cause.name === "PasswordException") throw new Error(`${name} is password protected. Choose an unlocked copy.`);
      if (cause.message.startsWith(name)) throw cause;
    }
    throw new Error(`Could not read ${name} as a PDF.`);
  } finally {
    await task.destroy();
  }
}
