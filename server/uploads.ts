/**
 * Images the owner attaches to a chat message.
 *
 * The file lives on disk under data/uploads/<company_id>/ and the message row keeps only its
 * name. Putting the bytes in the row would mean replaying a base64 image into every later prompt
 * in the thread and shipping it to the browser on every poll — the same mistake the task list was
 * making with agent output, one order of magnitude worse.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './db.ts';

export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

/** What the model is actually able to read, and what a browser will render back. */
const TYPES: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
};
const BY_EXT = Object.fromEntries(Object.entries(TYPES).map(([mime, ext]) => [ext, mime]));

/**
 * Vision is billed by image, and a phone photo is several megabytes before base64 adds a third
 * again. Nightshift has no image library to downscale with, so the limit is the control.
 */
export const MAX_BYTES = 4 * 1024 * 1024;

export interface SavedImage { file: string; mime: string; bytes: number }

/** Accepts a `data:image/...;base64,...` URL from the browser. Throws with a readable reason. */
export function saveImage(companyId: number, dataUrl: string): SavedImage {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) throw new Error('That does not look like an image.');
  const mime = m[1].toLowerCase();
  const ext = TYPES[mime];
  if (!ext) throw new Error(`${mime} is not an image type the model can read — use PNG, JPEG, WebP or GIF.`);

  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('That image is empty.');
  if (buf.length > MAX_BYTES) {
    throw new Error(`That image is ${(buf.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB.`);
  }

  const dir = path.join(UPLOADS_DIR, String(companyId));
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return { file, mime, bytes: buf.length };
}

/** Resolves a stored name to a path inside that company's folder, or null. Never escapes it. */
function resolve(companyId: number, file: string): string | null {
  // The name is generated above, but it arrives back from the database, so treat it as input.
  if (!/^[\w.-]+$/.test(file) || file.includes('..')) return null;
  const full = path.join(UPLOADS_DIR, String(companyId), file);
  const root = path.join(UPLOADS_DIR, String(companyId)) + path.sep;
  if (!full.startsWith(root) || !fs.existsSync(full)) return null;
  return full;
}

export function readImage(companyId: number, file: string): { body: Buffer; mime: string } | null {
  const full = resolve(companyId, file);
  if (!full) return null;
  return { body: fs.readFileSync(full), mime: BY_EXT[path.extname(full).toLowerCase()] ?? 'application/octet-stream' };
}

/** The form the model wants: the image back as a data URL. */
export function imageDataUrl(companyId: number, file: string): string | null {
  const img = readImage(companyId, file);
  return img && `data:${img.mime};base64,${img.body.toString('base64')}`;
}

/** Deleting a conversation should not leave its pictures behind. */
export function deleteImages(companyId: number, files: string[]) {
  for (const f of files) {
    const full = resolve(companyId, f);
    if (full) try { fs.unlinkSync(full); } catch { /* already gone is fine */ }
  }
}
