import JenkinsProvider, { verifyJenkinsToken } from './jenkinsProvider.js';
import { CI_PROVIDER, PIPELINE_STATUS, PIPELINE_CONCLUSION } from '../../../shared/constants.js';

describe('Phase 2C — JenkinsProvider Adapter', () => {
  const provider = new JenkinsProvider();

  describe('verifyJenkinsToken (Constant-time token verification)', () => {
    const validSecret = 'super-secret-jenkins-token-12345';

    it('returns true for an exact matching token', () => {
      expect(verifyJenkinsToken(validSecret, validSecret)).toBe(true);
    });

    it('returns false for a mismatched token of identical length', () => {
      const wrongSecret = 'super-secret-jenkins-token-99999';
      expect(verifyJenkinsToken(wrongSecret, validSecret)).toBe(false);
    });

    it('returns false for tokens of different lengths', () => {
      expect(verifyJenkinsToken('short-token', validSecret)).toBe(false);
      expect(verifyJenkinsToken(validSecret, 'short-token')).toBe(false);
    });

    it('returns false if provided token or secret is empty, null, or undefined', () => {
      expect(verifyJenkinsToken('', validSecret)).toBe(false);
      expect(verifyJenkinsToken(validSecret, '')).toBe(false);
      expect(verifyJenkinsToken(null, validSecret)).toBe(false);
      expect(verifyJenkinsToken(validSecret, null)).toBe(false);
      expect(verifyJenkinsToken(undefined, undefined)).toBe(false);
    });
  });

  describe('extractDeliveryMetadata', () => {
    it('uses X-Jenkins-Delivery header when present', () => {
      const req = {
        headers: {
          'x-jenkins-delivery': 'custom-delivery-uuid-999',
          'x-jenkins-event': 'build',
        },
        body: { build: { number: 10, phase: 'STARTED' } },
        rawBody: '{"build":{"number":10}}',
      };

      const meta = provider.extractDeliveryMetadata(req, { integrationId: 'int-123' });
      expect(meta.deliveryId).toBe('custom-delivery-uuid-999');
      expect(meta.event).toBe('build');
      expect(meta.action).toBe('started');
    });

    it('synthesizes collision-safe deterministic identity when header absent', () => {
      const req = {
        headers: {},
        body: { build: { number: 42, phase: 'FINALIZED' } },
        rawBody: '{"build":{"number":42}}',
      };

      const meta = provider.extractDeliveryMetadata(req, {
        integrationId: '6aa5d30dc5fc8ca15076725e',
      });
      expect(meta.deliveryId).toBe('jenkins:6aa5d30dc5fc8ca15076725e:42:finalized');
      expect(meta.action).toBe('finalized');
    });
  });

  describe('normalizeWebhookPayload', () => {
    const mockIntegration = {
      _id: 'integration-abc-123',
      jobName: 'Payment-Service-Build',
    };
    const mockRepo = {
      _id: 'repo-456',
      externalId: '1354528014',
    };

    it('normalizes a STARTED build into in_progress status with null conclusion', async () => {
      const payload = {
        name: 'Payment-Service-Build',
        build: {
          number: 5,
          phase: 'STARTED',
          scm: {
            commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
            branch: 'origin/feature/PAY-101-auth',
            commitMessage: 'feat(pay): add payment validation PAY-101',
          },
          causes: [{ userName: 'developer-jane' }],
          full_url: 'http://jenkins.local:8080/job/Payment-Service-Build/5/',
        },
      };

      const normalized = await provider.normalizeWebhookPayload(
        payload,
        { deliveryId: 'del-1' },
        { integration: mockIntegration, repository: mockRepo }
      );

      expect(normalized.provider).toBe(CI_PROVIDER.JENKINS);
      expect(normalized.jenkinsIntegration).toBe('integration-abc-123');
      expect(normalized.runNumber).toBe(5);
      expect(normalized.externalRunId).toBe('5');
      expect(normalized.workflowName).toBe('Payment-Service-Build');
      expect(normalized.status).toBe(PIPELINE_STATUS.IN_PROGRESS);
      expect(normalized.conclusion).toBeNull();
      expect(normalized.commitSha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
      expect(normalized.branch).toBe('feature/PAY-101-auth'); // Stripped origin/
      expect(normalized.actor.login).toBe('developer-jane');
      expect(normalized.textForIssueKeyExtraction).toContain('feature/PAY-101-auth');
      expect(normalized.textForIssueKeyExtraction).toContain(
        'feat(pay): add payment validation PAY-101'
      );
    });

    it('normalizes a COMPLETED + SUCCESS build into completed status with success conclusion', async () => {
      const payload = {
        name: 'Payment-Service-Build',
        build: {
          number: 5,
          phase: 'FINALIZED',
          status: 'SUCCESS',
          duration: 18500, // 18.5 seconds in ms
          scm: {
            commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
            branch: 'refs/heads/main',
          },
          full_url: 'http://jenkins.local:8080/job/Payment-Service-Build/5/',
        },
      };

      const normalized = await provider.normalizeWebhookPayload(
        payload,
        { deliveryId: 'del-2' },
        { integration: mockIntegration, repository: mockRepo }
      );

      expect(normalized.status).toBe(PIPELINE_STATUS.COMPLETED);
      expect(normalized.conclusion).toBe(PIPELINE_CONCLUSION.SUCCESS);
      expect(normalized.duration).toBe(19); // 18.5 rounded
      expect(normalized.branch).toBe('main'); // Stripped refs/heads/
    });

    it('normalizes a FAILURE build into completed status with failure conclusion', async () => {
      const payload = {
        build: {
          number: 6,
          phase: 'COMPLETED',
          status: 'FAILURE',
          scm: {},
        },
      };

      const normalized = await provider.normalizeWebhookPayload(
        payload,
        { deliveryId: 'del-3' },
        { integration: mockIntegration, repository: mockRepo }
      );

      expect(normalized.status).toBe(PIPELINE_STATUS.COMPLETED);
      expect(normalized.conclusion).toBe(PIPELINE_CONCLUSION.FAILURE);
    });

    it('normalizes an ABORTED build into completed status with cancelled conclusion', async () => {
      const payload = {
        build: {
          number: 7,
          phase: 'FINALIZED',
          status: 'ABORTED',
        },
      };

      const normalized = await provider.normalizeWebhookPayload(
        payload,
        { deliveryId: 'del-4' },
        { integration: mockIntegration, repository: mockRepo }
      );

      expect(normalized.status).toBe(PIPELINE_STATUS.COMPLETED);
      expect(normalized.conclusion).toBe(PIPELINE_CONCLUSION.CANCELLED);
    });

    it('handles partial webhook payload without fabricating commitSha or timestamps', async () => {
      const payload = {
        buildNumber: 12,
        phase: 'STARTED',
      };

      const normalized = await provider.normalizeWebhookPayload(
        payload,
        { deliveryId: 'del-partial' },
        { integration: mockIntegration, repository: mockRepo }
      );

      expect(normalized.runNumber).toBe(12);
      expect(normalized.commitSha).toBe(''); // Not fabricated
      expect(normalized.branch).toBe('');
      expect(normalized.startedAt).toBeNull(); // Not fabricated
      expect(normalized.duration).toBeNull();
    });

    it('extracts commit messages and commits from changeSet items', async () => {
      const payload = {
        build: {
          number: 8,
          phase: 'FINALIZED',
          status: 'SUCCESS',
          changeSet: {
            items: [
              {
                commitId: 'abcdef1234567890abcdef1234567890abcdef12',
                comment: 'fix(checkout): resolve race condition PAY-202',
              },
            ],
          },
        },
      };

      const normalized = await provider.normalizeWebhookPayload(
        payload,
        { deliveryId: 'del-cs' },
        { integration: mockIntegration, repository: mockRepo }
      );

      expect(normalized.commitSha).toBe('abcdef1234567890abcdef1234567890abcdef12');
      expect(normalized.textForIssueKeyExtraction).toContain(
        'fix(checkout): resolve race condition PAY-202'
      );
    });
  });
});
