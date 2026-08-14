import { ExecutionState } from './executionState';
import type { ContextItem } from './requestCapsule';

export type ToolRisk = 'read-only' | 'consequential';
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];

/** A deliberately small JSON-schema subset for the first runtime slice. */
export interface ObjectInputSchema {
  readonly type: 'object';
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, { readonly type: 'string' | 'number' | 'boolean' }>>;
}

export interface ToolDefinition {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly description: string;
  readonly inputSchema: ObjectInputSchema;
  readonly risk: ToolRisk;
  readonly requiresApproval: boolean;
  readonly expectedOutputClass: 'evidence';
  readonly isAvailable?: (state: ExecutionState) => boolean;
}

export interface PresentedTool {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: ObjectInputSchema;
}

export interface ToolRequest {
  readonly toolId: string;
  readonly arguments: unknown;
}

export type ToolRequestValidation =
  | { readonly valid: true; readonly tool: ToolDefinition; readonly arguments: JsonObject }
  | { readonly valid: false; readonly code: 'unknown-tool' | 'malformed-arguments'; readonly message: string };

export interface ToolExecutionResult {
  /** Retained by the executor only; it must not be copied into task state. */
  readonly rawOutput?: string;
  readonly evidenceSummary: string;
  readonly provenance: string;
  /**
   * Bounded source text for only the next inference. It is intentionally not
   * copied to durable task state or diagnostics.
   */
  readonly transientModelContext?: Omit<ContextItem, 'id'>;
}

export interface ToolExecutor {
  execute(request: { readonly tool: ToolDefinition; readonly arguments: JsonObject }, signal: AbortSignal): Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public constructor(definitions: readonly ToolDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  public register(definition: ToolDefinition): void {
    if (this.tools.has(definition.id)) {
      throw new Error(`WayFinder tool '${definition.id}' is already registered.`);
    }
    this.tools.set(definition.id, definition);
  }

  public present(state: ExecutionState): readonly PresentedTool[] {
    return [...this.tools.values()]
      .filter((tool) => tool.capabilities.every((capability) => state.allowedCapabilities.includes(capability)))
      .filter((tool) => tool.isAvailable?.(state) ?? true)
      .map(({ id, description, inputSchema }) => ({ id, description, inputSchema }));
  }

  public validate(request: ToolRequest, state: ExecutionState): ToolRequestValidation {
    const tool = this.tools.get(request.toolId);
    if (!tool || !this.present(state).some((presented) => presented.id === request.toolId)) {
      return { valid: false, code: 'unknown-tool', message: `Tool '${request.toolId}' is not available for this step.` };
    }
    if (!isObjectMatchingSchema(request.arguments, tool.inputSchema)) {
      return { valid: false, code: 'malformed-arguments', message: `Tool '${request.toolId}' received malformed arguments.` };
    }
    return { valid: true, tool, arguments: request.arguments };
  }
}

function isObjectMatchingSchema(value: unknown, schema: ObjectInputSchema): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  for (const required of schema.required ?? []) {
    if (!(required in object)) return false;
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const candidate = object[name];
    if (candidate !== undefined && typeof candidate !== property.type) return false;
  }
  return true;
}
