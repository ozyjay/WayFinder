import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBackend } from '../core/router';
import { InvocationObservation } from '../core/types';

function observation(toolResultCount: number): InvocationObservation {
  return {
    requestNumber: toolResultCount + 1,
    messageCount: 2,
    textPartCount: 1,
    toolCallCount: 0,
    toolResultCount,
    messageTokenEstimate: 10,
    tokenCountKind: 'character-approximation',
  };
}

test('Gate 0 Auto fixture performs Fast → Deep → Fast at tool boundaries', () => {
  assert.equal(selectBackend('wayfinder-auto', observation(0)).backend, 'fast');
  assert.equal(selectBackend('wayfinder-auto', observation(1)).backend, 'deep');
  assert.equal(selectBackend('wayfinder-auto', observation(3)).backend, 'fast');
});

test('explicit virtual models do not use the fixture rule', () => {
  assert.equal(selectBackend('wayfinder-fast', observation(1)).backend, 'fast');
  assert.equal(selectBackend('wayfinder-deep', observation(0)).backend, 'deep');
});
