import { AppError } from '@chains/shared';
import { config } from '../config.js';

/**
 * Avatar URL policy (audit L-4).
 *
 * Today we only VALIDATE the URL: `https:` scheme, no embedded credentials, a
 * real host, an optional host allowlist, and a hard length cap. The browser
 * still fetches it directly, which leaks the viewer's IP to a third-party host
 * chosen by another user and lets that host fingerprint viewers.
 *
 * TODO (L-4 follow-up): stop storing third-party URLs at all. Fetch once on
 * write, content-type/size check it, store it under a content hash in object
 * storage, and serve it from our own origin. At that point this function
 * becomes the ingest validator and the column holds a hash, not a URL.
 */
export function normalizeAvatarUrl(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === '') return null;

  if (value.length > config.AVATAR_URL_MAX_LENGTH) {
    throw AppError.badRequest(
      `Avatar URL must be at most ${config.AVATAR_URL_MAX_LENGTH} characters`,
      { reason: 'avatar_too_long' },
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw AppError.badRequest('Avatar URL is not a valid URL', { reason: 'avatar_invalid' });
  }

  if (url.protocol !== 'https:') {
    throw AppError.badRequest('Avatar URL must use https', { reason: 'avatar_scheme' });
  }
  if (url.username !== '' || url.password !== '') {
    throw AppError.badRequest('Avatar URL must not contain credentials', {
      reason: 'avatar_credentials',
    });
  }
  if (url.hostname === '') {
    throw AppError.badRequest('Avatar URL must have a host', { reason: 'avatar_invalid' });
  }

  const allowlist = config.AVATAR_HOST_ALLOWLIST;
  if (allowlist.length > 0 && !allowlist.includes(url.hostname.toLowerCase())) {
    throw AppError.badRequest('Avatar URL host is not on the allowlist', {
      reason: 'avatar_host',
      allowed: allowlist,
    });
  }

  return url.toString();
}
