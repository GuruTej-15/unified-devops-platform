import { BadRequestError } from './errors.js';

/**
 * Checks if an IPv4 address string falls into a private or loopback range.
 *
 * Covers:
 * - 127.0.0.0/8 (Loopback)
 * - 10.0.0.0/8 (Private RFC 1918)
 * - 172.16.0.0/12 (Private RFC 1918)
 * - 192.168.0.0/16 (Private RFC 1918)
 * - 169.254.0.0/16 (Link-local / Cloud metadata)
 * - 0.0.0.0 (Current network)
 * - 255.255.255.255 (Broadcast)
 *
 * @param {string} ip
 * @returns {{ isPrivate: boolean, isCloudMetadata: boolean }}
 */
function checkIpv4Ranges(ip) {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return { isPrivate: false, isCloudMetadata: false };
  }

  const [p0, p1] = parts;

  // Cloud metadata specifically: 169.254.169.254 (or entire 169.254.0.0/16)
  if (p0 === 169 && p1 === 254) {
    return { isPrivate: true, isCloudMetadata: true };
  }

  // Loopback (127.0.0.0/8)
  if (p0 === 127) {
    return { isPrivate: true, isCloudMetadata: false };
  }

  // Current network (0.0.0.0) or Broadcast
  if (p0 === 0 || (p0 === 255 && p1 === 255)) {
    return { isPrivate: true, isCloudMetadata: false };
  }

  // 10.0.0.0/8
  if (p0 === 10) {
    return { isPrivate: true, isCloudMetadata: false };
  }

  // 172.16.0.0/12 (172.16.0.0 to 172.31.255.255)
  if (p0 === 172 && p1 >= 16 && p1 <= 31) {
    return { isPrivate: true, isCloudMetadata: false };
  }

  // 192.168.0.0/16
  if (p0 === 192 && p1 === 168) {
    return { isPrivate: true, isCloudMetadata: false };
  }

  return { isPrivate: false, isCloudMetadata: false };
}

/**
 * Validates a server URL for security, protocol compliance, and SSRF prevention.
 *
 * Rules:
 * 1. Must be a valid parseable HTTP or HTTPS URL.
 * 2. Embedded credentials (user:pass@host) are forbidden.
 * 3. Cloud metadata addresses (AWS/GCP/Azure) are forbidden unconditionally in all environments.
 * 4. Localhost, loopback, and private RFC 1918 IPs are forbidden in production, and only
 *    allowed in development/test if explicitly opted into via allowPrivate = true.
 *
 * @param {string} urlStr
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate=false] - Explicit opt-in for local dev test environments
 * @returns {string} Normalized URL string
 * @throws {BadRequestError} if validation fails
 */
export function validateServerUrl(urlStr, { allowPrivate = false } = {}) {
  if (!urlStr || typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new BadRequestError('Server URL is required');
  }

  const trimmed = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestError(`Invalid server URL format: '${trimmed}'`);
  }

  // Protocol check: strictly http: or https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestError(
      `Unsupported protocol '${parsed.protocol}'. Only 'http:' and 'https:' are permitted.`
    );
  }

  // Disallow embedded credentials
  if (parsed.username || parsed.password) {
    throw new BadRequestError('Embedded credentials in server URL are not allowed');
  }

  let hostname = parsed.hostname.toLowerCase();
  // Strip IPv6 square brackets if present
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  if (!hostname) {
    throw new BadRequestError('Server URL must include a valid hostname');
  }

  // Unconditional Metadata Blacklist (AWS, GCP, Azure, OpenStack)
  const metadataHosts = [
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.internal',
    'instance-data',
  ];
  if (metadataHosts.includes(hostname) || hostname.startsWith('169.254.')) {
    throw new BadRequestError(
      'SSRF Protection: Access to cloud metadata network addresses is strictly prohibited'
    );
  }

  const isLocalhost =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1';

  const ipv4Check = checkIpv4Ranges(hostname);

  const isPrivateOrLoopback = isLocalhost || ipv4Check.isPrivate;

  // Determine if private IP access is permitted:
  // Strictly forbidden in production; allowed in dev/test only with explicit allowPrivate flag
  const isProduction = process.env.NODE_ENV === 'production';
  const explicitlyAllowed =
    !isProduction && (allowPrivate || process.env.ALLOW_PRIVATE_ORCHESTRATION_URLS === 'true');

  if (isPrivateOrLoopback && !explicitlyAllowed) {
    throw new BadRequestError(
      'SSRF Protection: Private, loopback, or internal network addresses are not allowed'
    );
  }

  // Return clean normalized URL without trailing slash
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}${parsed.search}`;
}
