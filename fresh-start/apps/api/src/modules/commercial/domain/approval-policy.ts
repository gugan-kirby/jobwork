import { DomainError } from '../../../platform/http/domain-error';

/**
 * Approval policy evaluation (doc 03 §§4–5, `FR-405`, `BR-AUTH-04`). The rules are
 * versioned data; this module only reads them. What it returns is *who may decide*,
 * recorded on the request so the decision is checked against the rule that applied at
 * request time, never against whatever the policy says later.
 */

export interface AwardPolicyRules {
  approverRoles: string[];
  singleSourceApproverRoles: string[];
}

export interface CostSheetPolicyRules {
  approverRoles: string[];
  /** Floor on margin-on-sell in basis points; below it, the exception roles decide. */
  minMarginBp: number;
  exceptionApproverRoles: string[];
}

export interface QuotePolicyRules {
  tiers: Array<{ maxMinor: number | null; roles: string[] }>;
}

export interface PolicyOutcome {
  requiredRoles: string[];
  /** The request is an exception to the normal rule and must say why. */
  exception: boolean;
  exceptionReason: string | null;
}

export class PolicyRulesInvalid extends DomainError {
  constructor(kind: string) {
    super('APPROVAL_POLICY_INVALID', 500, 'Approval policy is misconfigured', `The active ${kind} policy has no usable rules.`);
  }
}

function roles(value: unknown, kind: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string') || value.length === 0) {
    throw new PolicyRulesInvalid(kind);
  }
  return value as string[];
}

export function evaluateAwardPolicy(rules: unknown, input: { singleSource: boolean }): PolicyOutcome {
  const r = rules as Partial<AwardPolicyRules>;
  if (input.singleSource) {
    return {
      requiredRoles: roles(r.singleSourceApproverRoles ?? r.approverRoles, 'award'),
      exception: true,
      exceptionReason: 'single_source',
    };
  }
  return { requiredRoles: roles(r.approverRoles, 'award'), exception: false, exceptionReason: null };
}

export function evaluateCostSheetPolicy(rules: unknown, input: { marginBp: number }): PolicyOutcome {
  const r = rules as Partial<CostSheetPolicyRules>;
  const floor = typeof r.minMarginBp === 'number' ? r.minMarginBp : 0;
  if (input.marginBp < 0) {
    return {
      requiredRoles: roles(r.exceptionApproverRoles ?? r.approverRoles, 'cost_sheet'),
      exception: true,
      exceptionReason: 'negative_margin',
    };
  }
  if (input.marginBp < floor) {
    return {
      requiredRoles: roles(r.exceptionApproverRoles ?? r.approverRoles, 'cost_sheet'),
      exception: true,
      exceptionReason: 'below_margin_floor',
    };
  }
  return { requiredRoles: roles(r.approverRoles, 'cost_sheet'), exception: false, exceptionReason: null };
}

export function evaluateQuotePolicy(rules: unknown, input: { amountMinor: number }): PolicyOutcome {
  const r = rules as Partial<QuotePolicyRules>;
  const tiers = Array.isArray(r.tiers) ? r.tiers : [];
  for (const tier of tiers) {
    if (tier.maxMinor === null || tier.maxMinor === undefined || input.amountMinor <= tier.maxMinor) {
      return { requiredRoles: roles(tier.roles, 'quote'), exception: false, exceptionReason: null };
    }
  }
  throw new PolicyRulesInvalid('quote');
}

/** The deciding authority must hold one of the roles the request recorded. */
export function mayDecide(actorRoles: readonly string[], requiredRoles: readonly string[]): boolean {
  return requiredRoles.some((role) => actorRoles.includes(role));
}

export class NotAnApprover extends DomainError {
  constructor(requiredRoles: readonly string[]) {
    super(
      'APPROVAL_AUTHORITY_MISSING',
      403,
      'You are not an approver for this request',
      `This decision needs one of: ${requiredRoles.join(', ')}.`,
    );
  }
}

export class SelfApprovalRefused extends DomainError {
  constructor() {
    super(
      'APPROVAL_SEPARATION',
      409,
      'You cannot decide your own request',
      'The person who asked for an approval never decides it. Ask a colleague with the authority.',
    );
  }
}

export class ApprovalNotPending extends DomainError {
  constructor(status: string) {
    super('APPROVAL_NOT_PENDING', 409, 'That request has already been decided', `It is ${status}.`);
  }
}

export class ApprovalNotFound extends DomainError {
  constructor() {
    super('APPROVAL_NOT_FOUND', 404, 'Approval request not found');
  }
}
