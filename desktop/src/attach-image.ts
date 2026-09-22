// Pictures in chat: a file, a paste, or a screen capture, all becoming the
// same thing -- a JPEG/PNG data URL small enough to send. Vision models read
// ~1.5k px at most, so anything bigger is scaled down here rather than
// shipping megabytes the provider would shrink anyway.
export const MAX_SIDE = 1568;
export const MAX_IMAGES = 4;

/** Scale an image source into a data URL no wider or taller than MAX_SIDE. */
function drawScaled(source: CanvasImageSource, width: number, height: number, keepPng: boolean): string {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  // Screenshots and diagrams keep crisp edges as PNG; photos go JPEG.
  return keepPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
}

/** An image File (upload or paste) -> a data URL ready to send. */
export async function imageFileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    return drawScaled(bitmap, bitmap.width, bitmap.height, file.type === 'image/png');
  } finally {
    bitmap.close();
  }
}

/** One frame of a screen or window the person picks, via the system picker. */
export async function captureScreen(): Promise<string> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // One frame for the picker's own overlay to clear.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return drawScaled(video, video.videoWidth, video.videoHeight, true);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** The image files on a clipboard or drop, if any. */
export function imagesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files || []).filter((f) => f.type.startsWith('image/'));
}

/** A user turn with pictures, in the OpenAI parts shape the engine forwards. */
export function withImages(text: string, images?: string[]): string | Array<Record<string, unknown>> {
  if (!images || !images.length) return text;
  return [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}
