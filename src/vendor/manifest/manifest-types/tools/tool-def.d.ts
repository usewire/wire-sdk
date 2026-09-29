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
}
