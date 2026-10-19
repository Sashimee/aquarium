export interface ShareTarget {
  canShare?(data: ShareData): boolean;
  share?(data: ShareData): Promise<void>;
}

export interface DownloadHost {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): Pick<HTMLAnchorElement, 'href' | 'download' | 'click'>;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function photoFileName(when: Date): string {
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `aquarium-${date}-${time}.png`;
}

export function photoFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: 'image/png' });
}

export function canSharePhoto(target: ShareTarget, file: File): boolean {
  return typeof target.share === 'function' && target.canShare?.({ files: [file] }) === true;
}

export type ShareOutcome = 'shared' | 'cancelled';

/** A dismissed share sheet is the player's choice, not a failure. */
export async function sharePhoto(target: ShareTarget, file: File): Promise<ShareOutcome> {
  if (!canSharePhoto(target, file)) {
    throw new Error('This browser cannot share pictures. Save the picture instead.');
  }
  try {
    await target.share?.({ files: [file], title: 'My aquarium' });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error('Sharing was blocked by the browser. Save the picture instead.', {
        cause: error,
      });
    }
    throw new Error('Sharing failed. Save the picture instead.', { cause: error });
  }
}

const REVOKE_DELAY_MS = 10_000;

export function downloadPhoto(host: DownloadHost, blob: Blob, name: string): void {
  const url = host.createObjectURL(blob);
  const anchor = host.createAnchor();
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => host.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export const browserDownloadHost: DownloadHost = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  createAnchor: () => document.createElement('a'),
};
