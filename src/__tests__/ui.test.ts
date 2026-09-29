/**
 * Interactive views (MCP Apps, SUP-953): a manifest's `ui` and a tool's `ui`,
 * checked by the engine's own validator (vendored at MANIFEST_REF).
 */
import { describe, expect, it } from 'vitest';
import {
  defineManifest,
  uiDomainProblem,
  uiUri,
  UI_HTML_MAX_BYTES,
  UI_MIME_TYPE,
  WireManifestError,
  type ManifestToolUi,
  type ManifestUi,
  type WireManifest,
} from '../app/index.js';

const view: ManifestUi = {
  name: 'places-map',
  title: 'Places map',
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  csp: { connectDomains: ['https://tiles.openfreemap.org'], resourceDomains: ['https://cdn.jsdelivr.net'] },
};

function manifest(overrides: Partial<WireManifest> = {}, toolUi: unknown = { resource: 'places-map' }): WireManifest {
  return {
    manifest: 1,
    app: { id: 'someday', name: 'Someday', version: '1.0.0' },
    tools: [
      {
        name: 'search_places',
        description: 'Find saved places.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        tool: { name: 'wire_search', args: { query: '{{input.query}}' } },
        result: { presentation: 'map', matches: '{{tool.matches}}' },
        ui: toolUi as ManifestToolUi,
      },
    ],
    ui: [view],
    ...overrides,
  };
}

function errorsOf(fn: () => unknown): ReadonlyArray<{ path: string; message: string }> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WireManifestError);
    return (e as WireManifestError).issues;
  }
  throw new Error('expected WireManifestError');
}

describe('manifest ui', () => {
  it('accepts a view and a tool that renders with it, and keeps both in the normalized manifest', () => {
    const m = defineManifest(manifest());
    expect(m.ui).toEqual([view]);
    expect(m.tools?.[0]?.ui).toEqual({ resource: 'places-map' });
  });

  it('accepts visibility on a tool ui', () => {
    const m = defineManifest(manifest({}, { resource: 'places-map', visibility: ['app', 'model'] }));
    expect(m.tools?.[0]?.ui?.visibility).toEqual(['model', 'app']);
  });

  it('refuses a tool ui naming a view the manifest does not declare', () => {
    const errors = errorsOf(() => defineManifest(manifest({}, { resource: 'nope' })));
    expect(errors.some((e) => e.path === 'tools.0.ui.resource')).toBe(true);
  });

  it('refuses a CSP origin that is not https, or is Wire', () => {
    const bad = { ...view, csp: { connectDomains: ['http://tiles.example.com'], resourceDomains: ['https://cdn.usewire.io'] } };
    const errors = errorsOf(() => defineManifest(manifest({ ui: [bad] })));
    expect(errors.map((e) => e.path)).toEqual(expect.arrayContaining(['ui.0.csp.connectDomains.0', 'ui.0.csp.resourceDomains.0']));
  });

  it('refuses html over the per-view cap', () => {
    const big = { ...view, html: `<html>${'x'.repeat(UI_HTML_MAX_BYTES)}</html>` };
    const errors = errorsOf(() => defineManifest(manifest({ ui: [big] })));
    expect(errors.some((e) => e.path === 'ui.0.html')).toBe(true);
  });

  it('exposes the engine constants and helpers', () => {
    expect(UI_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(UI_HTML_MAX_BYTES).toBe(512 * 1024);
    expect(uiUri('someday', 'places-map')).toBe('ui://someday/places-map');
    expect(uiDomainProblem('https://*.basemaps.cartocdn.com')).toBeNull();
    expect(uiDomainProblem('blob:')).not.toBeNull();
  });
});
