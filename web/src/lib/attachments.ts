import type { ChatContent } from "./api";

type FileInfo = { id: string; name: string; size: number };
export type Attachment = FileInfo & ({ kind: "text"; text: string } | { kind: "image"; dataUrl: string });

const TEXT_EXTENSIONS = "txt md markdown csv tsv json jsonl ndjson yaml yml toml xml html htm css scss js jsx ts tsx mjs cjs py ipynb sql log ini conf sh bash zsh rb rs go java c h cpp hpp cs swift kt php r tex".split(" ");
const TEXT_NAMES = new Set(["makefile", "dockerfile", "readme", "license"]);
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as const;
export const ACCEPT_ATTACHMENTS = ["text/*", ".pdf", "application/pdf", "image/png", "image/jpeg", "image/webp", ...TEXT_EXTENSIONS.map((ext) => "." + ext)].join(",");
export const MAX_FILES = 4;
const TEXT_LIMIT = 128 * 1024;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;

function imageType(data: Uint8Array): string | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => data[i] === byte)) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (String.fromCharCode(...data.subarray(0, 4)) === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP") return "image/webp";
}

function toBase64(data: Uint8Array): string {
  const chunks: string[] = [];
  // Whole groups of three bytes keep padding at the end of the file.
  for (let start = 0; start < data.length; start += 24576) {
    chunks.push(btoa(String.fromCharCode(...data.subarray(start, start + 24576))));
  }
  return chunks.join("");
}

async function readAttachment(file: File): Promise<Attachment> {
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop() ?? "";
  const image = Object.values<string>(IMAGE_TYPES).includes(file.type) || Object.hasOwn(IMAGE_TYPES, ext);
  const pdf = file.type === "application/pdf" || ext === "pdf";
  const text = file.type.startsWith("text/") || TEXT_EXTENSIONS.includes(ext) || TEXT_NAMES.has(name);
  if (!image && !text && !pdf) throw new Error(`${file.name} is unsupported. Choose text, code, a PDF, PNG, JPEG, or WebP.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (file.size > (image || pdf ? IMAGE_LIMIT : TEXT_LIMIT)) {
    throw new Error(`${file.name} exceeds the ${image || pdf ? "4 MiB" : "128 KiB text file"} limit.`);
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const info = { id: crypto.randomUUID(), name: file.name, size: file.size };
  if (pdf) {
    const { extractPdf } = await import("./pdfText");
    return { ...info, kind: "text", text: await extractPdf(data, file.name, TEXT_LIMIT) };
  }
  if (image) {
    const type = imageType(data);
    if (!type) throw new Error(`${file.name} does not contain a PNG, JPEG, or WebP image.`);
    return { ...info, kind: "image", dataUrl: `data:${type};base64,${toBase64(data)}` };
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${file.name} must be saved as UTF-8 text.`);
  }
  if (/[\x00-\x08\x0e-\x1f]/.test(contents)) throw new Error(`${file.name} contains binary data. Choose a UTF-8 text file.`);
  return { ...info, kind: "text", text: contents };
}

export async function addAttachments(existing: Attachment[], files: File[]): Promise<Attachment[]> {
  if (existing.length + files.length > MAX_FILES) throw new Error("Attach up to four files per message.");
  const totalSize = [...existing, ...files].reduce((size, file) => size + file.size, 0);
  if (totalSize > TOTAL_LIMIT) throw new Error("Attachments in one message must total 8 MiB or less.");
  return [...existing, ...await Promise.all(files.map(readAttachment))];
}

export function userContent(prompt: string, attachments: Attachment[] = []): ChatContent {
  if (!attachments.length) return prompt;
  const sections = prompt ? [prompt] : [];
  const images = attachments.filter((file) => file.kind === "image");
  for (const file of attachments) {
    if (file.kind === "text") sections.push(`File: ${file.name}\n${file.text}`);
  }
  if (!images.length) return sections.join("\n\n");
  sections.push(`Images in order: ${images.map((file) => file.name).join(", ")}`);
  return [
    { type: "text", text: sections.join("\n\n") },
    ...images.map((file) => ({ type: "image_url" as const, image_url: { url: file.dataUrl } })),
  ];
}
