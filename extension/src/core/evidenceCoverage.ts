import type { ContextItem } from './requestCapsule';

export interface EvidenceCoverage {
  readonly sourceTermCount: number;
  readonly coveredTermCount: number;
  readonly requiredTermCount: number;
  readonly meetsRequirement: boolean;
}

/**
 * Measures transparent lexical coverage for the deliberately narrow
 * direct-file-read fixture. It reports counts only and never returns source
 * terms, so it is safe to include in evaluation metadata.
 */
export function readFileEvidenceCoverage(
  context: readonly ContextItem[],
  response: string,
): EvidenceCoverage | undefined {
  const fileEvidence = context.find((item) => item.provenance === 'vscode.workspace.fs.readFile');
  if (!fileEvidence) return undefined;

  // The first line is a tool-added path label, not file content.
  const source = fileEvidence.content.slice(fileEvidence.content.indexOf('\n') + 1);
  const sourceTerms = distinctTerms(source);
  if (sourceTerms.length < 3) return undefined;
  const responseTerms = new Set(distinctTerms(response));
  const coveredTermCount = sourceTerms.filter((term) => responseTerms.has(term)).length;
  const requiredTermCount = Math.ceil(sourceTerms.length * 0.6);
  return {
    sourceTermCount: sourceTerms.length,
    coveredTermCount,
    requiredTermCount,
    meetsRequirement: coveredTermCount >= requiredTermCount,
  };
}

function distinctTerms(value: string): readonly string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])];
}
