// Public surface of the supplier module (ES-03). Other modules import from here only.
export { SupplierModule } from './supplier.module';
export { SupplierRepository } from './infrastructure/supplier.repository';
export {
  EligibilityProjection,
  type EligibilityQuery,
  type EligibilityRecord,
} from './infrastructure/eligibility.projection';
export {
  computeExclusions,
  EXCLUSION_CODES,
  MANDATORY_KINDS,
  type ExclusionCode,
  type VerificationKind,
  type VerificationStatus,
} from './domain/verification';
