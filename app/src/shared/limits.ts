// Image limits shared by client (resizing) and server (validation).

/** Long edge of the stored photo. Enough for logos and fine print, ~200-450 KB as JPEG. */
export const FULL_MAX_EDGE = 1600;
export const FULL_JPEG_QUALITY = 0.86;
/** Long edge of the list/grid thumbnail. */
export const THUMB_MAX_EDGE = 480;
export const THUMB_JPEG_QUALITY = 0.8;

export const MAX_FULL_BYTES = 5 * 1024 * 1024;
export const MAX_THUMB_BYTES = 512 * 1024;
export const MAX_IMAGE_EDGE = 4096;
export const MIN_IMAGE_EDGE = 64;

export const MAX_PHOTOS_PER_ITEM = 8;
export const MAX_TEXT_FIELD = 2000;
export const MAX_SHORT_FIELD = 200;

/** How many items the scan screen shows. */
export const CANDIDATE_LIMIT = 5;
