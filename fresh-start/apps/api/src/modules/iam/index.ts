// Public surface of the IAM module (ES-03). Other modules import from here only.
export { IamModule } from './iam.module';
export { IamRepository } from './infrastructure/iam.repository';
export type { Actor } from './application/actor';
export {
  requireOrganization,
  requireRole,
  requireTransactionalStrength,
} from './application/actor';
