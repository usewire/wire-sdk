/**
 * Agent links: `wire_write` `links` and `wire_delete` `withLinked`, mapped by a
 * manifest's tools. The validator vendored at MANIFEST_REF knows both arguments,
 * so a manifest that uses them passes locally exactly as it will on install.
 */
import { describe, expect, it } from 'vitest';
import { defineManifest, WireManifestError } from '../app/index.js';

const base = { manifest: 1 as const, app: { id: 'someday', name: 'Someday', version: '1.0.0' } };

const addNote = {
  name: 'add_note',
  description: 'Add a note about a place.',
  inputSchema: {
    type: 'object',
    properties: { place_id: { type: 'string' }, text: { type: 'string' } },
    required: ['place_id', 'text'],
    additionalProperties: false,
  },
  tool: {
    name: 'wire_write',
    args: {
      content: '{{input.text}}',
      object: 'notes',
      fields: { place_id: '{{input.place_id}}' },
      links: [{ to: '{{input.place_id}}', type: 'about' }],
    },
  },
};

const removePlace = {
  name: 'remove_place',
  description: 'Remove a place and every note about it.',
  inputSchema: { type: 'object', properties: { place_id: { type: 'string' } }, required: ['place_id'], additionalProperties: false },
  tool: { name: 'wire_delete', args: { entryId: '{{input.place_id}}', withLinked: { types: ['about'], direction: 'incoming' } } },
};

describe('links in a manifest', () => {
  it('accepts a wire_write that links a note to its place, and a wire_delete that takes the notes with it', () => {
    const m = defineManifest({ ...base, tools: [addNote, removePlace] } as never);
    expect((m as { tools?: { name: string }[] }).tools?.map((t) => t.name)).toEqual(['add_note', 'remove_place']);
  });

  it('refuses a link whose target may be missing', () => {
    const optional = { ...addNote, inputSchema: { ...addNote.inputSchema, required: ['text'] } };
    expect(() => defineManifest({ ...base, tools: [optional] } as never)).toThrow(WireManifestError);
  });

  it('refuses withLinked in a direction the container does not follow', () => {
    const outgoing = { ...removePlace, tool: { ...removePlace.tool, args: { entryId: '{{input.place_id}}', withLinked: { types: ['about'], direction: 'outgoing' } } } };
    expect(() => defineManifest({ ...base, tools: [outgoing] } as never)).toThrow(WireManifestError);
  });
});
