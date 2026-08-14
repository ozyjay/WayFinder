import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileEvidenceCoverage } from '../core/evidenceCoverage';

const fileEvidence = {
  id: 'readme',
  type: 'evidence' as const,
  content: "Contents of requested workspace file 'Readme.md':\n# Hello World\nWayFinder test marker: cobalt-kookaburra",
  provenance: 'vscode.workspace.fs.readFile',
  tokens: 8,
  tokenCountKind: 'estimate' as const,
  priority: 100,
};

test('readback coverage distinguishes incomplete and grounded file answers without exposing terms', () => {
  assert.deepEqual(readFileEvidenceCoverage([fileEvidence], '# Hello World'), {
    sourceTermCount: 7,
    coveredTermCount: 2,
    requiredTermCount: 5,
    meetsRequirement: false,
  });
  assert.deepEqual(
    readFileEvidenceCoverage([fileEvidence], '# Hello World\nWayFinder test marker: cobalt-kookaburra'),
    {
      sourceTermCount: 7,
      coveredTermCount: 7,
      requiredTermCount: 5,
      meetsRequirement: true,
    },
  );
});
