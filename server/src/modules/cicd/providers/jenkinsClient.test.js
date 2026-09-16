import { jest } from '@jest/globals';
import JenkinsClient from './jenkinsClient.js';

describe('Phase 2C — JenkinsClient (SSRF & Safe Outbound Requests)', () => {
  describe('Constructor URL & Protocol Validation', () => {
    it('accepts valid http and https server URLs', () => {
      const clientHttp = new JenkinsClient({ serverUrl: 'http://localhost:8080' });
      expect(clientHttp.canonicalOrigin).toBe('http://localhost:8080');

      const clientHttps = new JenkinsClient({
        serverUrl: 'https://ci.corp.internal:8443/jenkins/',
      });
      expect(clientHttps.canonicalOrigin).toBe('https://ci.corp.internal:8443');
      expect(clientHttps.basePath).toBe('/jenkins');
    });

    it('rejects unsupported protocols (ftp, file, gopher, javascript)', () => {
      expect(() => new JenkinsClient({ serverUrl: 'ftp://jenkins.internal' })).toThrow(
        /Unsupported Jenkins protocol/
      );
      expect(() => new JenkinsClient({ serverUrl: 'file:///etc/passwd' })).toThrow(
        /Unsupported Jenkins protocol/
      );
      expect(() => new JenkinsClient({ serverUrl: 'gopher://malicious.host' })).toThrow(
        /Unsupported Jenkins protocol/
      );
    });

    it('rejects missing or malformed server URLs', () => {
      expect(() => new JenkinsClient({})).toThrow(/serverUrl is required/);
      expect(() => new JenkinsClient({ serverUrl: 'not-a-valid-url' })).toThrow(
        /Invalid Jenkins server URL/
      );
    });
  });

  describe('Origin-Bound URL Construction', () => {
    it('builds strictly origin-bound URLs preventing path traversal', () => {
      const client = new JenkinsClient({ serverUrl: 'http://192.168.1.100:8080/ci' });
      const builtUrl = client._buildUrl('/job/my-job/api/json');

      expect(builtUrl.origin).toBe('http://192.168.1.100:8080');
      expect(builtUrl.pathname).toBe('/ci/job/my-job/api/json');
    });

    it('attaches query parameters safely', () => {
      const client = new JenkinsClient({ serverUrl: 'http://jenkins.local:8080' });
      const builtUrl = client._buildUrl('/job/test/api/json', {
        tree: 'builds[id,number]',
        limit: 5,
      });

      expect(builtUrl.searchParams.get('tree')).toBe('builds[id,number]');
      expect(builtUrl.searchParams.get('limit')).toBe('5');
    });
  });

  describe('SSRF Redirect Interception & Credential Scoping', () => {
    it('aborts when a redirect attempts to steer to a different origin', async () => {
      const client = new JenkinsClient({
        serverUrl: 'http://internal-jenkins:8080',
        username: 'admin',
        apiToken: 'secret-token',
      });

      // Mock fetch returning a 302 redirect to external origin
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 302,
        headers: {
          get: (header) =>
            header.toLowerCase() === 'location' ? 'https://attacker.com/steal-creds' : null,
        },
      });

      await expect(client.getJobInfo('safe-job')).rejects.toThrow(
        /Cross-origin redirect forbidden/
      );
    });

    it('allows redirects within the same origin', async () => {
      const client = new JenkinsClient({
        serverUrl: 'http://internal-jenkins:8080',
      });

      // Mock fetch: first call redirects to /job/safe-job/api/json/, second call succeeds
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          status: 301,
          headers: {
            get: (header) =>
              header.toLowerCase() === 'location'
                ? 'http://internal-jenkins:8080/job/safe-job/api/json/'
                : null,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ name: 'safe-job', builds: [] }),
        });

      const data = await client.getJobInfo('safe-job');
      expect(data.name).toBe('safe-job');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
