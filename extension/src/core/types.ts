export type BackendId = 'fast' | 'deep';
export type VirtualModelId = 'wayfinder-auto' | 'wayfinder-fast' | 'wayfinder-deep';

export interface InvocationObservation {
  readonly requestNumber: number;
  readonly messageCount: number;
  readonly textPartCount: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  /** Character-based compatibility estimate, never an authoritative token count. */
  readonly messageTokenEstimate: number;
  readonly tokenCountKind: 'character-approximation';
}

export interface RouteDecision {
  readonly backend: BackendId;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface TraceEntry extends InvocationObservation {
  readonly timestamp: string;
  readonly virtualModel: VirtualModelId;
  readonly backend: BackendId;
  readonly routingReason: string;
  readonly responseType: 'text' | 'tool-call' | 'empty' | 'error';
  readonly latencyMs: number;
  readonly backendMode: 'mock' | 'modeldeck';
  readonly errorCode?: string;
}
