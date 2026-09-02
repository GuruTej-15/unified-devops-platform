import Repository from './repository.model.js';
import Commit from './commit.model.js';
import PullRequest from './pullRequest.model.js';
import Project from '../projects/project.model.js';
import Issue from '../issues/issue.model.js';
import GitHubClient from './github.client.js';
import { encrypt, decrypt, maskToken } from '../../shared/crypto.js';
import { extractIssueKeys } from '../../shared/issueKeyParser.js';
import { NotFoundError, BadRequestError, ExternalServiceError } from '../../shared/errors.js';
import { CONNECTION_STATUS, SYNC_STATUS } from '../../shared/constants.js';
import { getPaginationParams } from '../../shared/pagination.js';
import eventBus from '../notifications/eventBus.js';
import logger from '../../shared/logger.js';

export default class VcsService {
  /**
   * Connect a GitHub repository to a project.
   * Validates the PAT, fetches repo metadata, encrypts the token.
   */
  static async connectRepository(projectId, { owner, name, token }, userId) {
    // 1. Verify project exists
    const project = await Project.findById(projectId);
    if (!project) throw new NotFoundError('Project not found');

    // 2. Validate GitHub token
    const client = new GitHubClient(token);
    const tokenCheck = await client.validateToken();
    if (!tokenCheck.valid) {
      throw new BadRequestError(`GitHub token validation failed: ${tokenCheck.error}`);
    }

    // 3. Fetch repository metadata from GitHub
    const repoData = await client.getRepository(owner, name);

    // 4. Check if already connected
    const existing = await Repository.findOne({ project: projectId, fullName: repoData.fullName });
    if (existing) {
      throw new BadRequestError(
        `Repository ${repoData.fullName} is already connected to this project`
      );
    }

    // 5. Encrypt the PAT using AES-256-GCM
    const encrypted = encrypt(token);

    // 6. Create repository record (PAT fields never serialized in responses)
    const repository = await Repository.create({
      project: projectId,
      provider: 'github',
      externalId: repoData.externalId,
      owner,
      name: repoData.name,
      fullName: repoData.fullName,
      defaultBranch: repoData.defaultBranch,
      htmlUrl: repoData.htmlUrl,
      isPrivate: repoData.isPrivate,
      language: repoData.language,
      starCount: repoData.starCount,
      description: repoData.description,
      connectionStatus: CONNECTION_STATUS.CONNECTED,
      connectedBy: userId,
      encryptedToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenAuthTag: encrypted.authTag,
      tokenHint: maskToken(token),
    });

    eventBus.emit('repository.connected', {
      repository,
      project,
      actor: userId,
    });

    return repository;
  }

  /**
   * List repositories for a project.
   */
  static async listRepositories(projectId) {
    return Repository.find({ project: projectId })
      .populate('connectedBy', 'firstName lastName email')
      .sort({ createdAt: -1 });
  }

  /**
   * Get repository by ID.
   */
  static async getRepositoryById(repoId) {
    const repo = await Repository.findById(repoId).populate(
      'connectedBy',
      'firstName lastName email'
    );
    if (!repo) throw new NotFoundError('Repository not found');
    return repo;
  }

  /**
   * Disconnect (delete) a repository and its synced data.
   */
  static async disconnectRepository(repoId, userId) {
    const repo = await Repository.findById(repoId);
    if (!repo) throw new NotFoundError('Repository not found');

    // Delete synced commits and PRs
    await Commit.deleteMany({ repository: repoId });
    await PullRequest.deleteMany({ repository: repoId });
    await Repository.findByIdAndDelete(repoId);

    eventBus.emit('repository.disconnected', {
      repository: repo,
      actor: userId,
    });

    return { message: 'Repository disconnected' };
  }

  /**
   * Decrypt the stored PAT for a repository.
   */
  static async _getDecryptedToken(repoId) {
    const repo = await Repository.findById(repoId).select('+encryptedToken +tokenIv +tokenAuthTag');
    if (!repo) throw new NotFoundError('Repository not found');

    return {
      repo,
      token: decrypt({
        ciphertext: repo.encryptedToken,
        iv: repo.tokenIv,
        authTag: repo.tokenAuthTag,
      }),
    };
  }

  /**
   * Fetch branches live from GitHub (not cached).
   */
  static async getBranches(repoId) {
    const { repo, token } = await VcsService._getDecryptedToken(repoId);
    const client = new GitHubClient(token);

    try {
      return await client.getBranches(repo.owner, repo.name);
    } catch (err) {
      await VcsService._handleSyncFailure(repo, err);
      throw err;
    }
  }

  /**
   * Validates candidate issue keys against the project's namespace and existing database issues.
   * Multi-step algorithm: Candidate Keys -> Valid Project Prefix -> Existing Issue -> Traceability Link
   */
  static async _validateIssueKeys(candidateKeys, project) {
    if (!candidateKeys || candidateKeys.length === 0 || !project) return [];

    // Filter to keys that match the project prefix (e.g. "PAY-")
    const projectPrefix = `${project.key}-`;
    const namespaceMatches = candidateKeys.filter((k) => k.startsWith(projectPrefix));
    if (namespaceMatches.length === 0) return [];

    // Query for existing issues belonging to this project
    const existingIssues = await Issue.find({
      project: project._id,
      issueKey: { $in: namespaceMatches },
    }).select('issueKey');

    return existingIssues.map((i) => i.issueKey);
  }

  /**
   * Sync commits and PRs from GitHub.
   * Extracts candidate issue keys and validates them against project issues for authoritative traceability.
   */
  static async syncRepository(repoId) {
    const { repo, token } = await VcsService._getDecryptedToken(repoId);
    const client = new GitHubClient(token);

    const project = await Project.findById(repo.project);
    if (!project) throw new NotFoundError('Associated project not found');

    // Set status to syncing
    await Repository.findByIdAndUpdate(repoId, {
      connectionStatus: CONNECTION_STATUS.SYNCING,
    });

    try {
      const stats = { commitsAdded: 0, prsAdded: 0, commitsUpdated: 0, prsUpdated: 0 };

      // 1. Sync commits (fetch latest 50)
      const { commits } = await client.getCommits(repo.owner, repo.name, { limit: 50 });

      for (const commit of commits) {
        const candidateKeys = extractIssueKeys(commit.message);
        const matchedIssueKeys = await VcsService._validateIssueKeys(candidateKeys, project);

        const result = await Commit.findOneAndUpdate(
          { repository: repoId, sha: commit.sha },
          {
            ...commit,
            repository: repoId,
            project: repo.project,
            matchedIssueKeys,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (result.createdAt.getTime() === result.updatedAt.getTime()) {
          stats.commitsAdded++;
        } else {
          stats.commitsUpdated++;
        }
      }

      // 2. Sync PRs (fetch all states, latest 50)
      const { pullRequests } = await client.getPullRequests(repo.owner, repo.name, {
        state: 'ALL',
        limit: 50,
      });

      for (const pr of pullRequests) {
        const candidateKeys = extractIssueKeys(`${pr.title} ${pr.body} ${pr.sourceBranch}`);
        const matchedIssueKeys = await VcsService._validateIssueKeys(candidateKeys, project);

        const result = await PullRequest.findOneAndUpdate(
          { repository: repoId, number: pr.number },
          {
            ...pr,
            repository: repoId,
            project: repo.project,
            matchedIssueKeys,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (result.createdAt.getTime() === result.updatedAt.getTime()) {
          stats.prsAdded++;
        } else {
          stats.prsUpdated++;
        }
      }

      const now = new Date();
      // Update sync metadata with success and lastSuccessfulSyncAt
      await Repository.findByIdAndUpdate(repoId, {
        connectionStatus: CONNECTION_STATUS.CONNECTED,
        lastSyncedAt: now,
        lastSuccessfulSyncAt: now,
        lastSyncStatus: SYNC_STATUS.SUCCESS,
        lastSyncError: null,
      });

      eventBus.emit('repository.synced', {
        repository: repo,
        stats,
      });

      return stats;
    } catch (err) {
      await VcsService._handleSyncFailure(repo, err);
      throw err;
    }
  }

  /**
   * List synced commits for a repository.
   */
  static async getCommits(repoId, query = {}) {
    const { page, limit, skip } = getPaginationParams(query);
    const [commits, total] = await Promise.all([
      Commit.find({ repository: repoId }).sort({ authoredAt: -1 }).skip(skip).limit(limit),
      Commit.countDocuments({ repository: repoId }),
    ]);
    return { commits, total, page, limit };
  }

  /**
   * List synced pull requests for a repository.
   */
  static async getPullRequests(repoId, query = {}) {
    const { page, limit, skip } = getPaginationParams(query);
    const [pullRequests, total] = await Promise.all([
      PullRequest.find({ repository: repoId }).sort({ updatedAt: -1 }).skip(skip).limit(limit),
      PullRequest.countDocuments({ repository: repoId }),
    ]);
    return { pullRequests, total, page, limit };
  }

  /**
   * Handle sync failure: update status, log error.
   */
  static async _handleSyncFailure(repo, err) {
    const errorMessage =
      err instanceof ExternalServiceError ? err.message : 'Sync failed unexpectedly';

    await Repository.findByIdAndUpdate(repo._id, {
      connectionStatus: CONNECTION_STATUS.FAILED,
      lastSyncedAt: new Date(),
      lastSyncStatus: SYNC_STATUS.FAILED,
      lastSyncError: errorMessage,
    });

    eventBus.emit('repository.sync.failed', {
      repository: repo,
      error: errorMessage,
    });

    logger.error(`Repository sync failed [${repo.fullName}]: ${errorMessage}`);
  }
}
