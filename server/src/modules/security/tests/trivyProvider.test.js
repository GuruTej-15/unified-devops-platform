import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TrivyProvider, {
  generateFindingIdentityKey,
  normalizeTrivySeverity,
} from '../providers/trivyProvider.js';
import BaseSecurityProvider from '../providers/baseSecurityProvider.js';
import {
  SECURITY_PROVIDER,
  SECURITY_SEVERITY,
  SECURITY_FINDING_TYPE,
} from '../../../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../fixtures');

const imageFixtureRaw = fs.readFileSync(path.join(fixturesDir, 'trivy-image-alpine.json'), 'utf8');
const fsFixtureRaw = fs.readFileSync(path.join(fixturesDir, 'trivy-fs-npm.json'), 'utf8');
const cleanFixtureRaw = fs.readFileSync(path.join(fixturesDir, 'trivy-clean.json'), 'utf8');

describe('TrivyProvider (Tier A)', () => {
  let provider;

  beforeEach(() => {
    provider = new TrivyProvider();
  });

  describe('Provider Contract', () => {
    it('should extend BaseSecurityProvider', () => {
      expect(provider).toBeInstanceOf(BaseSecurityProvider);
    });

    it('should return provider name as trivy', () => {
      expect(provider.getProviderName()).toBe(SECURITY_PROVIDER.TRIVY);
    });
  });

  describe('Report Parsing with Fixtures', () => {
    it('should parse container image fixture accurately (trivy-image-alpine.json)', () => {
      const result = provider.parseReport(imageFixtureRaw, {
        repositoryId: '65f1234567890abcdef12345',
      });

      expect(result).toBeDefined();
      expect(result.findings).toHaveLength(4);

      // Summary verification
      expect(result.summary).toEqual({
        critical: 1,
        high: 1,
        medium: 1,
        low: 1,
        negligible: 0,
        unknown: 0,
        total: 4,
      });

      // Provider metadata
      expect(result.providerMetadata).toEqual({
        schemaVersion: 2,
        trivyVersion: '',
        artifactName: 'alpine:3.18.4',
        artifactType: 'container_image',
      });

      // Detailed finding inspection
      const criticalFinding = result.findings.find((f) => f.vulnerabilityId === 'CVE-2023-44487');
      expect(criticalFinding).toBeDefined();
      expect(criticalFinding.pkgName).toBe('libcrypto3');
      expect(criticalFinding.installedVersion).toBe('3.1.2-r0');
      expect(criticalFinding.fixedVersion).toBe('3.1.4-r0');
      expect(criticalFinding.severity).toBe('critical');
      expect(criticalFinding.target).toBe('alpine:3.18.4 (alpine 3.18.4)');
      expect(criticalFinding.status).toBe('open');
      expect(criticalFinding.findingType).toBe('vulnerability');
      expect(criticalFinding.primaryUrl).toBe('https://avd.aquasec.com/nvd/cve-2023-44487');
      expect(criticalFinding.references).toHaveLength(2);
      expect(criticalFinding.findingIdentityKey).toMatch(/^[a-f0-9]{64}$/);

      // Low finding with empty fixedVersion
      const lowFinding = result.findings.find((f) => f.vulnerabilityId === 'CVE-2023-42363');
      expect(lowFinding).toBeDefined();
      expect(lowFinding.fixedVersion).toBe('');
      expect(lowFinding.severity).toBe('low');
    });

    it('should parse filesystem/npm fixture accurately (trivy-fs-npm.json)', () => {
      const parsedObj = JSON.parse(fsFixtureRaw);
      const result = provider.parseReport(parsedObj, {
        repositoryId: '65f1234567890abcdef12345',
      });

      expect(result).toBeDefined();
      expect(result.findings).toHaveLength(3);

      expect(result.summary).toEqual({
        critical: 0,
        high: 1,
        medium: 1,
        low: 1,
        negligible: 0,
        unknown: 0,
        total: 3,
      });

      expect(result.providerMetadata.artifactName).toBe('package-lock.json');
      expect(result.providerMetadata.artifactType).toBe('filesystem');

      const lodashFinding = result.findings.find((f) => f.pkgName === 'lodash');
      expect(lodashFinding).toBeDefined();
      expect(lodashFinding.vulnerabilityId).toBe('CVE-2018-16487');
      expect(lodashFinding.severity).toBe('high');
      expect(lodashFinding.fixedVersion).toBe('>=4.17.11');

      const ghsaFinding = result.findings.find((f) => f.pkgName === 'tough-cookie');
      expect(ghsaFinding).toBeDefined();
      expect(ghsaFinding.vulnerabilityId).toBe('GHSA-72xf-g2v4-qvf3');
      expect(ghsaFinding.severity).toBe('low');
    });

    it('should parse genuinely clean scan report with zero findings (trivy-clean.json)', () => {
      const result = provider.parseReport(cleanFixtureRaw, {
        repositoryId: '65f1234567890abcdef12345',
      });

      expect(result).toBeDefined();
      expect(result.findings).toEqual([]);
      expect(result.summary).toEqual({
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        negligible: 0,
        unknown: 0,
        total: 0,
      });
      expect(result.providerMetadata.artifactName).toBe('clean-service:1.0.0');
    });
  });

  describe('Metadata Extraction', () => {
    it('should extract scan metadata for container image report', () => {
      const meta = provider.extractScanMetadata(imageFixtureRaw);
      expect(meta).toEqual({
        provider: SECURITY_PROVIDER.TRIVY,
        scanType: 'image',
        target: 'alpine:3.18.4',
        providerMetadata: {
          schemaVersion: 2,
          trivyVersion: '',
          artifactName: 'alpine:3.18.4',
          artifactType: 'container_image',
        },
      });
    });

    it('should extract scan metadata for filesystem report', () => {
      const meta = provider.extractScanMetadata(fsFixtureRaw);
      expect(meta).toEqual({
        provider: SECURITY_PROVIDER.TRIVY,
        scanType: 'filesystem',
        target: 'package-lock.json',
        providerMetadata: {
          schemaVersion: 2,
          trivyVersion: '',
          artifactName: 'package-lock.json',
          artifactType: 'filesystem',
        },
      });
    });
  });

  describe('Finding Identity Canonicalization & Stability', () => {
    const baseParams = {
      repositoryId: 'repo-100',
      target: 'alpine:3.18',
      vulnerabilityId: 'CVE-2023-44487',
      pkgName: 'libcrypto3',
      findingType: SECURITY_FINDING_TYPE.VULNERABILITY,
    };

    it('should generate a 64-character hex SHA-256 string deterministically', () => {
      const id1 = generateFindingIdentityKey(baseParams);
      const id2 = generateFindingIdentityKey(baseParams);
      expect(id1).toHaveLength(64);
      expect(id1).toMatch(/^[a-f0-9]{64}$/);
      expect(id1).toBe(id2);
    });

    it('CRITICAL: installedVersion changes must produce the EXACT SAME findingIdentityKey', () => {
      // Version 3.1.2-r0 vs 3.1.3-r0 vs 3.1.4-r0
      // generateFindingIdentityKey does not even take installedVersion as a parameter
      const idInitial = generateFindingIdentityKey(baseParams);

      const parsedV1 = provider.parseReport(
        {
          SchemaVersion: 2,
          Results: [
            {
              Target: 'alpine:3.18',
              Vulnerabilities: [
                {
                  VulnerabilityID: 'CVE-2023-44487',
                  PkgName: 'libcrypto3',
                  InstalledVersion: '3.1.2-r0',
                  Severity: 'CRITICAL',
                },
              ],
            },
          ],
        },
        { repositoryId: 'repo-100' }
      );

      const parsedV2 = provider.parseReport(
        {
          SchemaVersion: 2,
          Results: [
            {
              Target: 'alpine:3.18',
              Vulnerabilities: [
                {
                  VulnerabilityID: 'CVE-2023-44487',
                  PkgName: 'libcrypto3',
                  InstalledVersion: '3.1.3-r0', // Version changed
                  Severity: 'CRITICAL',
                },
              ],
            },
          ],
        },
        { repositoryId: 'repo-100' }
      );

      expect(parsedV1.findings[0].findingIdentityKey).toBe(idInitial);
      expect(parsedV2.findings[0].findingIdentityKey).toBe(idInitial);
      expect(parsedV1.findings[0].findingIdentityKey).toBe(parsedV2.findings[0].findingIdentityKey);
      expect(parsedV1.findings[0].installedVersion).toBe('3.1.2-r0');
      expect(parsedV2.findings[0].installedVersion).toBe('3.1.3-r0');
    });

    it('CRITICAL: fixedVersion, title, and description changes must NOT alter findingIdentityKey', () => {
      const parsedA = provider.parseReport(
        {
          SchemaVersion: 2,
          Results: [
            {
              Target: 'alpine:3.18',
              Vulnerabilities: [
                {
                  VulnerabilityID: 'CVE-2023-44487',
                  PkgName: 'libcrypto3',
                  InstalledVersion: '3.1.2-r0',
                  FixedVersion: '3.1.3-r0',
                  Title: 'Old advisory title',
                  Description: 'Short description',
                  Severity: 'CRITICAL',
                },
              ],
            },
          ],
        },
        { repositoryId: 'repo-100' }
      );

      const parsedB = provider.parseReport(
        {
          SchemaVersion: 2,
          Results: [
            {
              Target: 'alpine:3.18',
              Vulnerabilities: [
                {
                  VulnerabilityID: 'CVE-2023-44487',
                  PkgName: 'libcrypto3',
                  InstalledVersion: '3.1.2-r0',
                  FixedVersion: '3.1.4-r0', // New fix available
                  Title: 'Updated official advisory title',
                  Description: 'Detailed deep-dive description with mitigations',
                  Severity: 'CRITICAL',
                },
              ],
            },
          ],
        },
        { repositoryId: 'repo-100' }
      );

      expect(parsedA.findings[0].findingIdentityKey).toBe(parsedB.findings[0].findingIdentityKey);
    });

    it('should generate DIFFERENT identity keys for different vulnerability IDs', () => {
      const id1 = generateFindingIdentityKey({ ...baseParams, vulnerabilityId: 'CVE-2023-44487' });
      const id2 = generateFindingIdentityKey({ ...baseParams, vulnerabilityId: 'CVE-2023-5363' });
      expect(id1).not.toBe(id2);
    });

    it('should generate DIFFERENT identity keys for different packages', () => {
      const id1 = generateFindingIdentityKey({ ...baseParams, pkgName: 'libcrypto3' });
      const id2 = generateFindingIdentityKey({ ...baseParams, pkgName: 'openssl' });
      expect(id1).not.toBe(id2);
    });

    it('should generate DIFFERENT identity keys for different targets', () => {
      const id1 = generateFindingIdentityKey({ ...baseParams, target: 'alpine:3.18' });
      const id2 = generateFindingIdentityKey({ ...baseParams, target: 'alpine:3.19' });
      expect(id1).not.toBe(id2);
    });

    it('should generate DIFFERENT identity keys for different repositories', () => {
      const id1 = generateFindingIdentityKey({ ...baseParams, repositoryId: 'repo-A' });
      const id2 = generateFindingIdentityKey({ ...baseParams, repositoryId: 'repo-B' });
      expect(id1).not.toBe(id2);
    });

    it('should use deterministic fallback when repositoryId is missing', () => {
      const id1 = generateFindingIdentityKey({ ...baseParams, repositoryId: null });
      const id2 = generateFindingIdentityKey({ ...baseParams, repositoryId: undefined });
      const id3 = generateFindingIdentityKey({ ...baseParams, repositoryId: '' });
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });
  });

  describe('Severity Normalization', () => {
    it('should normalize standard uppercase severities', () => {
      expect(normalizeTrivySeverity('CRITICAL')).toBe(SECURITY_SEVERITY.CRITICAL);
      expect(normalizeTrivySeverity('HIGH')).toBe(SECURITY_SEVERITY.HIGH);
      expect(normalizeTrivySeverity('MEDIUM')).toBe(SECURITY_SEVERITY.MEDIUM);
      expect(normalizeTrivySeverity('LOW')).toBe(SECURITY_SEVERITY.LOW);
      expect(normalizeTrivySeverity('NEGLIGIBLE')).toBe(SECURITY_SEVERITY.NEGLIGIBLE);
      expect(normalizeTrivySeverity('UNKNOWN')).toBe(SECURITY_SEVERITY.UNKNOWN);
    });

    it('should normalize case-insensitively and trim whitespace', () => {
      expect(normalizeTrivySeverity(' critical ')).toBe(SECURITY_SEVERITY.CRITICAL);
      expect(normalizeTrivySeverity('High')).toBe(SECURITY_SEVERITY.HIGH);
      expect(normalizeTrivySeverity('medium')).toBe(SECURITY_SEVERITY.MEDIUM);
    });

    it('should safely map unexpected, empty, or missing severity to unknown', () => {
      expect(normalizeTrivySeverity(null)).toBe(SECURITY_SEVERITY.UNKNOWN);
      expect(normalizeTrivySeverity(undefined)).toBe(SECURITY_SEVERITY.UNKNOWN);
      expect(normalizeTrivySeverity('')).toBe(SECURITY_SEVERITY.UNKNOWN);
      expect(normalizeTrivySeverity('CATASTROPHIC')).toBe(SECURITY_SEVERITY.UNKNOWN);
      expect(normalizeTrivySeverity('informational')).toBe(SECURITY_SEVERITY.UNKNOWN);
    });
  });

  describe('Input Validation and Malformed Report Rejection', () => {
    it('should reject null or undefined input', () => {
      expect(() => provider.parseReport(null)).toThrow(/Invalid Trivy report/i);
      expect(() => provider.parseReport(undefined)).toThrow(/Invalid Trivy report/i);
    });

    it('should reject non-object primitives (numbers, booleans, arrays)', () => {
      expect(() => provider.parseReport(12345)).toThrow(/Invalid Trivy report/i);
      expect(() => provider.parseReport(true)).toThrow(/Invalid Trivy report/i);
      expect(() => provider.parseReport([1, 2, 3])).toThrow(/Invalid Trivy report/i);
    });

    it('should reject malformed JSON strings', () => {
      expect(() => provider.parseReport('{ "SchemaVersion": 2, malformed...')).toThrow(
        /malformed JSON string/i
      );
    });

    it('should reject reports with missing or non-number SchemaVersion', () => {
      expect(() => provider.parseReport({ Results: [] })).toThrow(
        /missing or unsupported SchemaVersion/i
      );
      expect(() => provider.parseReport({ SchemaVersion: 'two', Results: [] })).toThrow(
        /missing or unsupported SchemaVersion/i
      );
    });

    it('should reject reports with missing or invalid Results array', () => {
      expect(() => provider.parseReport({ SchemaVersion: 2 })).toThrow(
        /missing or invalid Results array/i
      );
      expect(() => provider.parseReport({ SchemaVersion: 2, Results: 'not-an-array' })).toThrow(
        /missing or invalid Results array/i
      );
    });

    it('should reject reports with malformed Result entries', () => {
      expect(() => provider.parseReport({ SchemaVersion: 2, Results: ['not-an-object'] })).toThrow(
        /malformed Result entry/i
      );
      expect(() => provider.parseReport({ SchemaVersion: 2, Results: [null] })).toThrow(
        /malformed Result entry/i
      );
    });

    it('should reject reports with non-array Vulnerabilities in a target', () => {
      expect(() =>
        provider.parseReport({
          SchemaVersion: 2,
          Results: [{ Target: 'app', Vulnerabilities: 'not-an-array' }],
        })
      ).toThrow(/malformed Vulnerabilities array/i);
    });

    it('should reject reports with malformed Vulnerability entries missing required fields', () => {
      expect(() =>
        provider.parseReport({
          SchemaVersion: 2,
          Results: [{ Target: 'app', Vulnerabilities: [{ PkgName: 'pkg-only' }] }],
        })
      ).toThrow(/missing or invalid VulnerabilityID/i);

      expect(() =>
        provider.parseReport({
          SchemaVersion: 2,
          Results: [{ Target: 'app', Vulnerabilities: [{ VulnerabilityID: 'CVE-2024-0001' }] }],
        })
      ).toThrow(/missing or invalid PkgName/i);
    });

    it('should gracefully handle missing optional fields on valid vulnerability entries', () => {
      const minimalReport = {
        SchemaVersion: 2,
        Results: [
          {
            Target: 'minimal-app',
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-2024-9999',
                PkgName: 'minimal-pkg',
                // Title, Description, FixedVersion, InstalledVersion, Severity, URLs omitted
              },
            ],
          },
        ],
      };

      const result = provider.parseReport(minimalReport);
      expect(result.findings).toHaveLength(1);
      const f = result.findings[0];
      expect(f.vulnerabilityId).toBe('CVE-2024-9999');
      expect(f.pkgName).toBe('minimal-pkg');
      expect(f.installedVersion).toBe('');
      expect(f.fixedVersion).toBe('');
      expect(f.title).toBe('');
      expect(f.description).toBe('');
      expect(f.severity).toBe('unknown');
      expect(f.primaryUrl).toBe('');
      expect(f.references).toEqual([]);
      expect(result.summary.unknown).toBe(1);
      expect(result.summary.total).toBe(1);
    });
  });

  describe('Historical Behavior & Pure Function Invariants', () => {
    it('should not deduplicate identical findings within report (pure extraction)', () => {
      // If report lists the same vuln in two different targets, both are returned
      const multiTargetReport = {
        SchemaVersion: 2,
        Results: [
          {
            Target: 'layer-1',
            Vulnerabilities: [
              { VulnerabilityID: 'CVE-2024-1111', PkgName: 'curl', Severity: 'HIGH' },
            ],
          },
          {
            Target: 'layer-2',
            Vulnerabilities: [
              { VulnerabilityID: 'CVE-2024-1111', PkgName: 'curl', Severity: 'HIGH' },
            ],
          },
        ],
      };

      const result = provider.parseReport(multiTargetReport);
      expect(result.findings).toHaveLength(2);
      expect(result.findings[0].target).toBe('layer-1');
      expect(result.findings[1].target).toBe('layer-2');
      expect(result.findings[0].findingIdentityKey).not.toBe(result.findings[1].findingIdentityKey);
    });
  });
});
