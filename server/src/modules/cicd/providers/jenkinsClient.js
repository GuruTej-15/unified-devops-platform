export default class JenkinsClient {
  constructor({ serverUrl, username = '', apiToken = '' }) {
    if (!serverUrl) {
      throw new Error('Jenkins serverUrl is required');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(serverUrl);
    } catch {
      throw new Error(`Invalid Jenkins server URL: ${serverUrl}`);
    }

    // SSRF Constraint 1: Only http and https protocols are allowed
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(
        `Unsupported Jenkins protocol: ${parsedUrl.protocol}. Only http and https are supported.`
      );
    }

    this.canonicalOrigin = parsedUrl.origin;
    // Base path on server (e.g. /jenkins or /)
    this.basePath = parsedUrl.pathname.replace(/\/+$/, '');
    this.username = username;
    this.apiToken = apiToken;
  }

  /**
   * Constructs an authorized, origin-bound request URL.
   */
  _buildUrl(endpointPath, queryParams = null) {
    const cleanEndpoint = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
    const fullPath = `${this.basePath}${cleanEndpoint}`;
    const url = new URL(fullPath, this.canonicalOrigin);

    if (queryParams && typeof queryParams === 'object') {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Ensure origin was not manipulated
    if (url.origin !== this.canonicalOrigin) {
      throw new Error(
        `Security Violation: Target origin '${url.origin}' does not match configured origin '${this.canonicalOrigin}'`
      );
    }

    return url;
  }

  /**
   * Safe fetch with origin-checked redirect tracking and credential scoping.
   */
  async _safeFetch(url, options = {}, maxRedirects = 3) {
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      // Origin check
      if (currentUrl.origin !== this.canonicalOrigin) {
        throw new Error(
          `Security Error: Unsafe cross-origin redirect detected to ${currentUrl.origin}`
        );
      }

      const headers = {
        Accept: 'application/json',
        ...(options.headers || {}),
      };

      // Credential scoping: attach Basic auth only to canonical origin
      if (this.username && this.apiToken) {
        const credentials = Buffer.from(`${this.username}:${this.apiToken}`).toString('base64');
        headers.Authorization = `Basic ${credentials}`;
      }

      const response = await fetch(currentUrl.toString(), {
        ...options,
        headers,
        redirect: 'manual', // Intercept redirects manually
      });

      // Handle redirects manually to enforce origin restriction
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Jenkins redirect response missing Location header`);
        }

        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.origin !== this.canonicalOrigin) {
          throw new Error(
            `Security Error: Cross-origin redirect forbidden: ${currentUrl.origin} -> ${nextUrl.origin}`
          );
        }

        currentUrl = nextUrl;
        redirectCount++;
        continue;
      }

      if (!response.ok) {
        const status = response.status;
        const bodyText = await response.text().catch(() => '');
        throw new Error(`Jenkins API error (${status}): ${bodyText.slice(0, 200)}`);
      }

      return await response.json();
    }

    throw new Error(`Exceeded maximum redirect limit (${maxRedirects})`);
  }

  /**
   * Fetch Jenkins job details and build list.
   */
  async getJobInfo(jobName) {
    const endpoint = `/job/${encodeURIComponent(jobName)}/api/json`;
    const url = this._buildUrl(endpoint);
    return await this._safeFetch(url);
  }

  /**
   * Fetch recent build runs with details tree.
   */
  async getBuildRuns(jobName, { limit = 30 } = {}) {
    const endpoint = `/job/${encodeURIComponent(jobName)}/api/json`;
    const query = {
      tree: `builds[id,number,url,result,building,duration,timestamp,actions[causes[userName,userId],buildsByBranchName[*]],changeSets[items[commitId,comment,msg]]]{0,${limit}}`,
    };
    const url = this._buildUrl(endpoint, query);
    const data = await this._safeFetch(url);
    return data.builds || [];
  }

  /**
   * Fetch single build details.
   */
  async getBuildDetails(jobName, buildNumber) {
    const endpoint = `/job/${encodeURIComponent(jobName)}/${encodeURIComponent(buildNumber)}/api/json`;
    const url = this._buildUrl(endpoint);
    return await this._safeFetch(url);
  }
}
