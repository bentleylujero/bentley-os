// schema.ts — the structured decision marionette returns from /think.
//
// Designed to grow. Today the only reachable decision is "reply". When opencode
// (and later other services) can receive work, we add "delegate" as an additional
// variant WITHOUT changing the existing shape — additive, not a rewrite.

export type DecisionKind = 'reply' | 'delegate';

export interface Decision {
  decision: DecisionKind;
  message: string;
  reasoning: string;
  target_service?: string;
  spec?: string;
}

// The only decision kind marionette can currently act on. Anything else coming
// back from the model is coerced to a safe reply so we never pretend to delegate
// to a service that can't yet receive it.
export const SUPPORTED_DECISIONS: DecisionKind[] = ['reply'];

// Validates and normalizes whatever JSON the model returned into a Decision.
// If the model returns something unexpected, we degrade to a reply rather than
// throwing — marionette should never crash on its own output shape.
export function normalizeDecision(raw: unknown): Decision {
  const obj = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};

  let decision = obj.decision;
  if (typeof decision !== 'string' || !SUPPORTED_DECISIONS.includes(decision as DecisionKind)) {
    decision = 'reply';
  }

  const message = typeof obj.message === 'string' ? obj.message : '';
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

  return { decision: decision as DecisionKind, message, reasoning };
}
