/**
 * Agent-managed containers: the 409 refusal is recognized under both codes
 * (container_agent_managed, and container_app_managed from a server before the
 * rename, in either case), and `managedBy` is read from `agentId` or `appId`.
 */
import { describe, expect, it } from 'vitest';
import { WireSdkError } from '../types.js';
import {
  CONTAINER_AGENT_MANAGED,
  CONTAINER_APP_MANAGED,
  isAgentManagedCode,
  isAgentManagedError,
  managedByFromError,
  readManagedBy,
} from '../index.js';
import * as agentEntry from '../agent/index.js';

describe('agent-managed refusals', () => {
  it('recognizes both codes, in both cases', () => {
    expect(CONTAINER_AGENT_MANAGED).toBe('container_agent_managed');
    expect(CONTAINER_APP_MANAGED).toBe('container_app_managed');
    for (const code of ['container_agent_managed', 'container_app_managed', 'CONTAINER_AGENT_MANAGED', 'CONTAINER_APP_MANAGED']) {
      expect(isAgentManagedCode(code)).toBe(true);
      expect(isAgentManagedError(new WireSdkError(code, 'managed', 409))).toBe(true);
    }
    expect(isAgentManagedCode('NOT_FOUND')).toBe(false);
    expect(isAgentManagedError(new WireSdkError('NOT_FOUND', 'x', 404))).toBe(false);
    expect(isAgentManagedError(null)).toBe(false);
  });

  it('reads managedBy from agentId (current) or appId (before the rename)', () => {
    expect(readManagedBy({ installer: 'app:geo_app', agentId: 'geo-app', name: 'Geo', version: '1.0.0', status: 'active' })).toEqual({
      agentId: 'geo-app',
      name: 'Geo',
      version: '1.0.0',
      status: 'active',
      installer: 'app:geo_app',
    });
    expect(readManagedBy({ installer: 'app:geo_app', appId: 'geo_app', name: 'Geo', version: '1.0.0', status: 'disconnected' })).toMatchObject({
      agentId: 'geo-app',
      status: 'disconnected',
    });
    expect(readManagedBy({ installer: 'app:someday' })).toMatchObject({ agentId: 'someday', name: 'someday' });
    expect(readManagedBy(null)).toBeNull();
    expect(readManagedBy({ name: 'x' })).toBeNull();
  });

  it('finds managedBy in an error body, top level or in details', () => {
    const inDetails = new WireSdkError('container_agent_managed', 'managed', 409, { managedBy: { agentId: 'someday', name: 'Someday' } });
    expect(managedByFromError(inDetails)?.agentId).toBe('someday');
    const body = {
      success: false,
      error: { code: 'container_app_managed', message: 'm', details: { managedBy: { appId: 'someday' } } },
      code: 'container_app_managed',
    };
    expect(managedByFromError(body)?.agentId).toBe('someday');
    const top = { code: 'container_agent_managed', managedBy: { agentId: 'geo-app', name: 'Geo' } };
    expect(managedByFromError(top)?.name).toBe('Geo');
    expect(managedByFromError(new WireSdkError('NOT_FOUND', 'x', 404, { managedBy: { agentId: 'x' } }))).toBeNull();
  });

  it('is exported from the agent entry too', () => {
    expect(agentEntry.isAgentManagedError).toBe(isAgentManagedError);
  });
});
