import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PastedImage } from "../../domain/codex-input";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class ImageInputStore {
  public constructor(private readonly rootPath: string) {}

  public async save(images: readonly PastedImage[]): Promise<string[]> {
    if (images.length > MAX_IMAGES) throw new Error(`画像は一度に${MAX_IMAGES}枚まで送信できます。`);
    if (!images.length) return [];
    await fs.mkdir(this.rootPath, { recursive: true });
    const saved: string[] = [];
    try {
      for (const image of images) {
        const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpg" : undefined;
        if (!extension) throw new Error("貼り付け可能な画像はPNGまたはJPEGです。");
        const prefix = `data:${image.mimeType};base64,`;
        if (!image.dataUrl.startsWith(prefix)) throw new Error("画像データの形式が不正です。");
        const content = Buffer.from(image.dataUrl.slice(prefix.length), "base64");
        if (!content.length || content.length > MAX_IMAGE_BYTES) throw new Error("画像は1枚10MB以内にしてください。");
        const validSignature = image.mimeType === "image/png"
          ? content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
        if (!validSignature) throw new Error("画像データと形式が一致しません。");
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

export function parsePastedImages(value: unknown): PastedImage[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return undefined;
  const images: PastedImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const candidate = item as Record<string, unknown>;
    if ((candidate.mimeType !== "image/png" && candidate.mimeType !== "image/jpeg") || typeof candidate.dataUrl !== "string") return undefined;
    images.push({ mimeType: candidate.mimeType, dataUrl: candidate.dataUrl });
  }
  return images;
}
