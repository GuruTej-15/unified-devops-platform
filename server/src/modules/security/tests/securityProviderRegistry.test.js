import {
  getSecurityProvider,
  registerSecurityProvider,
  hasSecurityProvider,
  defaultTrivyProvider,
  _resetSecurityProviderRegistry,
} from '../providers/securityProviderRegistry.js';
import TrivyProvider from '../providers/trivyProvider.js';
import BaseSecurityProvider from '../providers/baseSecurityProvider.js';
import { SECURITY_PROVIDER } from '../../../shared/constants.js';

describe('SecurityProviderRegistry', () => {
  beforeEach(() => {
    _resetSecurityProviderRegistry();
  });

  afterAll(() => {
    _resetSecurityProviderRegistry();
  });

  it('should have Trivy pre-registered by default', () => {
    expect(hasSecurityProvider(SECURITY_PROVIDER.TRIVY)).toBe(true);
    const provider = getSecurityProvider(SECURITY_PROVIDER.TRIVY);
    expect(provider).toBeInstanceOf(TrivyProvider);
    expect(provider).toBe(defaultTrivyProvider);
    expect(provider.getProviderName()).toBe('trivy');
  });

  it('should retrieve provider case-insensitively', () => {
    const p1 = getSecurityProvider('trivy');
    const p2 = getSecurityProvider('TRIVY');
    const p3 = getSecurityProvider('  Trivy  ');
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
  });

  it('should reject unknown provider with a clear, descriptive error', () => {
    expect(() => getSecurityProvider('snyk')).toThrow(/Unsupported security provider: 'snyk'/i);
    expect(() => getSecurityProvider('unknown_scanner')).toThrow(
      /Unsupported security provider: 'unknown_scanner'/i
    );
  });

  it('should reject invalid or missing provider name arguments', () => {
    expect(() => getSecurityProvider('')).toThrow(/Invalid provider name/i);
    expect(() => getSecurityProvider(null)).toThrow(/Invalid provider name/i);
    expect(() => getSecurityProvider(undefined)).toThrow(/Invalid provider name/i);
  });

  it('should register and retrieve a valid custom provider implementing BaseSecurityProvider', () => {
    class CustomScanner extends BaseSecurityProvider {
      getProviderName() {
        return 'custom_scanner';
      }
      parseReport() {
        return { findings: [], summary: {}, providerMetadata: {} };
      }
      extractScanMetadata() {
        return { provider: 'custom_scanner', scanType: 'filesystem', target: 'test' };
      }
    }

    const customInstance = new CustomScanner();
    registerSecurityProvider('custom_scanner', customInstance);

    expect(hasSecurityProvider('custom_scanner')).toBe(true);
    const retrieved = getSecurityProvider('custom_scanner');
    expect(retrieved).toBe(customInstance);
    expect(retrieved.getProviderName()).toBe('custom_scanner');
  });

  it('should reject invalid provider instances missing required contract methods', () => {
    expect(() => registerSecurityProvider('bad1', null)).toThrow(/non-null object/i);
    expect(() => registerSecurityProvider('bad2', {})).toThrow(
      /must implement method 'getProviderName'/i
    );
    expect(() =>
      registerSecurityProvider('bad3', {
        getProviderName: () => 'bad3',
      })
    ).toThrow(/must implement method 'parseReport'/i);
    expect(() =>
      registerSecurityProvider('bad4', {
        getProviderName: () => 'bad4',
        parseReport: () => ({}),
      })
    ).toThrow(/must implement method 'extractScanMetadata'/i);
  });

  it('should reject registration with empty or invalid name', () => {
    class DummyProvider extends BaseSecurityProvider {
      getProviderName() {
        return 'dummy';
      }
      parseReport() {
        return {};
      }
      extractScanMetadata() {
        return {};
      }
    }
    const dummy = new DummyProvider();
    expect(() => registerSecurityProvider('', dummy)).toThrow(/non-empty string/i);
    expect(() => registerSecurityProvider('   ', dummy)).toThrow(/non-empty string/i);
    expect(() => registerSecurityProvider(null, dummy)).toThrow(/non-empty string/i);
  });
});
