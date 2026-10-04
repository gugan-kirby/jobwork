// Public surface of the document module (ES-03). Other modules import from here only.
export { DmsModule } from './dms.module';
export { ObjectStore, ObjectStoreUnavailable, type StoreBucket } from './infrastructure/object-store';
export { DmsRepository } from './infrastructure/dms.repository';
export { assertUploadAllowed } from './domain/upload-policy';
