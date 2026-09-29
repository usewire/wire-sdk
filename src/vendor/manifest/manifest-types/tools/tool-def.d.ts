/** MCP `ToolAnnotations` (SUP-953): hints a host uses to decide how careful to be before a call. */
export interface ToolAnnotations {
    title?: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
}
export interface ToolDef {
    name: string;
    description: string;
    type: "primitive" | "retrieval" | "mutation";
    mcpEnabled: boolean;
    restEnabled: boolean;
    /** write tools require editor/admin */
    mutates: boolean;
    inputSchema: Record<string, unknown>;
    /** MCP Apps (SUP-953): the `ui://` resource that renders this tool's result, and who may call it.
     *  Set only on an app tool whose manifest gives it a UI; tools/list sends it as `_meta.ui`. */
    ui?: {
        resourceUri: string;
        visibility?: Array<"model" | "app">;
    };
    /** MCP tool annotations (SUP-953). Absent on a host tool that states none: see toolAnnotations. */
    annotations?: ToolAnnotations;
    /** JSON Schema of the result data (`structuredContent`), when the tool declares one (SUP-953). */
    outputSchema?: Record<string, unknown>;
}
/** A tool's annotations: its own, or (a host-registered tool that states none) derived from
 *  `mutates` — a writing tool is treated as destructive, since nothing says it is not. */
export declare function toolAnnotations(d: Pick<ToolDef, "annotations" | "mutates">): ToolAnnotations;
