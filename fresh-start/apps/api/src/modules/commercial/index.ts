// Public surface of the commercial module (ES-03). Other modules import from here only.
export { CommercialModule } from './commercial.module';
export { CommercialRepository } from './infrastructure/commercial.repository';
export { CommercialView } from './application/commercial-view';
export { ApprovalEffectRegistry, type ApprovalEffect, type ApprovalEffectInput } from './application/approval-effects';
export { PolicyRulesInvalid } from './domain/approval-policy';
export { BALANCE_TRIGGER_WORDS } from './presentation/quote-document';
export { QuoteNotActionable, QuoteNotFound, assertQuoteVersion, isExpired } from './domain/quote';
export { applyBasisPoints } from './domain/money';
export type { QuoteRecord, QuoteVersionRecord } from './infrastructure/commercial.repository';
