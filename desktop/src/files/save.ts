// Saving a generated file from the desktop shell. Under Tauri, a save
// dialog runs through a tiny Rust command -- the JS dialog/fs plugins would
// pull their whole capability surface into the bundle for one call. In a
// plain browser (vite dev), the same helper falls back to a download, so
// the screen works in both worlds with one call site.

type SaveArgs = { name: string; bytes: Uint8Array; mime: string };

export async function saveFile({ name, bytes, mime }: SaveArgs): Promise<string> {
  const w = window as any;
  // __TAURI_INTERNALS__.invoke is the runtime bridge the shell injects;
  // importing '@tauri-apps/api' would drag its whole surface into the
  // bundle for one call.
  if (w.__TAURI_INTERNALS__ && typeof w.__TAURI_INTERNALS__.invoke === 'function') {
    const b64 = bytesToBase64(bytes);
    return w.__TAURI_INTERNALS__.invoke('save_file_dialog', {
      fileName: name,
      mime,
      bodyBase64: b64,
    }) as Promise<string>;
  }
  // Browser fallback: an <a download> click.
  return new Promise((resolve, reject) => {
    try {
      const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      resolve(`Saved ${name} to your downloads.`);
    } catch (err) {
      reject(err as Error);
    }
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
