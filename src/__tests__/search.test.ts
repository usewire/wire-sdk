/**
 * wire_search (usewire/wire#128): `object` may be a list, and `matchLinked` lets linked records
 * (a note about a place) lift a result. Both are base-tool arguments a manifest tool may fix or
 * fill, checked by the vendored validator.
 */
import { describe, expect, it } from 'vitest';
import { defineManifest, WireManifestError, type WireManifest } from '../app/index.js';

function withSearch(args: Record<string, unknown>): WireManifest {
  return {
    manifest: 1,
    app: { id: 'someday', name: 'Someday', version: '1.0.0' },
    tools: [
      {
        name: 'search_places',
        description: 'Find saved places, including by what the user wrote about them.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
        tool: { name: 'wire_search', args: { query: '{{input.query}}', ...args } },
      },
    ],
  };
}

describe('wire_search in a manifest tool', () => {
  it('accepts object as a list', () => {
    const m = defineManifest(withSearch({ object: ['place', 'note', 'visit', 'event'] }));
    expect(m.tools?.[0]?.tool.args.object).toEqual(['place', 'note', 'visit', 'event']);
  });

  it('accepts matchLinked', () => {
    const m = defineManifest(withSearch({ object: 'place', matchLinked: { objects: ['note', 'visit', 'event'], direction: 'incoming' } }));
    expect(m.tools?.[0]?.tool.args.matchLinked).toEqual({ objects: ['note', 'visit', 'event'], direction: 'incoming' });
  });

  it('refuses matchLinked without objects, or with an unknown key', () => {
    expect(() => defineManifest(withSearch({ matchLinked: { types: ['about'] } }))).toThrow(WireManifestError);
    expect(() => defineManifest(withSearch({ matchLinked: { objects: ['note'], depth: 2 } }))).toThrow(WireManifestError);
  });
});
