/**
 * The manifest's skill (SUP-962). `defineSkill` writes a SKILL.md Wire always
 * accepts, and checks one you wrote with Wire's own reader (vendored at
 * MANIFEST_REF), the same one the container runs on install.
 */
import { describe, expect, it } from 'vitest';
import { defineManifest, defineSkill, parseSkill, skillFrontmatter, skillUri, WireManifestError } from '../app/index.js';

describe('defineSkill', () => {
  it('writes a SKILL.md from its parts, with every value quoted', () => {
    const text = defineSkill({
      name: 'someday',
      description: 'Save places: restaurants, bars, "anything". Use when the user mentions a place.',
      license: 'MIT',
      metadata: { author: 'someday', version: '1.0' },
      body: '# Someday\n\nCall `save_place`.',
    });
    expect(text).toBe(
      '---\nname: "someday"\ndescription: "Save places: restaurants, bars, \\"anything\\". Use when the user mentions a place."\nlicense: "MIT"\nmetadata:\n  author: "someday"\n  version: "1.0"\n---\n\n# Someday\n\nCall `save_place`.\n'
    );
    expect(skillFrontmatter(text)).toEqual({
      name: 'someday',
      description: 'Save places: restaurants, bars, "anything". Use when the user mentions a place.',
      license: 'MIT',
      metadata: { author: 'someday', version: '1.0' },
    });
    expect(skillUri('someday')).toBe('skill://someday/SKILL.md');
  });

  it('checks a SKILL.md you wrote and returns it unchanged', () => {
    const text = '---\nname: someday\ndescription: Save places.\n---\n\n# Someday\n';
    expect(defineSkill(text)).toBe(text);
  });

  it('throws WireManifestError with every problem and its path', () => {
    const bad = () => defineSkill({ name: 'Some Day', description: '', body: 'x' });
    expect(bad).toThrow(WireManifestError);
    try {
      bad();
    } catch (e) {
      expect((e as WireManifestError).issues.map((i) => i.path).sort()).toEqual(['skill.description', 'skill.name']);
    }
    expect(() => defineSkill('# no frontmatter')).toThrow(/must open with YAML frontmatter/);
    expect(() => defineSkill('---\nname: a\ndescription: d\nversion: 1.0\n---\n')).toThrow(/unknown field|non-string/);
    expect(() => defineSkill('---\nname: a\ndescription: >\n  folded\n---\n')).toThrow(WireManifestError);
    expect(() => defineSkill('---\nname: a\ndescription: d\nallowed-tools: Bash\n---\n')).toThrow(/pre-approve/);
  });

  it('parseSkill returns errors instead of throwing, for CI checks', () => {
    const r = parseSkill('---\nname: a\n---\n');
    expect(r.ok).toBe(false);
  });
});

describe('in a manifest', () => {
  const base = { manifest: 1 as const, app: { id: 'someday', name: 'Someday', version: '1.0.0' } };

  it('defineManifest accepts a skill defineSkill wrote, verbatim', () => {
    const skill = defineSkill({ name: 'someday', description: 'Save places.', body: '# Someday\n' });
    const m = defineManifest({ ...base, instructions: 'Use save_place.', skill });
    expect(m.skill).toBe(skill);
    expect(m.instructions).toBe('Use save_place.');
  });

  it('defineManifest refuses an invalid skill, with the path', () => {
    expect(() => defineManifest({ ...base, skill: 'just text' })).toThrow(/skill: must open with YAML frontmatter/);
  });
});
