import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import SecurityScan from '../securityScan.model.js';
import GovernancePolicy from '../governancePolicy.model.js';
import PolicyGateResult from '../policyGateResult.model.js';
import SecurityDelivery from '../securityDelivery.model.js';
import { processSecurityScanJob } from '../securityScanProcessor.js';
import PolicyEngineService from '../policyEngine.service.js';
import {
  publishSecurityEvent,
  initPipelineEventSubscriber,
  handleIncomingRedisMessage,
  _resetEventBridgeState,
} from '../../cicd/events/ciEventBridge.js';
import eventBus from '../../notifications/eventBus.js';
import {
  SECURITY_SCAN_STATUS,
  SECURITY_EVENTS,
  POLICY_RULE_TYPE,
  POLICY_ENFORCEMENT,
} from '../../../shared/constants.js';

describe('Phase 3 Step 6 — Security Real-Time Events & Bridge (Tier A)', () => {
  const projectId = new mongoose.Types.ObjectId();
  const repositoryId = new mongoose.Types.ObjectId();
  const integrationId = new mongoose.Types.ObjectId();
  const pipelineRunId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    _resetEventBridgeState();
    jest.clearAllMocks();
  });

  afterEach(() => {
    _resetEventBridgeState();
  });

  const sampleReport = {
    SchemaVersion: 2,
    ArtifactName: 'alpine:3.18.4',
    ArtifactType: 'container_image',
    Results: [
      {
        Target: 'alpine:3.18.4',
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
  };

  function buildJobData(reportOverrides = {}) {
    return {
      jobType: 'security_scan_ingest',
      securityIntegrationId: String(integrationId),
      projectId: String(projectId),
      repositoryId: String(repositoryId),
      pipelineRunId: String(pipelineRunId),
      commitSha: 'c0ffee123456',
      branch: 'main',
      target: 'alpine:3.18.4',
      scanType: 'image',
      provider: 'trivy',
      reportDigest: `digest-events-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      rawPayload: sampleReport,
      ...reportOverrides,
    };
  }

  // =========================================================================
  // 1. EVENT PUBLISHING AFTER DB PERSISTENCE
  // =========================================================================

  it('publishes security.scan.completed after authoritative scan persistence', async () => {
    const jobData = buildJobData();

    await SecurityDelivery.create({
      integration: integrationId,
      project: projectId,
      reportDigest: jobData.reportDigest,
      deliveryKey: `${integrationId}:${jobData.reportDigest}`,
      status: 'queued',
    });

    const publishedEvents = [];
    const eventHandler = (payload) => {
      publishedEvents.push(payload);
    };
    eventBus.on(SECURITY_EVENTS.SCAN_COMPLETED, eventHandler);

    try {
      const result = await processSecurityScanJob(jobData);
      expect(result.success).toBe(true);

      // Verify DB persistence completed
      const scan = await SecurityScan.findById(result.scanId);
      expect(scan).toBeDefined();
      expect(scan.status).toBe(SECURITY_SCAN_STATUS.COMPLETED);

      // Verify event was emitted after DB write
      expect(publishedEvents.length).toBeGreaterThanOrEqual(1);
      const event = publishedEvents[0];
      expect(event.domain).toBe('security');
      expect(event.eventType).toBe(SECURITY_EVENTS.SCAN_COMPLETED);
      expect(event.projectId).toBe(String(projectId));
      expect(event.securityScanId).toBe(String(scan._id));
      expect(event.status).toBe('completed');
      expect(event.findingCount).toBe(1);
      expect(event.summary).toBeDefined();
    } finally {
      eventBus.removeListener(SECURITY_EVENTS.SCAN_COMPLETED, eventHandler);
    }
  });

  it('publishes security.scan.failed when report processing fails', async () => {
    const jobData = buildJobData({
      rawPayload: { invalid: 'not-a-valid-trivy-report' },
    });

    await SecurityDelivery.create({
      integration: integrationId,
      project: projectId,
      reportDigest: jobData.reportDigest,
      deliveryKey: `${integrationId}:${jobData.reportDigest}`,
      status: 'queued',
    });

    const failedEvents = [];
    const eventHandler = (payload) => {
      failedEvents.push(payload);
    };
    eventBus.on(SECURITY_EVENTS.SCAN_FAILED, eventHandler);

    try {
      await expect(processSecurityScanJob(jobData)).rejects.toThrow();

      // Verify event published
      expect(failedEvents.length).toBeGreaterThanOrEqual(1);
      const event = failedEvents[0];
      expect(event.domain).toBe('security');
      expect(event.eventType).toBe(SECURITY_EVENTS.SCAN_FAILED);
      expect(event.projectId).toBe(String(projectId));
      expect(event.status).toBe('failed');
      expect(event.error).toBeDefined();
    } finally {
      eventBus.removeListener(SECURITY_EVENTS.SCAN_FAILED, eventHandler);
    }
  });

  it('publishes policy.gate.evaluated after PolicyGateResult persistence', async () => {
    const scan = await SecurityScan.create({
      project: projectId,
      repository: repositoryId,
      provider: 'trivy',
      scanType: 'image',
      target: 'alpine:3.18.4',
      reportDigest: `digest-eval-${Date.now()}`,
      status: SECURITY_SCAN_STATUS.COMPLETED,
      summary: { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0, total: 0 },
      findingCount: 0,
    });

    await GovernancePolicy.create({
      project: projectId,
      name: 'event-policy',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'critical', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      createdBy: userId,
      isActive: true,
    });

    const evalEvents = [];
    const eventHandler = (payload) => {
      evalEvents.push(payload);
    };
    eventBus.on(SECURITY_EVENTS.POLICY_EVALUATED, eventHandler);

    try {
      await PolicyEngineService.evaluatePolicies({
        projectId,
        securityScanId: scan._id,
      });

      expect(evalEvents.length).toBeGreaterThanOrEqual(1);
      const event = evalEvents[0];
      expect(event.domain).toBe('security');
      expect(event.eventType).toBe(SECURITY_EVENTS.POLICY_EVALUATED);
      expect(event.projectId).toBe(String(projectId));
      expect(event.securityScanId).toBe(String(scan._id));
      expect(event.gateStatus).toBe('PASS');
      expect(event.policiesEvaluated).toBe(1);
    } finally {
      eventBus.removeListener(SECURITY_EVENTS.POLICY_EVALUATED, eventHandler);
    }
  });

  it('publishes policy.gate.overridden after manual override persistence', async () => {
    const scan = await SecurityScan.create({
      project: projectId,
      repository: repositoryId,
      provider: 'trivy',
      scanType: 'image',
      target: 'alpine:3.18.4',
      reportDigest: `digest-override-ev-${Date.now()}`,
      status: SECURITY_SCAN_STATUS.COMPLETED,
    });

    const policy = await GovernancePolicy.create({
      project: projectId,
      name: 'policy-for-override',
      ruleType: POLICY_RULE_TYPE.MAX_SEVERITY_COUNT,
      ruleConfig: { severity: 'critical', maxCount: 0 },
      enforcement: POLICY_ENFORCEMENT.BLOCKING,
      createdBy: userId,
      isActive: true,
    });

    const gateResult = await PolicyGateResult.create({
      project: projectId,
      scan: scan._id,
      policy: policy._id,
      policyName: policy.name,
      ruleType: policy.ruleType,
      enforcement: policy.enforcement,
      passed: false,
      evaluationStatus: 'FAIL',
      reason: 'Critical finding detected',
    });

    const overrideEvents = [];
    const eventHandler = (payload) => {
      overrideEvents.push(payload);
    };
    eventBus.on(SECURITY_EVENTS.POLICY_OVERRIDDEN, eventHandler);

    try {
      await PolicyEngineService.overridePolicyGate({
        gateResultId: gateResult._id,
        actorId: userId,
        projectId,
        justification: 'Approved emergency exception by security lead',
      });

      expect(overrideEvents.length).toBeGreaterThanOrEqual(1);
      const event = overrideEvents[0];
      expect(event.domain).toBe('security');
      expect(event.eventType).toBe(SECURITY_EVENTS.POLICY_OVERRIDDEN);
      expect(event.projectId).toBe(String(projectId));
      expect(event.gateResultId).toBe(String(gateResult._id));
      expect(event.overrideStatus).toBe('approved');
      expect(event.overrideJustification).toContain('Approved emergency exception');
    } finally {
      eventBus.removeListener(SECURITY_EVENTS.POLICY_OVERRIDDEN, eventHandler);
    }
  });

  // =========================================================================
  // 2. REDIS PUB/SUB & SOCKET.IO PROJECT ROOM BROADCAST
  // =========================================================================

  it('Redis Pub/Sub message broadcasts to authorized project room only', () => {
    const mockEmit = jest.fn();
    const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
    const mockIO = { to: mockTo, emit: jest.fn() };

    initPipelineEventSubscriber(mockIO);

    const securityEvent = {
      domain: 'security',
      eventType: SECURITY_EVENTS.SCAN_COMPLETED,
      projectId: 'proj-security-101',
      securityScanId: 'scan-777',
      status: 'completed',
      gateStatus: 'PASS',
      timestamp: new Date().toISOString(),
    };

    const handled = handleIncomingRedisMessage(JSON.stringify(securityEvent));
    expect(handled).toBe(true);

    // Verified targeted room broadcast
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith('project:proj-security-101');
    expect(mockEmit).toHaveBeenCalledWith(
      SECURITY_EVENTS.SCAN_COMPLETED,
      expect.objectContaining({
        type: SECURITY_EVENTS.SCAN_COMPLETED,
        data: expect.objectContaining({
          domain: 'security',
          securityScanId: 'scan-777',
          gateStatus: 'PASS',
        }),
      })
    );

    // Global broadcast NEVER called
    expect(mockIO.emit).not.toHaveBeenCalled();
  });

  it('unauthorized project does NOT receive event for another project', () => {
    const mockEmit = jest.fn();
    const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
    const mockIO = { to: mockTo };

    initPipelineEventSubscriber(mockIO);

    const eventForProjectA = {
      domain: 'security',
      eventType: SECURITY_EVENTS.SCAN_COMPLETED,
      projectId: 'project-isolated-A',
      securityScanId: 'scan-111',
    };

    handleIncomingRedisMessage(JSON.stringify(eventForProjectA));

    expect(mockTo).toHaveBeenCalledWith('project:project-isolated-A');
    expect(mockTo).not.toHaveBeenCalledWith('project:project-isolated-B');
  });

  // =========================================================================
  // 3. EVENT PAYLOAD SAFETY & SECRECY
  // =========================================================================

  it('event payload contains NO plaintext secrets or credentials', async () => {
    const published = await publishSecurityEvent(SECURITY_EVENTS.SCAN_COMPLETED, {
      projectId: 'proj-sec-safe',
      securityScanId: 'scan-001',
      status: 'completed',
      summary: { total: 0 },
    });

    const payloadStr = JSON.stringify(published.payload);
    expect(payloadStr).not.toContain('secret');
    expect(payloadStr).not.toContain('password');
    expect(payloadStr).not.toContain('token');
    expect(payloadStr).not.toContain('credential');
  });

  it('event payload contains NO raw Trivy reports or large finding dumps', async () => {
    const published = await publishSecurityEvent(SECURITY_EVENTS.SCAN_COMPLETED, {
      projectId: 'proj-sec-safe',
      securityScanId: 'scan-001',
      status: 'completed',
      summary: { total: 2, critical: 1, high: 1 },
    });

    expect(published.payload.rawPayload).toBeUndefined();
    expect(published.payload.rawReport).toBeUndefined();
    expect(published.payload.findings).toBeUndefined();
  });

  // =========================================================================
  // 4. NOTIFICATION FAILURE RESILIENCE
  // =========================================================================

  it('Redis/notification failure does NOT corrupt or rollback MongoDB state', async () => {
    // Intentionally publish an event with an invalid payload structure that causes bridge rejection
    const invalidResult = await publishSecurityEvent('', {
      projectId: '',
    });

    expect(invalidResult.published).toBe(false);

    // Verify DB model operations remain completely healthy
    const scan = await SecurityScan.create({
      project: projectId,
      repository: repositoryId,
      provider: 'trivy',
      scanType: 'image',
      target: 'alpine:3.18.4',
      reportDigest: `digest-resilience-${Date.now()}`,
      status: SECURITY_SCAN_STATUS.COMPLETED,
    });

    const fetched = await SecurityScan.findById(scan._id);
    expect(fetched).toBeDefined();
    expect(fetched.status).toBe(SECURITY_SCAN_STATUS.COMPLETED);
  });
});
