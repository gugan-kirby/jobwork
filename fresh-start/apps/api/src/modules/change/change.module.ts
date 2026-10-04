import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial';
import { DmsModule } from '../dms';
import { IamModule } from '../iam';
import { OrdersModule } from '../orders';
import { ChangeCommand } from './application/change.command';
import { ChangeRepository } from './infrastructure/change.repository';
import { ChangeController, CustomerChangeController, SupplierChangeController } from './presentation/change.controller';

/** Engineering change control (IN-13): it reads production, commercial and DMS records, and owns only its own. */
@Module({
  imports: [IamModule, CommercialModule, DmsModule, OrdersModule],
  controllers: [ChangeController, CustomerChangeController, SupplierChangeController],
  providers: [ChangeRepository, ChangeCommand],
})
export class ChangeModule {}
