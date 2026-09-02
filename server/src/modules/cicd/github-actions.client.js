import { ExternalServiceError } from '../../shared/errors.js';
import logger from '../../shared/logger.js';

/**
 * GitHub Actions REST API client for manual reconciliation and fallback queries.
 */
export default class GitHubActionsClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://api.github.com';
  }

  /**
   * Fetch recent workflow runs for a repository.
   */
  async getWorkflowRuns(
    owner,
    name,
    { branch = null, event = null, status = null, limit = 30 } = {}
  ) {
    try {
      const params = new URLSearchParams({ per_page: String(limit) });
      if (branch) params.append('branch', branch);
      if (event) params.append('event', event);
      if (status) params.append('status', status);

      const url = `${this.baseUrl}/repos/${owner}/${name}/actions/runs?${params.toString()}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `token ${this.token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Unified-DevOps-Platform',
        },
      });

      if (response.status === 401 || response.status === 403) {
        const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
        if (rateLimitRemaining === '0') {
          throw new ExternalServiceError('GitHub Actions', 'GitHub API rate limit exceeded');
        }
        throw new ExternalServiceError(
          'GitHub Actions',
          'Invalid or insufficient permissions on token'
        );
      }

      if (response.status === 404) {
        throw new ExternalServiceError('GitHub Actions', `Repository ${owner}/${name} not found`);
      }

      if (!response.ok) {
        throw new ExternalServiceError(
          'GitHub Actions',
          `GitHub API error (HTTP ${response.status})`
        );
      }

      const data = await response.json();
      return (data.workflow_runs || []).map((run) => ({
        id: run.id,
        name: run.name,
        workflow_id: run.workflow_id,
        head_branch: run.head_branch,
        head_sha: run.head_sha,
        path: run.path,
        run_number: run.run_number,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        html_url: run.html_url,
        run_started_at: run.run_started_at,
        updated_at: run.updated_at,
        actor: {
          login: run.actor?.login || 'github-actions',
          avatar_url: run.actor?.avatar_url || '',
        },
        head_commit: run.head_commit
          ? {
              id: run.head_commit.id,
              message: run.head_commit.message,
            }
          : null,
        pull_requests: (run.pull_requests || []).map((pr) => ({
          number: pr.number,
          head: { ref: pr.head?.ref, sha: pr.head?.sha },
          base: { ref: pr.base?.ref, sha: pr.base?.sha },
        })),
      }));
    } catch (err) {
      if (err instanceof ExternalServiceError) throw err;
      logger.error(`GitHub Actions API error for ${owner}/${name}:`, err.message);
      throw new ExternalServiceError('GitHub Actions', err.message);
    }
  }
}
