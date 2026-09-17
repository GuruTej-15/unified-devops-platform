import crypto from 'node:crypto';
import BaseSecurityProvider from './baseSecurityProvider.js';
import {
  SECURITY_PROVIDER,
  SECURITY_SEVERITY,
  SECURITY_FINDING_TYPE,
} from '../../../shared/constants.js';

const SEVERITY_MAP = {
  CRITICAL: SECURITY_SEVERITY.CRITICAL,
  HIGH: SECURITY_SEVERITY.HIGH,
  MEDIUM: SECURITY_SEVERITY.MEDIUM,
  LOW: SECURITY_SEVERITY.LOW,
  NEGLIGIBLE: SECURITY_SEVERITY.NEGLIGIBLE,
  UNKNOWN: SECURITY_SEVERITY.UNKNOWN,
};

/**
 * Generates a stable canonical identity key for a security finding.
 * Excludes package versions, titles, and descriptions.
 *
 * @param {object} params
 * @param {string} params.repositoryId
 * @param {string} params.target
 * @param {string} params.vulnerabilityId
 * @param {string} params.pkgName
 * @param {string} params.findingType
 * @returns {string} 64-character hex SHA-256 digest
 */
export function generateFindingIdentityKey({
  repositoryId,
  target,
  vulnerabilityId,
  pkgName,
  findingType = SECURITY_FINDING_TYPE.VULNERABILITY,
}) {
  const repoStr = repositoryId ? String(repositoryId).trim() : 'no-repo';
  const targetStr = target ? String(target).trim() : 'unknown-target';
  const vulnStr = vulnerabilityId ? String(vulnerabilityId).trim() : 'unknown-vuln';
  const pkgStr = pkgName ? String(pkgName).trim() : 'unknown-pkg';
  const typeStr = findingType ? String(findingType).trim() : SECURITY_FINDING_TYPE.VULNERABILITY;

  const canonical = `${repoStr}:${targetStr}:${vulnStr}:${pkgStr}:${typeStr}`;
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Normalizes Trivy severity strings to platform enum.
 *
 * @param {string} rawSeverity
 * @returns {string}
 */
export function normalizeTrivySeverity(rawSeverity) {
  if (!rawSeverity || typeof rawSeverity !== 'string') {
    return SECURITY_SEVERITY.UNKNOWN;
  }
  const upper = rawSeverity.trim().toUpperCase();
  return SEVERITY_MAP[upper] || SECURITY_SEVERITY.UNKNOWN;
}

/**
 * Trivy Security Provider.
 * Parses Trivy JSON v2 report output into normalized findings and summary metrics.
 */
export default class TrivyProvider extends BaseSecurityProvider {
  getProviderName() {
    return SECURITY_PROVIDER.TRIVY;
  }

  /**
   * Safely parses and validates a raw report into a JavaScript object.
   *
   * @param {string|object} rawReport
   * @returns {object}
   */
  _parseRawInput(rawReport) {
    if (rawReport === null || rawReport === undefined) {
      throw new Error(
        'Invalid Trivy report: report must be a non-null object or valid JSON string'
      );
    }

    let reportObj;
    if (typeof rawReport === 'string') {
      try {
        reportObj = JSON.parse(rawReport);
      } catch (err) {
        throw new Error(`Invalid Trivy report: malformed JSON string (${err.message})`);
      }
    } else if (typeof rawReport === 'object' && !Array.isArray(rawReport)) {
      reportObj = rawReport;
    } else {
      throw new Error('Invalid Trivy report: report must be a non-null object');
    }

    if (reportObj === null || typeof reportObj !== 'object' || Array.isArray(reportObj)) {
      throw new Error('Invalid Trivy report: report root must be a JSON object');
    }

    // SchemaVersion validation
    if (
      reportObj.SchemaVersion === undefined ||
      reportObj.SchemaVersion === null ||
      typeof reportObj.SchemaVersion !== 'number'
    ) {
      throw new Error('Invalid Trivy report: missing or unsupported SchemaVersion');
    }

    // Results array validation
    if (!Array.isArray(reportObj.Results)) {
      throw new Error('Invalid Trivy report: missing or invalid Results array');
    }

    return reportObj;
  }

  /**
   * Parse a Trivy JSON report into normalized findings and summary metrics.
   *
   * @param {string|object} rawReport
   * @param {object} [context] - { repositoryId, projectId, scanType, target }
   * @returns {{ findings: Array<object>, summary: object, providerMetadata: object }}
   */
  parseReport(rawReport, context = {}) {
    const reportObj = this._parseRawInput(rawReport);

    const repositoryId =
      context.repositoryId ||
      (context.repository?._id ? String(context.repository._id) : context.repository) ||
      null;

    const findings = [];
    const summary = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      negligible: 0,
      unknown: 0,
      total: 0,
    };

    for (const result of reportObj.Results) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Invalid Trivy report: malformed Result entry in Results array');
      }

      const targetName =
        result.Target || reportObj.ArtifactName || context.target || 'unknown-target';

      // Vulnerabilities array can be empty or undefined on clean targets
      if (result.Vulnerabilities !== undefined && result.Vulnerabilities !== null) {
        if (!Array.isArray(result.Vulnerabilities)) {
          throw new Error(
            `Invalid Trivy report: malformed Vulnerabilities array in target '${targetName}'`
          );
        }

        for (const vuln of result.Vulnerabilities) {
          if (!vuln || typeof vuln !== 'object' || Array.isArray(vuln)) {
            throw new Error('Invalid Trivy report: malformed Vulnerability entry');
          }

          if (!vuln.VulnerabilityID || typeof vuln.VulnerabilityID !== 'string') {
            throw new Error('Invalid Trivy report: missing or invalid VulnerabilityID');
          }

          if (!vuln.PkgName || typeof vuln.PkgName !== 'string') {
            throw new Error('Invalid Trivy report: missing or invalid PkgName');
          }

          const severity = normalizeTrivySeverity(vuln.Severity);
          const vulnerabilityId = vuln.VulnerabilityID.trim();
          const pkgName = vuln.PkgName.trim();
          const findingType = SECURITY_FINDING_TYPE.VULNERABILITY;

          const findingIdentityKey = generateFindingIdentityKey({
            repositoryId,
            target: targetName,
            vulnerabilityId,
            pkgName,
            findingType,
          });

          const normalizedFinding = {
            provider: SECURITY_PROVIDER.TRIVY,
            findingIdentityKey,
            vulnerabilityId,
            title: vuln.Title ? String(vuln.Title).trim() : '',
            description: vuln.Description ? String(vuln.Description).trim() : '',
            severity,
            pkgName,
            installedVersion: vuln.InstalledVersion ? String(vuln.InstalledVersion).trim() : '',
            fixedVersion: vuln.FixedVersion ? String(vuln.FixedVersion).trim() : '',
            target: targetName,
            findingType,
            status: 'open',
            primaryUrl: vuln.PrimaryURL ? String(vuln.PrimaryURL).trim() : '',
            references: Array.isArray(vuln.References)
              ? vuln.References.filter((ref) => typeof ref === 'string')
              : [],
          };

          findings.push(normalizedFinding);

          summary[severity] = (summary[severity] || 0) + 1;
          summary.total += 1;
        }
      }
    }

    const providerMetadata = {
      schemaVersion: reportObj.SchemaVersion,
      trivyVersion: reportObj.TrivyVersion || reportObj.Metadata?.TrivyVersion || '',
      artifactName: reportObj.ArtifactName || '',
      artifactType: reportObj.ArtifactType || '',
    };

    return {
      findings,
      summary,
      providerMetadata,
    };
  }

  /**
   * Extract top-level scan metadata from the report.
   *
   * @param {string|object} rawReport
   * @param {object} [context]
   * @returns {object}
   */
  extractScanMetadata(rawReport, context = {}) {
    const reportObj = this._parseRawInput(rawReport);

    const artifactType = reportObj.ArtifactType || '';
    let scanType = 'filesystem';
    if (artifactType === 'container_image') {
      scanType = 'image';
    } else if (artifactType === 'filesystem' || artifactType === 'repository') {
      scanType = artifactType;
    } else if (context.scanType) {
      scanType = context.scanType;
    }

    const target =
      reportObj.ArtifactName ||
      reportObj.Results?.[0]?.Target ||
      context.target ||
      'unknown-target';

    return {
      provider: SECURITY_PROVIDER.TRIVY,
      scanType,
      target,
      providerMetadata: {
        schemaVersion: reportObj.SchemaVersion,
        trivyVersion: reportObj.TrivyVersion || reportObj.Metadata?.TrivyVersion || '',
        artifactName: reportObj.ArtifactName || '',
        artifactType: reportObj.ArtifactType || '',
      },
    };
  }
}
