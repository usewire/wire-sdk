/**
 * wire_navigate's relationships mode (usewire/wire#127): `direction` and `limit` are base-tool
 * arguments a manifest tool may fix or fill, checked by the vendored validator.
 */
import { describe, expect, it } from 'vitest';
import { defineManifest, WireManifestError, type WireManifest } from '../app/index.js';

function withNavigate(args: Record<string, unknown>): WireManifest {
  return {
    manifest: 1,
    app: { id: 'someday', name: 'Someday', version: '1.0.0' },
    tools: [
      {
        name: 'place_history',
        description: "A saved place and the notes, visits and events about it.",
        inputSchema: { type: 'object', properties: { place_id: { type: 'string', minLength: 1 } }, required: ['place_id'] },
        tool: { name: 'wire_navigate', args: { entryId: '{{input.place_id}}', mode: 'relationships', ...args } },
      },
    ],
  };
}

describe('wire_navigate in a manifest tool', () => {
  it('accepts direction and limit', () => {
    const m = defineManifest(withNavigate({ type: ['about', 'visited', 'held_at'], direction: 'incoming', limit: 100 }));
    expect(m.tools?.[0]?.tool.args).toMatchObject({ direction: 'incoming', limit: 100 });
  });

  it('refuses a direction outside incoming / outgoing / both, and a limit over 200', () => {
    expect(() => defineManifest(withNavigate({ direction: 'sideways' }))).toThrow(WireManifestError);
    expect(() => defineManifest(withNavigate({ limit: 500 }))).toThrow(WireManifestError);
  });
});
