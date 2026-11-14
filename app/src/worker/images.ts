// Upload validation and R2 storage for photos.
//
// The client re-encodes every photo to JPEG (fixing orientation and stripping EXIF/GPS),
// so the server only accepts JPEG and verifies that the bytes really are one.

import { MAX_FULL_BYTES, MAX_IMAGE_EDGE, MAX_THUMB_BYTES, MIN_IMAGE_EDGE } from "../shared/limits";
import { badRequest } from "./errors";

export interface ValidatedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Read width/height from a baseline or progressive JPEG's SOF marker. Returns null if not a JPEG. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return { width, height };
    }
    if (marker === 0xda) return null; // reached scan data without a frame header
    i += 2 + len;
  }
  return null;
}

export async function validateJpeg(file: unknown, kind: "full" | "thumb"): Promise<ValidatedImage> {
  if (!(file instanceof File) && !(file instanceof Blob)) throw badRequest(`Missing ${kind} image`, "invalid_image");
  const max = kind === "full" ? MAX_FULL_BYTES : MAX_THUMB_BYTES;
  if (file.size === 0) throw badRequest(`Empty ${kind} image`, "invalid_image");
  if (file.size > max) throw badRequest(`${kind} image is too large (max ${Math.round(max / 1024)} KB)`, "image_too_large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = jpegSize(bytes);
  if (!size) throw badRequest(`${kind} image must be a JPEG`, "invalid_image");
  const edge = Math.max(size.width, size.height);
  if (edge > MAX_IMAGE_EDGE || Math.min(size.width, size.height) < (kind === "full" ? MIN_IMAGE_EDGE : 16)) {
    throw badRequest(`${kind} image dimensions out of range`, "invalid_image");
  }
  return { bytes, ...size };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const photoKeys = (photoId: string) => ({
  full: `photos/${photoId}/full.jpg`,
  thumb: `photos/${photoId}/thumb.jpg`,
});

export async function putPhoto(bucket: R2Bucket, photoId: string, full: Uint8Array, thumb: Uint8Array, sha256: string) {
  const keys = photoKeys(photoId);
  const httpMetadata = { contentType: "image/jpeg" };
  await Promise.all([
    bucket.put(keys.full, full, { httpMetadata, sha256 }),
    bucket.put(keys.thumb, thumb, { httpMetadata }),
  ]);
  return keys;
}

export async function deletePhotoObjects(bucket: R2Bucket, keys: string[]) {
  if (keys.length) await bucket.delete(keys);
}
