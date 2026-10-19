// Collapsing // matters outside the auth proxy (which refuses it): referrer policy and log redaction.
export function normalizedPathname(url: string): string {
  const raw = url.split('?')[0]?.split('#')[0] ?? '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return '/' + decoded.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}
