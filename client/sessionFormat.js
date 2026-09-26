/** Display helpers for the session views. Pure functions, no state. */

export function tokens(n) {
  if (n == null || Number.isNaN(n)) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function duration(ms) {
  if (ms == null || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} days`;
}

export function when(iso) {
  if (!iso) return '–';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '–';
  const ago = Date.now() - t;
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.round(ago / 60_000)} min ago`;
  if (ago < 86_400_000) return `${Math.round(ago / 3_600_000)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: ago > 300 * 86_400_000 ? 'numeric' : undefined });
}

export function clock(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

export function usd(n) {
  if (n == null) return '–';
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * Comparable path key. Case is folded and separators unified because the paths
 * compared here come from Windows, where both are insignificant; on POSIX this
 * could only confuse two files differing by case alone.
 */
export function pathKey(p) {
  return String(p || '').replace(/\//g, '\\').toLowerCase();
}
