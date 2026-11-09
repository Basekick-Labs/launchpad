import { describe, expect, it } from 'vitest';
import { blockedReason, canonicalizePath, isAuditedChange, isMemberAllowed } from './proxyPolicy';

describe('canonicalizePath', () => {
  it('normalises the spellings Arc normalises', () => {
    expect(canonicalizePath('/api/v1//MQTT/./subscriptions')).toBe('api/v1/mqtt/subscriptions');
    expect(canonicalizePath('api/v1/query/../rbac/organizations')).toBe('api/v1/rbac/organizations');
  });
});

describe('isMemberAllowed', () => {
  it('allows members only the read routes, and POST only for queries', () => {
    expect(isMemberAllowed('GET', 'api/v1/databases')).toBe(true);
    expect(isMemberAllowed('POST', 'api/v1/query')).toBe(true);
    expect(isMemberAllowed('POST', 'api/v1/databases')).toBe(false);
    expect(isMemberAllowed('GET', 'api/v1/logs')).toBe(false);
    expect(isMemberAllowed('GET', 'api/v1/rbac/organizations')).toBe(false);
    expect(isMemberAllowed('GET', 'api/v1/querying')).toBe(false); // prefix, not substring
  });
});

describe('blockedReason', () => {
  it('blocks access-control paths for everyone, in any spelling', () => {
    for (const path of [
      'api/v1/rbac/organizations',
      'api/v1/rbac',
      'api/v1/auth/tokens/5/teams',
      'api/v1/auth/tokens/5/teams/9',
      'api/v1/auth/tokens/5/permissions',
      'api/v1/auth/cache/invalidate',
    ]) {
      expect(blockedReason(path)).toMatch(/Access tab/);
    }
    expect(blockedReason(canonicalizePath('/api/v1//RBAC/./organizations'))).not.toBeNull();
  });

  it('leaves token management and everything else alone', () => {
    for (const path of ['api/v1/auth/tokens', 'api/v1/auth/tokens/5', 'api/v1/auth/tokens/5/rotate', 'api/v1/rbacx', 'api/v1/query']) {
      expect(blockedReason(path)).toBeNull();
    }
  });
});

describe('isAuditedChange', () => {
  it('records changes, not reads or queries', () => {
    expect(isAuditedChange('POST', 'api/v1/auth/tokens')).toBe(true);
    expect(isAuditedChange('DELETE', 'api/v1/retention/3')).toBe(true);
    expect(isAuditedChange('PUT', 'api/v1/mqtt/subscriptions/x')).toBe(true);
    expect(isAuditedChange('GET', 'api/v1/auth/tokens')).toBe(false);
    expect(isAuditedChange('POST', 'api/v1/query')).toBe(false);
    expect(isAuditedChange('POST', 'api/v1/query/arrow')).toBe(false);
  });
});
