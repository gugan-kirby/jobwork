import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { BeginScanCommand } from './application/begin-scan.command';
import { FinalizeUploadCommand } from './application/finalize-upload.command';
import { GrantAudienceCommand } from './application/grant-audience.command';
import { InitiateUploadCommand } from './application/initiate-upload.command';
import { RecordScanResultCommand } from './application/record-scan-result.command';
import { RevokeGrantCommand } from './application/revoke-grant.command';
import { SupplierCopyCommand } from './application/supplier-copy.command';
import { DmsRepository } from './infrastructure/dms.repository';
import { ObjectStore } from './infrastructure/object-store';
import { DocumentsController } from './presentation/documents.controller';
import { DownloadController } from './presentation/download.controller';
import { InternalScanController } from './presentation/internal-scan.controller';
import { SupplierCopyController } from './presentation/supplier-copy.controller';
import { DocumentRevisionHooks } from './application/document-revision-hooks';

@Module({
  imports: [IamModule],
  controllers: [DocumentsController, DownloadController, InternalScanController, SupplierCopyController],
  providers: [
    DocumentRevisionHooks,
    DmsRepository,
    ObjectStore,
    InitiateUploadCommand,
    FinalizeUploadCommand,
    BeginScanCommand,
    RecordScanResultCommand,
    GrantAudienceCommand,
    RevokeGrantCommand,
    SupplierCopyCommand,
  ],
  exports: [DmsRepository, ObjectStore, DocumentRevisionHooks],
})
export class DmsModule {}
