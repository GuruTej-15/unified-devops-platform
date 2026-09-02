/**
 * GitHub GraphQL API client.
 *
 * Uses @octokit/graphql for efficient composite queries.
 * Handles pagination, rate limits, and error classification.
 *
 * VCS provider abstraction: this file implements the GitHub-specific client.
 * A parallel gitlab.client.js would implement the same interface for GitLab.
 */

import { graphql } from '@octokit/graphql';
import { ExternalServiceError } from '../../shared/errors.js';
import logger from '../../shared/logger.js';

export default class GitHubClient {
  constructor(token) {
    this.graphqlClient = graphql.defaults({
      headers: {
        authorization: `token ${token}`,
      },
    });
    this.token = token;
  }

  /**
   * Validate that the token is valid and has sufficient permissions.
   */
  async validateToken() {
    try {
      const { viewer } = await this.graphqlClient(`{
        viewer { login }
        rateLimit { remaining limit resetAt }
      }`);
      return { valid: true, login: viewer.login };
    } catch (err) {
      return { valid: false, error: this._classifyError(err) };
    }
  }

  /**
   * Fetch repository metadata by owner/name.
   */
  async getRepository(owner, name) {
    try {
      const { repository } = await this.graphqlClient(
        `
        query GetRepository($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            databaseId
            name
            nameWithOwner
            description
            url
            isPrivate
            defaultBranchRef { name }
            primaryLanguage { name }
            stargazerCount
          }
        }
      `,
        { owner, name }
      );

      return {
        externalId: String(repository.databaseId),
        name: repository.name,
        fullName: repository.nameWithOwner,
        description: repository.description || '',
        htmlUrl: repository.url,
        isPrivate: repository.isPrivate,
        defaultBranch: repository.defaultBranchRef?.name || 'main',
        language: repository.primaryLanguage?.name || null,
        starCount: repository.stargazerCount,
      };
    } catch (err) {
      throw this._handleError(err, `Failed to fetch repository ${owner}/${name}`);
    }
  }

  /**
   * Fetch branches for a repository.
   */
  async getBranches(owner, name, limit = 50) {
    try {
      const { repository } = await this.graphqlClient(
        `
        query GetBranches($owner: String!, $name: String!, $limit: Int!) {
          repository(owner: $owner, name: $name) {
            refs(refPrefix: "refs/heads/", first: $limit, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
              nodes {
                name
                target {
                  ... on Commit {
                    oid
                    message
                    committedDate
                    author { name email }
                  }
                }
              }
            }
          }
        }
      `,
        { owner, name, limit }
      );

      return (repository.refs?.nodes || []).map((branch) => ({
        name: branch.name,
        lastCommit: branch.target
          ? {
              sha: branch.target.oid,
              message: branch.target.message,
              date: branch.target.committedDate,
              author: branch.target.author?.name,
            }
          : null,
      }));
    } catch (err) {
      throw this._handleError(err, 'Failed to fetch branches');
    }
  }

  /**
   * Fetch recent commits with cursor-based pagination.
   */
  async getCommits(owner, name, { branch = null, limit = 30, cursor = null } = {}) {
    try {
      const branchRef = branch || 'HEAD';
      const { repository } = await this.graphqlClient(
        `
        query GetCommits($owner: String!, $name: String!, $branch: String!, $limit: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            ref(qualifiedName: $branch) {
              target {
                ... on Commit {
                  history(first: $limit, after: $cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      oid
                      message
                      committedDate
                      url
                      author {
                        name
                        email
                        avatarUrl
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
        { owner, name, branch: branchRef, limit, cursor }
      );

      const history = repository.ref?.target?.history;
      if (!history) return { commits: [], hasNextPage: false, endCursor: null };

      return {
        commits: history.nodes.map((c) => ({
          sha: c.oid,
          message: c.message,
          authorName: c.author?.name || 'Unknown',
          authorEmail: c.author?.email || '',
          authorAvatar: c.author?.avatarUrl || '',
          authoredAt: c.committedDate,
          url: c.url,
        })),
        hasNextPage: history.pageInfo.hasNextPage,
        endCursor: history.pageInfo.endCursor,
      };
    } catch (err) {
      throw this._handleError(err, 'Failed to fetch commits');
    }
  }

  /**
   * Fetch pull requests with cursor-based pagination.
   */
  async getPullRequests(owner, name, { state = 'OPEN', limit = 30, cursor = null } = {}) {
    try {
      const states = state === 'ALL' ? ['OPEN', 'CLOSED', 'MERGED'] : [state];
      const { repository } = await this.graphqlClient(
        `
        query GetPullRequests($owner: String!, $name: String!, $states: [PullRequestState!]!, $limit: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(first: $limit, after: $cursor, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
              pageInfo { hasNextPage endCursor }
              nodes {
                number
                title
                body
                state
                url
                createdAt
                updatedAt
                mergedAt
                headRefName
                baseRefName
                author {
                  login
                  avatarUrl
                }
              }
            }
          }
        }
      `,
        { owner, name, states, limit, cursor }
      );

      const prs = repository.pullRequests;
      return {
        pullRequests: prs.nodes.map((pr) => ({
          number: pr.number,
          title: pr.title,
          body: pr.body || '',
          state: pr.state.toLowerCase(),
          url: pr.url,
          authorLogin: pr.author?.login || 'ghost',
          authorAvatar: pr.author?.avatarUrl || '',
          sourceBranch: pr.headRefName,
          targetBranch: pr.baseRefName,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          mergedAt: pr.mergedAt,
        })),
        hasNextPage: prs.pageInfo.hasNextPage,
        endCursor: prs.pageInfo.endCursor,
      };
    } catch (err) {
      throw this._handleError(err, 'Failed to fetch pull requests');
    }
  }

  /**
   * Classify and handle GitHub API errors.
   */
  _classifyError(err) {
    const message = err.message || '';

    if (message.includes('Bad credentials') || message.includes('401')) {
      return 'Invalid or expired GitHub token';
    }
    if (message.includes('rate limit') || message.includes('403')) {
      return 'GitHub API rate limit exceeded';
    }
    if (message.includes('Not Found') || message.includes('Could not resolve')) {
      return 'Repository not found or insufficient permissions';
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return 'GitHub API is unreachable';
    }
    return message || 'Unknown GitHub API error';
  }

  _handleError(err, context) {
    const classified = this._classifyError(err);
    logger.error(`GitHub API error: ${context} — ${classified}`);
    return new ExternalServiceError('GitHub', `${context}: ${classified}`);
  }
}
