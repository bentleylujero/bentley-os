// schema.ts — the structured decision marionette returns from /think.
//
// "reply" answers directly. "delegate" hands work to another service (today:
// contractor) via target_service + spec. Additive — reply's shape is unchanged.

export type DecisionKind = 'reply' | 'delegate' | 'propose';

export interface Decision {
  decision: DecisionKind;
  message: string;
  reasoning: string;
  target_service?: string;
  spec?: string;
  action_kind?: string;
  action_intent?: Record<string, unknown>;
}

// Action kinds /think is allowed to propose. Kept separate from deploy's own
// list on purpose: this is what the MODEL may reach for, not what the system
// can execute. Shape validation is actions.ts's validateActionIntent -- the
// one rule, enforced whichever door a proposal comes in.
export const PROPOSABLE_KINDS = ['service-restart', 'update_docs'];

export const SUPPORTED_DECISIONS: DecisionKind[] = ['reply', 'delegate', 'propose'];

// Services marionette is actually allowed to delegate to. Keeps the model
// from inventing a target_service that doesn't exist.
export const DELEGATABLE_SERVICES = ['contractor'];

// Validates and normalizes whatever JSON the model returned into a Decision.
// If the model returns something unexpected — unsupported decision kind, or a
// delegate with no valid target_service/spec — we degrade to a reply rather
// than throwing or delegating to something that can't receive it.
export function normalizeDecision(raw: unknown): Decision {
  const obj = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};

  let decision = obj.decision;
  if (typeof decision !== 'string' || !SUPPORTED_DECISIONS.includes(decision as DecisionKind)) {
    decision = 'reply';
  }

  const message = typeof obj.message === 'string' ? obj.message : '';
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

  if (decision === 'propose') {
    const action_kind = typeof obj.action_kind === 'string' ? obj.action_kind : '';
    const action_intent =
      (obj.action_intent && typeof obj.action_intent === 'object')
        ? (obj.action_intent as Record<string, unknown>)
        : null;

    // Can't safely propose -- degrade to reply. Same contract as delegate: we
    // never silently drop the request, and we never write a junk row.
    if (!PROPOSABLE_KINDS.includes(action_kind) || action_intent === null) {
      return { decision: 'reply', message, reasoning };
    }

    return { decision: 'propose', message, reasoning, action_kind, action_intent };
  }

  if (decision === 'delegate') {
    const target_service = typeof obj.target_service === 'string' ? obj.target_service : '';
    const spec = typeof obj.spec === 'string' ? obj.spec : '';

    if (!DELEGATABLE_SERVICES.includes(target_service) || spec.trim() === '') {
      // Can't safely delegate — degrade to reply so we never silently drop the request.
      return { decision: 'reply', message, reasoning };
    }

    return { decision: 'delegate', message, reasoning, target_service, spec };
  }

  return { decision: 'reply', message, reasoning };
}
