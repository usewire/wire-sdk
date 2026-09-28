/**
 * JSON Schema validation for action input and output: the ENGINE's
 * `validateValue`, vendored (src/vendor/manifest, pinned by MANIFEST_REF).
 *
 * The same code the container runs, so an agent and Wire never disagree about
 * whether a value fits an action's schema. It supports exactly the schema
 * subset the manifest validator admits for action input/output (a schema that
 * passed the manifest validator is one it can check), runs anywhere (no eval,
 * no imports), and bounds its own work, so an oversized or deeply nested value
 * is refused rather than checked for as long as it takes.
 */
import { validateValue } from '../vendor/manifest/manifest.js';

export type JsonSchema = Record<string, unknown>;

export interface SchemaIssue {
  /** Where in the value, dotted and rooted at `input` or `output`, e.g. "input.address". */
  path: string;
  message: string;
}

export type CompiledSchema = (value: unknown) => SchemaIssue[];

/** A checker for one schema, rooted at `root` ("input" or "output"). */
export function compileSchema(schema: JsonSchema, root: string): CompiledSchema {
  return (value) => validateValue(value, schema, root).map((e) => ({ path: e.path, message: e.message }));
}
