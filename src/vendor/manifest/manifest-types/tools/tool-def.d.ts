export interface ToolDef {
    name: string;
    description: string;
    type: "primitive" | "retrieval" | "mutation";
    mcpEnabled: boolean;
    restEnabled: boolean;
    /** write tools require editor/admin */
    mutates: boolean;
    inputSchema: Record<string, unknown>;
}
