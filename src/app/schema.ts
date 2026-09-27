/**
 * JSON Schema validation for action input and output.
 *
 * @cfworker/json-schema: no eval / new Function (so it runs in Cloudflare
 * Workers), no dependencies. Only the app entry imports it, so apps that only
 * use the connection manager never bundle it.
 */
import { Validator, type Schema } from '@cfworker/json-schema';

export type JsonSchema = Record<string, unknown>;

export interface SchemaIssue {
  /** JSON Pointer into the validated value, e.g. "/address". */
  path: string;
  /** The schema keyword that failed, e.g. "required", "type". */
  keyword: string;
  message: string;
}

export type CompiledSchema = (value: unknown) => SchemaIssue[];

const MAX_ISSUES = 20;

/** Compile once; throws if the schema cannot be used. */
export function compileSchema(schema: JsonSchema): CompiledSchema {
  // The validator annotates the schema object it is given (__absolute_uri__
  // and friends); give it a private copy so the manifest is never altered and
  // never registered with those keys.
  const validator = new Validator(structuredClone(schema) as Schema, '2020-12', false);
  // Exercise it once so a broken schema (bad $ref, bad pattern) fails at
  // definition time, not on the first call.
  validator.validate(null);
  return (value) => {
    const result = validator.validate(value);
    if (result.valid) return [];
    // Leaf errors only (the ones with a keyword other than the combinators'
    // summaries), capped: the first few name the problem.
    return result.errors
      .filter((e) => e.keyword !== 'properties' && e.keyword !== 'items' && e.keyword !== 'allOf')
      .slice(0, MAX_ISSUES)
      .map((e) => ({ path: e.instanceLocation.replace(/^#/, ''), keyword: e.keyword, message: e.error }));
  };
}
