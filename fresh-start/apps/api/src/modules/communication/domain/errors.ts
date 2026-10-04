import type { LeakageFinding } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';

export class ConversationContextNotFound extends DomainError {
  constructor() {
    // The same answer whether the record does not exist or the reader may not see it (doc 03 §7).
    super('CONVERSATION_NOT_FOUND', 404, 'Conversation not found');
  }
}

export class AudienceNotAllowed extends DomainError {
  constructor(detail: string) {
    super('AUDIENCE_NOT_ALLOWED', 403, 'You cannot write to that audience here', detail);
  }
}

export class ConversationClosed extends DomainError {
  constructor() {
    super('CONVERSATION_CLOSED', 409, 'This conversation is closed', 'The record it belongs to no longer takes messages.');
  }
}

export class LeakageReviewNotFound extends DomainError {
  constructor() {
    super('LEAKAGE_REVIEW_NOT_FOUND', 404, 'Review not found');
  }
}

export class ReviewAlreadyDecided extends DomainError {
  constructor() {
    super('REVIEW_ALREADY_DECIDED', 409, 'This message has already been reviewed');
  }
}

export class SelfReview extends DomainError {
  constructor() {
    super('SELF_REVIEW', 403, 'You wrote this message', 'Another reviewer must decide on it.');
  }
}

export class RedactionStillFlagged extends DomainError {
  constructor(findings: LeakageFinding[]) {
    super(
      'REDACTION_STILL_FLAGGED',
      422,
      'The redacted text still names a party or carries contact details',
      findings.map((f) => `${f.label}: "${f.text}"`).join('; '),
      findings.map((f) => ({ path: 'redactedBody', message: `${f.label}: "${f.text}"` })),
    );
  }
}

export class MessageNotShareable extends DomainError {
  constructor(detail: string) {
    super('MESSAGE_NOT_SHAREABLE', 409, 'This message cannot be shared with every supplier', detail);
  }
}
