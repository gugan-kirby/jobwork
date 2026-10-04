// Public surface of the sourcing module (ES-03). Other modules import from here only.
export { SourcingModule } from './sourcing.module';
export { EnquiryRepository } from './infrastructure/enquiry.repository';
export { RfqRepository } from './infrastructure/rfq.repository';
export { projectForCustomer, projectClarifications } from './presentation/enquiry-projection';
export { evaluateCompleteness } from './domain/completeness';
