/**
 * The agent side ships as its own subpath (`/agent`, and `/app` under its
 * pre-0.10 name), and the root entry does not grow.
 * Runs against the built package (dist/), resolved by package name through
 * the exports map exactly as a consumer would.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'dist');

beforeAll(() => {
  if (!existsSync(join(dist, 'app/index.js')) || !existsSync(join(dist, 'agent/index.js'))) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  }
}, 120_000);

function importByName(specifier: string): string[] {
  // Self-reference: Node resolves the package's own name through its exports map.
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(specifier)}); console.log(JSON.stringify(Object.keys(m).sort()));`],
    { cwd: root, encoding: 'utf8' }
  );
  return JSON.parse(out) as string[];
}

/** Every file reachable from `entry` through relative imports, plus bare specifiers. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2]!;
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  visit(entry);
  return { files, packages };
}

const AGENT_SIDE = [
  'WireAgentClient',
  'WireAgentApiError',
  'AGENT_API_AUDIENCE',
  'AGENT_API_BODY_HASH_CLAIM',
  'AGENT_API_TOKEN_LIFETIME_SEC',
  'isAgentManagedError',
  'managedByFromError',
  'CONTAINER_AGENT_MANAGED',
  'normalizeRevokedReason',
];
const DEPRECATED = ['WireAppClient', 'WireAppApiError', 'APP_API_AUDIENCE', 'APP_API_BODY_HASH_CLAIM', 'APP_API_TOKEN_LIFETIME_SEC', 'CONTAINER_APP_MANAGED'];

describe('package exports', () => {
  it('@usewire/sdk/agent and @usewire/sdk/app expose the same agent side, new names and deprecated ones', () => {
    const agent = importByName('@usewire/sdk/agent');
    const app = importByName('@usewire/sdk/app');
    expect(agent).toEqual(app);
    for (const name of [...AGENT_SIDE, ...DEPRECATED]) expect(agent).toContain(name);
  });

  it('@usewire/sdk/app exposes the app side', () => {
    const names = importByName('@usewire/sdk/app');
    for (const name of [
      'defineAction',
      'defineManifest',
      'verifyWireAction',
      'toNodeHandler',
      'MemoryReplayStore',
      'WireActionAuthError',
      'WireActionError',
      'WireManifestError',
      'DEFAULT_WIRE_JWKS_URL',
      'normalizeActionUrl',
      'validateManifest',
      'MANIFEST_VALIDATOR_REF',
      // SUP-962
      'defineSkill',
      'skillFrontmatter',
      'parseSkill',
      'skillUri',
      // SUP-953
      'UI_MIME_TYPE',
      'UI_EXTENSION',
      'UI_HTML_MAX_BYTES',
      'uiUri',
      'uiDomainProblem',
      'uiResourceHash',
      'parseUiUri',
      'VIEW_META_KEY',
      // SUP-958
      'WireAppClient',
      'WireAppApiError',
      'generateRuntimeKey',
      'verifyWireWebhook',
      'defineWebhook',
      'WireWebhookError',
      'WIRE_WEBHOOK_EVENT_TYPES',
      'WIRE_WEBHOOK_JWT_TYP',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('@usewire/sdk still exposes the connection manager, and not the app side', () => {
    const names = importByName('@usewire/sdk');
    expect(names).toContain('WireClient');
    expect(names).toContain('WireProvisionClient');
    expect(names).not.toContain('defineAction');
    expect(names).not.toContain('WireAppClient');
    expect(names).not.toContain('WireAgentClient');
    // The managed-container helpers are small and useful to connect-only agents.
    expect(names).toContain('isAgentManagedError');
    expect(names).not.toContain('verifyWireWebhook');
    expect(names).not.toContain('verifyWireAction');
  });

  it("the root entry's runtime import graph does not reach the app side", () => {
    const { files, packages } = importGraph(join(dist, 'index.js'));
    expect([...files].some((f) => f.includes(`${join(dist, 'app')}`))).toBe(false);
    expect([...files].some((f) => f.includes(`${join(dist, 'agent')}`))).toBe(false);
    // Only the one-line validator ref, never the vendored validator itself.
    expect([...files].some((f) => f.endsWith(join('vendor', 'manifest', 'manifest.js')))).toBe(false);
    expect([...packages].filter((p) => !p.startsWith('node:'))).toEqual(['jose']);
  });

  it('ships the vendored validator in dist and pins it to MANIFEST_REF', async () => {
    const ref = readFileSync(join(root, 'MANIFEST_REF'), 'utf8').trim();
    const js = readFileSync(join(dist, 'vendor/manifest/manifest.js'), 'utf8');
    expect(js.split('\n')[0]).toContain(`usewire/wire@${ref}`);
    expect(existsSync(join(dist, 'vendor/manifest/manifest.d.ts'))).toBe(true);
    const { MANIFEST_VALIDATOR_REF } = await import(join(dist, 'vendor/manifest/ref.js'));
    expect(MANIFEST_VALIDATOR_REF).toBe(ref);
  });

  it('declares types for the subpaths', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.exports['./app'].types).toBe('./dist/app/index.d.ts');
    expect(existsSync(join(root, pkg.exports['./app'].types))).toBe(true);
    expect(pkg.exports['./agent'].types).toBe('./dist/agent/index.d.ts');
    expect(existsSync(join(root, pkg.exports['./agent'].types))).toBe(true);
    expect(pkg.typesVersions['*'].agent).toEqual(['./dist/agent/index.d.ts']);
  });
});
