import type { ToolDef } from "./tool-def.js";
export declare const BUILTIN_TOOL_DEFS: ToolDef[];
/** Built-in tools this engine USED to define and no longer does. `wire_export` is not a tool:
 *  export is an owner's action on the container, not something an agent sees or a visibility toggle
 *  opens. It is a library (`readExport` in src/export.ts) run against the container's database.
 *
 *  A name here is ACCEPTED and IGNORED wherever a document may still carry it (a manifest's
 *  `builtin_tools` and `base_tools`), and its leftover visibility row is dropped when a container
 *  opens. Refusing it instead would break a registered agent's next connect between this release and
 *  its own manifest update. Once no registered manifest names a retired tool, it can be refused like
 *  any unknown name and removed from this list. */
export declare const RETIRED_BUILTIN_TOOL_NAMES: readonly string[];
