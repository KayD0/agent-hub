import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PastedAttachment } from "../../domain/codex-input";

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class ImageInputStore {
  public constructor(private readonly rootPath: string) {}

  public async save(images: readonly PastedAttachment[]): Promise<string[]> {
    if (images.length > MAX_ATTACHMENTS) throw new Error(`添付ファイルは一度に${MAX_ATTACHMENTS}件まで送信できます。`);
    if (!images.length) return [];
    await fs.mkdir(this.rootPath, { recursive: true });
    const saved: string[] = [];
    try {
      for (const image of images) {
        const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "application/pdf" ? "pdf" : undefined;
        if (!extension) throw new Error("添付可能なファイルはPNG、JPEG、PDFです。");
        const prefix = `data:${image.mimeType};base64,`;
        if (!image.dataUrl.startsWith(prefix)) throw new Error("添付ファイルの形式が不正です。");
        const content = Buffer.from(image.dataUrl.slice(prefix.length), "base64");
        if (!content.length || content.length > MAX_ATTACHMENT_BYTES) throw new Error("添付ファイルは1件10MB以内にしてください。");
        const validSignature = image.mimeType === "image/png"
          ? content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : image.mimeType === "image/jpeg"
          ? content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
          : content.subarray(0, 5).equals(Buffer.from("%PDF-"));
        if (!validSignature) throw new Error("添付ファイルの内容と形式が一致しません。");
        const target = path.join(this.rootPath, `${crypto.randomUUID()}.${extension}`);
        await fs.writeFile(target, content, { flag: "wx" });
        saved.push(target);
      }
      return saved;
    } catch (error) {
      await this.remove(saved);
      throw error;
    }
  }

  public async remove(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map(async (target) => { try { await fs.rm(target); } catch { /* best effort */ } }));
  }
}

export function parsePastedImages(value: unknown): PastedAttachment[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return undefined;
  const images: PastedAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const candidate = item as Record<string, unknown>;
    if ((candidate.mimeType !== "image/png" && candidate.mimeType !== "image/jpeg" && candidate.mimeType !== "application/pdf") || typeof candidate.dataUrl !== "string") return undefined;
    if (candidate.name !== undefined && typeof candidate.name !== "string") return undefined;
    images.push({ mimeType: candidate.mimeType, dataUrl: candidate.dataUrl, ...(typeof candidate.name === "string" ? { name: candidate.name.slice(0, 255) } : {}) });
  }
  return images;
}
