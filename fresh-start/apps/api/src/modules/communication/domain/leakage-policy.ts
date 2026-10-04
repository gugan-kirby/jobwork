import type { ExternalAudience, LeakageAction, LeakageFinding, MessageParty } from '@jobwork/contracts';

/**
 * Stage 6 of doc 07 §12: what a set of findings means for one message.
 *
 * The question is who will read it. A customer or supplier writing to JobWork reaches
 * only JobWork — nobody in that thread is shielded from anything, so findings are noted
 * for reviewers and the message goes through. When JobWork writes outward, or anything is
 * shared to every invited supplier, the reader is a party the platform shields: a named
 * party or a hard contact detail waits for a person. Numbers that only look like phones
 * never stop a message (doc 07 §12: engineering text is full of them).
 *
 * Blocking is not automatic in v1: a reviewer's rejection is the block (`FR-1002`).
 */
export function decideAction(input: {
  audience: ExternalAudience;
  authorParty: MessageParty;
  findings: ReadonlyArray<LeakageFinding>;
}): LeakageAction {
  if (input.findings.length === 0) return 'allow';
  const reachesShieldedParty = input.authorParty === 'internal' || input.audience === 'shared_technical';
  const serious = input.findings.some((f) => f.kind === 'party_identity' || f.confidence === 'high');
  return reachesShieldedParty && serious ? 'quarantine' : 'warn';
}

/**
 * What a composer may show its author. Telling a customer "this names a supplier" would
 * tell them who JobWork's suppliers are, so registry matches are shown to JobWork only.
 */
export function findingsForAuthor(
  findings: ReadonlyArray<LeakageFinding>,
  authorParty: MessageParty,
): LeakageFinding[] {
  return authorParty === 'internal' ? [...findings] : findings.filter((f) => f.kind !== 'party_identity');
}
