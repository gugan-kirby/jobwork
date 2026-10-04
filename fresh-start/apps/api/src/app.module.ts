import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { OperationsModule } from './modules/operations/operations.module';
import { DmsModule } from './modules/dms';
import { IamModule } from './modules/iam';
import { SourcingModule } from './modules/sourcing';
import { CommercialModule } from './modules/commercial';
import { CommunicationModule } from './modules/communication';
import { OrdersModule } from './modules/orders';
import { ChangeModule } from './modules/change';
import { SupplierModule } from './modules/supplier';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [
    PlatformModule,
    IamModule,
    DmsModule,
    SupplierModule,
    SourcingModule,
    CommercialModule,
    OrdersModule,
    ChangeModule,
    CommunicationModule,
    OperationsModule,
    HealthModule,
  ],
})
export class AppModule {}
