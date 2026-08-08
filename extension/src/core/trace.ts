import { mkdir, appendFile, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TraceEntry } from './types';

export class JsonlTrace {
  public constructor(private readonly path: string) {}

  public async append(entry: TraceEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  public async read(): Promise<readonly TraceEntry[]> {
    try {
      const contents = await readFile(this.path, 'utf8');
      return contents
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TraceEntry);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }

  public async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

