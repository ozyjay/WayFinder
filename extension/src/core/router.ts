import { BackendId, InvocationObservation, RouteDecision, VirtualModelId } from './types';

/**
 * Gate 0 deliberately uses a tiny, inspectable rule. It is an experimental
 * stimulus, not the future trajectory-aware routing policy.
 */
export function selectBackend(
  virtualModel: VirtualModelId,
  observation: InvocationObservation,
): RouteDecision {
  if (virtualModel === 'wayfinder-fast') {
    return fixed('fast', 'The user selected the Fast virtual model.');
  }

  if (virtualModel === 'wayfinder-deep') {
    return fixed('deep', 'The user selected the Deep virtual model.');
  }

  if (observation.toolResultCount === 0) {
    return {
      backend: 'fast',
      reason: 'Initial or text-only inference uses the Fast backend.',
      evidence: ['no tool results in the supplied conversation'],
    };
  }

  if (observation.toolResultCount >= 3) {
    return {
      backend: 'fast',
      reason: 'The fixture returns to Fast after several tool results.',
      evidence: [`${observation.toolResultCount} tool results in the supplied conversation`],
    };
  }

  return {
    backend: 'deep',
    reason: 'The fixture escalates after the first tool-result boundary.',
    evidence: [`${observation.toolResultCount} tool result in the supplied conversation`],
  };
}

function fixed(backend: BackendId, reason: string): RouteDecision {
  return { backend, reason, evidence: ['explicit virtual-model selection'] };
}

