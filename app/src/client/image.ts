// Client-side photo preparation: decode (browsers apply EXIF orientation when drawing an
// <img>), downscale, and re-encode as JPEG. Re-encoding also strips EXIF metadata such as GPS.

import { FULL_JPEG_QUALITY, FULL_MAX_EDGE, THUMB_JPEG_QUALITY, THUMB_MAX_EDGE } from "../shared/limits";

export interface PreparedImage {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  previewUrl: string;
  name: string | null;
}

export class ImageError extends Error {}

async function decode(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageError(
      /heic|heif/i.test(file.type) || (file instanceof File && /\.hei[cf]$/i.test(file.name))
        ? "This browser can't read HEIC photos. Use the camera button, or set your phone to save photos as 'Most Compatible' (JPEG)."
        : "That file couldn't be read as a photo.",
    );
  }
  URL.revokeObjectURL(url);
  return img;
}

function render(img: HTMLImageElement, maxEdge: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageError("Couldn't process the photo on this device.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff"; // flatten transparent PNGs
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        // Release canvas memory early (iOS has a tight canvas budget).
        canvas.width = canvas.height = 0;
        blob ? resolve({ blob, width, height }) : reject(new ImageError("Couldn't encode the photo."));
      },
      "image/jpeg",
      quality,
    ),
  );
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (file.size > 60 * 1024 * 1024) throw new ImageError("That file is too large to be a photo.");
  const img = await decode(file);
  if (Math.min(img.naturalWidth, img.naturalHeight) < 64) throw new ImageError("That photo is too small.");
  const full = await render(img, FULL_MAX_EDGE, FULL_JPEG_QUALITY);
  const thumb = await render(img, THUMB_MAX_EDGE, THUMB_JPEG_QUALITY);
  return {
    full: full.blob,
    thumb: thumb.blob,
    width: full.width,
    height: full.height,
    previewUrl: URL.createObjectURL(full.blob),
    name: file instanceof File ? file.name : null,
  };
}
