import type { ValidationError } from "../tools/custom.js";
/** The one file a v1 skill has, and the file every skill has. */
export declare const SKILL_FILE = "SKILL.md";
/** The URI scheme skills are served under. */
export declare const SKILL_URI_SCHEME = "skill://";
/** The Skills extension's identifier, as a server declares it in its capabilities. */
export declare const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** Agent Skills: 1-64 lowercase ASCII letters and digits in hyphen-separated runs (no leading,
 *  trailing or doubled hyphen). ASCII only, so the name is always a valid URI authority. */
export declare const SKILL_NAME_RE: RegExp;
export declare const SKILL_NAME_MAX = 64;
export declare const SKILL_DESCRIPTION_MAX = 1024;
export declare const SKILL_COMPATIBILITY_MAX = 500;
export declare const SKILL_LICENSE_MAX = 500;
export declare const SKILL_METADATA_MAX_KEYS = 64;
export declare const SKILL_METADATA_VALUE_MAX = 1024;
/** Largest frontmatter block, in characters: the fields above fit in a fraction of it. */
export declare const SKILL_FRONTMATTER_MAX = 16000;
/** The media type a SKILL.md is served as. */
export declare const SKILL_MEDIA_TYPE = "text/markdown";
/** A skill's frontmatter, as the file states it (and as `skills/list` carries it). Keys appear in
 *  the file's order. */
export interface SkillFrontmatter {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
}
export type SkillParse = {
    ok: true;
    frontmatter: SkillFrontmatter;
    body: string;
} | {
    ok: false;
    errors: ValidationError[];
};
/** `skill://<name>/<path>`: the resource URI of one file of a skill. */
export declare function skillUri(name: string, path?: string): string;
/** Read a `skill://<name>/<path>` URI into its parts, or null when it is not one this engine could
 *  serve (a v1 skill path is one segment; any `.`/`..` segment, empty segment, query, fragment,
 *  percent-escape or backslash is refused rather than normalized). */
export declare function parseSkillUri(uri: unknown): {
    name: string;
    path: string;
} | null;
/**
 * Validate a SKILL.md and read its frontmatter. Errors are paths under `skill` (`skill.name`,
 * `skill.frontmatter.line 4`). Never throws.
 */
export declare function parseSkill(text: unknown): SkillParse;
/** The server instructions a managed container sends when its manifest has a skill but no
 *  `instructions` (SUP-962): the skill's description and where to read the full guide. */
export declare function instructionsFromSkill(frontmatter: Pick<SkillFrontmatter, "name" | "description">): string;
