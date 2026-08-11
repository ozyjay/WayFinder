import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ExecutionPhase, ModelTier, TokenBudget } from './executionState';
import { ContextItemType } from './requestCapsule';

/** Metadata only: never prompts, source content, tool arguments, or raw results. */
export interface InferenceDiagnostic {
  readonly timestamp: string;
  readonly iteration: number;
  readonly modelTier: ModelTier;
  readonly phase: ExecutionPhase;
  readonly contextItemTypes: readonly ContextItemType[];
  readonly contextProvenance: readonly string[];
  readonly contextCharactersByType: Readonly<Record<ContextItemType, number>>;
  readonly inputBudget: TokenBudget;
  readonly outputBudget: TokenBudget;
  readonly exposedToolCount: number;
  readonly exposedToolSchemaBytes: number;
  readonly stablePrefixId: string;
  readonly latencyMs: number;
  readonly outcome: 'final' | 'tool-request' | 'validation-rejected' | 'approval-required' | 'cancelled' | 'stopped' | 'failed';
  readonly validationCode?: 'unknown-tool' | 'malformed-arguments' | 'unsupported-response';
  readonly escalation?: 'fast-to-deep';
  readonly stopReason?: 'iteration-limit' | 'cancelled' | 'validation-limit' | 'tool-rejected';
}

export interface DiagnosticsSink {
  record(entry: InferenceDiagnostic): Promise<void>;
}

export class InMemoryDiagnostics implements DiagnosticsSink {
  public readonly entries: InferenceDiagnostic[] = [];

  public async record(entry: InferenceDiagnostic): Promise<void> {
    this.entries.push(entry);
  }
}

export class JsonlRuntimeDiagnostics implements DiagnosticsSink {
  public constructor(private readonly path: string) {}

  public async record(entry: InferenceDiagnostic): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  public async read(): Promise<readonly InferenceDiagnostic[]> {
    try {
      return (await readFile(this.path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as InferenceDiagnostic);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
