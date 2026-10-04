import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError } from '../../../platform/http/domain-error';

export interface ApprovalEffectInput {
  requestId: string;
  subjectId: string;
  context: Record<string, unknown>;
  decision: 'approved' | 'rejected' | 'returned';
  decidedBy: string;
}

/** What an approval decision does to its subject, run inside the decision's transaction. */
export type ApprovalEffect = (input: ApprovalEffectInput, tx: PoolClient) => Promise<Record<string, unknown>>;

/**
 * The approval rail is one command for every kind (doc 03 §5); the *effects* belong to the
 * module that owns the subject. Kinds the commercial module owns are applied inline; a
 * later module (finance's cash allocation, IN-08) registers its effect here at start-up,
 * so the decision command never has to import the module that depends on it.
 */
@Injectable()
export class ApprovalEffectRegistry {
  private readonly effects = new Map<string, ApprovalEffect>();

  register(kind: string, effect: ApprovalEffect): void {
    this.effects.set(kind, effect);
  }

  async apply(kind: string, input: ApprovalEffectInput, tx: PoolClient): Promise<Record<string, unknown>> {
    const effect = this.effects.get(kind);
    if (!effect) {
      throw new DomainError('APPROVAL_EFFECT_MISSING', 500, 'No module handles this approval kind', `Nothing is registered to apply a ${kind} decision.`);
    }
    return effect(input, tx);
  }
}
