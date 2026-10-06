/**
 * The SDK accepts exactly what Wire's registration accepts.
 *
 * Wire runs the engine's validator with `wire_claim` as a tool a custom tool
 * may wrap, then two rules of its own. These cases are the ones Wire's own
 * tests hold for that path; a manifest that passes here and is refused by Wire
 * (or the reverse) is a bug in this package.
 */
import { describe, expect, it } from 'vitest';
import {
  claimMapping,
  defineManifest,
  manifestWarnings,
  MANIFEST_VALIDATOR_REF,
  validateManifest,
  validateWireManifest,
  WIRE_CLAIM_TOOL,
  WireManifestError,
} from '../app/index.js';

const base = () => ({
  manifest: 1 as const,
  app: { id: 'someday', name: 'Someday', version: '1.0.0' },
  objects: [{ name: 'place', fields: [{ name: 'name', type: 'text' as const }] }],
  tools: [
    { name: 'save_place', description: 'Save a place.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, tool: { name: 'wire_write', args: { content: '{{input.name}}' } } },
    { name: 'find_places', description: 'Find saved places.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, tool: { name: 'wire_search', args: { query: '{{input.q}}' } } },
  ],
});
const claimTool = (over: Record<string, unknown> = {}) => ({
  name: 'keep_my_places',
  description: 'Keep the places you saved by creating a free account.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  tool: { name: 'wire_claim', args: {} },
  ...over,
});
const errorsOf = (m: unknown) => {
  const v = validateWireManifest(m);
  return v.ok ? [] : v.errors;
};

describe('the pin', () => {
  it('is the engine commit Wire runs in production', () => {
    expect(MANIFEST_VALIDATOR_REF).toBe('c590e34c3d4d9bd0d3c3c9cd8bf4a3ebeab098cb');
  });
});

describe('access (Sign in with Wire)', () => {
  it('each level is accepted, with its descriptions and identity fields, and reported with every key filled', () => {
    const cases = [
      { level: 'none' as const, identity: ['email' as const] },
      { level: 'read' as const, read: 'Shows your saved places.' },
      { level: 'write' as const, read: 'Shows your saved places.', write: 'Saves places you add.', identity: ['email' as const, 'profile' as const] },
    ];
    // asking for an identity field needs a privacy policy (below)
    const app = { ...base().app, privacy_policy_url: 'https://someday.example/privacy' };
    for (const access of cases) {
      const v = validateWireManifest({ ...base(), app, access });
      expect(v.ok, JSON.stringify(v)).toBe(true);
      if (!v.ok) continue;
      expect(v.access).toMatchObject({ declared: true, level: access.level, identity: access.identity ?? [] });
      expect(v.manifest.access).toEqual(access);
      // the typed entry point takes the same document
      expect(() => defineManifest({ ...base(), app, access })).not.toThrow();
    }
  });

  it('asking for an identity field requires a privacy policy', () => {
    for (const identity of [['email'], ['profile'], ['email', 'profile']]) {
      expect(errorsOf({ ...base(), access: { level: 'none', identity } }), identity.join()).toEqual([
        { path: 'app.privacy_policy_url', message: expect.stringContaining('is required when access.identity asks for') },
      ]);
    }
    // no identity field, no requirement
    expect(validateWireManifest({ ...base(), access: { level: 'read', read: 'Shows your saved places.' } }).ok).toBe(true);
  });

  it('no access block is level none, not declared', () => {
    const v = validateWireManifest(base());
    expect(v.ok && v.access).toMatchObject({ declared: false, level: 'none', identity: [] });
  });

  it('refuses what Wire refuses: an unknown level or field, a description above the level, markup in a description', () => {
    const bad = [
      { level: 'admin' },
      { level: 'read', identity: ['phone'] },
      { level: 'read', write: 'Saves places.' },
      { level: 'none', read: 'Reads.' },
      { level: 'read', read: '<b>Reads</b> your places' },
      { level: 'read', read: 'See https://someday.example for why' },
      { level: 'read', read: 'x'.repeat(201) },
      { level: 'read', extra: true },
    ];
    for (const access of bad) {
      const errors = errorsOf({ ...base(), access });
      expect(errors.length, JSON.stringify(access)).toBeGreaterThan(0);
      expect(errors.every((e) => e.path.startsWith('access')), JSON.stringify(errors)).toBe(true);
      expect(() => defineManifest({ ...base(), access } as never)).toThrow(WireManifestError);
    }
  });

  it('a manifest that sends records to its own server may not declare `none`, and is WARNED when it declares nothing', () => {
    const sending = {
      ...base(),
      actions: [{ name: 'enrich', description: 'Receives the places found.', url: 'https://api.someday.example/enrich', input: { type: 'object' }, output: { type: 'object' } }],
      // the saved entry's id, from the write, is handed to the app's server
      tools: [{ ...base().tools[0]!, after: { action: 'enrich', args: { id: '{{tool.entryId}}' } } }, base().tools[1]!],
    };
    // undeclared: valid, with a warning Wire shows on the agent's page
    const undeclared = validateWireManifest(sending);
    expect(undeclared.ok).toBe(true);
    expect(manifestWarnings(sending).map((w) => w.code)).toEqual(['access_undeclared']);
    expect(undeclared.ok && undeclared.access.undeclaredRead).toBe(true);
    // declared none: refused
    expect(errorsOf({ ...sending, access: { level: 'none' } }).length).toBeGreaterThan(0);
    // declared read: fine, and no warning
    expect(validateWireManifest({ ...sending, access: { level: 'read', read: 'Looks up the places you search for.' } }).ok).toBe(true);
    expect(manifestWarnings({ ...sending, access: { level: 'read' } })).toEqual([]);
    expect(manifestWarnings(base())).toEqual([]);
  });
});

describe('app.privacy_policy_url', () => {
  it('an https page on your own domain is accepted and kept', () => {
    const m = defineManifest({ ...base(), app: { ...base().app, privacy_policy_url: 'https://someday.example/privacy' } });
    expect(m.app.privacy_policy_url).toBe('https://someday.example/privacy');
  });

  it('refused on Wire’s own domain, in Wire’s words', () => {
    for (const url of ['https://usewire.io/privacy', 'https://docs.usewire.io/privacy', 'https://USEWIRE.io/privacy', 'https://app.usewire.io./x']) {
      expect(errorsOf({ ...base(), app: { ...base().app, privacy_policy_url: url } }), url).toEqual([
        { path: 'app.privacy_policy_url', message: "must be your own privacy policy, on your own domain: an address on usewire.io is Wire's, not your app's" },
      ]);
    }
    // a look-alike is somebody's own domain
    expect(validateWireManifest({ ...base(), app: { ...base().app, privacy_policy_url: 'https://notusewire.io/privacy' } }).ok).toBe(true);
  });

  it('refused when it is not an https address at all (the engine’s rule)', () => {
    for (const url of ['http://someday.example/privacy', 'javascript:alert(1)', 'someday.example/privacy', '']) {
      expect(errorsOf({ ...base(), app: { ...base().app, privacy_policy_url: url } }).length, url).toBeGreaterThan(0);
    }
  });
});

describe('wire_claim', () => {
  it('a tool of your own may wrap it: 0.16.0 refused this manifest, and Wire requires it of an agent with trials on', () => {
    const m = { ...base(), tools: [...base().tools, claimTool()] };
    expect(validateWireManifest(m).ok).toBe(true);
    expect(() => defineManifest(m)).not.toThrow();
    // the engine's validator on its own does not know the tool, which is what 0.16.0 ran
    expect(validateManifest(m).ok).toBe(false);
  });

  it('never in base_tools, and its wrapping tool runs no action and renders no view', () => {
    expect(errorsOf({ ...base(), base_tools: ['wire_search', WIRE_CLAIM_TOOL] })).toEqual([
      { path: 'base_tools', message: expect.stringContaining('cannot be listed in base_tools') },
    ]);
    const withAction = {
      ...base(),
      actions: [{ name: 'note', description: 'Hears that a claim was asked for.', url: 'https://api.someday.example/note', input: { type: 'object' }, output: { type: 'object' } }],
      tools: [...base().tools, claimTool({ after: { action: 'note', args: {} } })],
    };
    expect(errorsOf(withAction)).toEqual([{ path: 'tools.2', message: expect.stringContaining('kept simple') }]);
    const withView = {
      ...base(),
      ui: [{ name: 'claim', html: '<!doctype html><title>x</title>' }],
      tools: [...base().tools, claimTool({ ui: { resource: 'claim' } })],
    };
    expect(errorsOf(withView)).toEqual([{ path: 'tools.2', message: expect.stringContaining('kept simple') }]);
  });

  it('claimMapping: exactly one usable wrap, for an agent that lets people connect without an account', () => {
    const withTools = (...extra: unknown[]) => ({ ...base(), tools: [...base().tools, ...extra] });
    expect(claimMapping(withTools(claimTool()))).toEqual({ ok: true, tool: 'keep_my_places' });
    expect(claimMapping(base())).toMatchObject({ ok: false, reason: 'none' });
    expect(claimMapping(withTools(claimTool(), claimTool({ name: 'keep_again' })))).toMatchObject({ ok: false, reason: 'more_than_one', message: expect.stringContaining('keep_my_places, keep_again') });
    expect(claimMapping({ ...base(), base_tools: [WIRE_CLAIM_TOOL] })).toMatchObject({ ok: false, reason: 'in_base_tools' });
    for (const over of [{ enabled: false }, { transports: { mcp: false } }, { result: { message: 'Open the link we sent you.' } }, { result: { _meta: { link: '{{tool.claim_url}}' } } }]) {
      expect(claimMapping(withTools(claimTool(over))), JSON.stringify(over)).toMatchObject({ ok: false, reason: 'unusable' });
    }
    // a result that carries the link, and a wrap that is REST-off, are usable
    expect(claimMapping(withTools(claimTool({ result: { message: 'Keep your places: {{ tool.claim_url }}' } })))).toMatchObject({ ok: true });
    expect(claimMapping(withTools(claimTool({ transports: { rest: false } })))).toMatchObject({ ok: true });
    // every usable mapping is also a manifest Wire registers
    expect(validateWireManifest(withTools(claimTool({ result: { message: 'Keep your places: {{tool.claim_url}}' } }))).ok).toBe(true);
    expect(claimMapping(null)).toMatchObject({ ok: false, reason: 'none' });
  });
});

describe('the rest of the contract the types now cover', () => {
  it('analysis, builtin_tools, and a tool’s enabled / transports are typed and accepted', () => {
    const m = defineManifest({
      ...base(),
      analysis: { provenance: true },
      builtin_tools: { wire_delete: { enabled: false }, wire_search: { transports: { rest: false } } },
      tools: [{ ...base().tools[0]!, enabled: true, transports: { rest: false } }, base().tools[1]!],
      base_tools: ['wire_search'],
    });
    expect(m.analysis).toEqual({ provenance: true });
    expect(m.builtin_tools).toMatchObject({ wire_delete: { enabled: false } });
  });

  it('a retired built-in tool name is accepted and ignored, as Wire does for manifests registered before it went', () => {
    expect(validateWireManifest({ ...base(), base_tools: ['wire_search', 'wire_export'] }).ok).toBe(true);
  });

  it('an unknown base tool is still refused', () => {
    expect(errorsOf({ ...base(), tools: [{ ...base().tools[0]!, tool: { name: 'wire_does_not_exist', args: {} } }] }).length).toBeGreaterThan(0);
  });
});
