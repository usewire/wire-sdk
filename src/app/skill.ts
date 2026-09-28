/**
 * An agent's skill (SUP-962): the SKILL.md a manifest carries as `skill`, the
 * full usage guide for the agents that use a container your agent manages.
 *
 * When your agent is installed, the container stores the skill and serves it
 * over MCP's Skills extension (`io.modelcontextprotocol/skills`) as
 * `skill://<name>/SKILL.md`, and sends the manifest's `instructions` as the MCP
 * server instructions on `initialize`. Clients that support skills load it
 * when it is relevant. Reading it is free.
 *
 * THE ENGINE OWNS THE FORMAT. `parseSkill` is Wire's own reader, vendored with
 * the manifest validator at MANIFEST_REF: the frontmatter is the Agent Skills
 * format (`name`, `description`, optional `license`, `compatibility`,
 * `metadata`), read as a strict subset of YAML so every host reads it exactly
 * as the container does. `defineSkill` writes a SKILL.md that always passes.
 */
import { parseSkill } from '../vendor/manifest/manifest.js';
import type { SkillFrontmatter } from '../vendor/manifest/manifest.js';
import { WireManifestError } from './errors.js';

/** A skill to write: its frontmatter fields, then the Markdown body. */
export interface SkillInput {
  /** Lowercase letters, digits and single hyphens, at most 64. The skill's directory: `skill://<name>/SKILL.md`. */
  name: string;
  /** What the skill does and when to use it. At most 1,024 characters. */
  description: string;
  license?: string;
  /** Environment requirements, at most 500 characters. Most skills leave it out. */
  compatibility?: string;
  /** String keys to string values. */
  metadata?: Record<string, string>;
  /** The Markdown after the frontmatter: the guide itself. */
  body: string;
}

/**
 * A SKILL.md from its parts, or a SKILL.md you wrote, checked with Wire's own
 * reader. Returns the text to put in the manifest's `skill`, or throws
 * WireManifestError listing every problem (`skill.name`, `skill.frontmatter.line 3`).
 *
 * From parts, every value is written as a double-quoted string, so nothing in
 * it can be read as YAML syntax, a number or a boolean.
 */
export function defineSkill(skill: SkillInput | string): string {
  const text = typeof skill === 'string' ? skill : skillDocument(skill);
  const result = parseSkill(text);
  if (!result.ok) throw new WireManifestError(result.errors);
  return text;
}

/** The frontmatter a SKILL.md declares, as a host reads it, or throws WireManifestError. */
export function skillFrontmatter(text: string): SkillFrontmatter {
  const result = parseSkill(text);
  if (!result.ok) throw new WireManifestError(result.errors);
  return result.frontmatter;
}

function skillDocument(s: SkillInput): string {
  // JSON strings are YAML double-quoted scalars with the same meaning, for every escape JSON writes.
  const q = (v: string) => JSON.stringify(v);
  const lines = [`name: ${q(s.name)}`, `description: ${q(s.description)}`];
  if (s.license !== undefined) lines.push(`license: ${q(s.license)}`);
  if (s.compatibility !== undefined) lines.push(`compatibility: ${q(s.compatibility)}`);
  const md = Object.entries(s.metadata ?? {});
  if (md.length) lines.push('metadata:', ...md.map(([k, v]) => `  ${k}: ${q(v)}`));
  const body = s.body.startsWith('\n') ? s.body : `\n${s.body}`;
  return `---\n${lines.join('\n')}\n---\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}
