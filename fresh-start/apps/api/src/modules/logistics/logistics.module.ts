import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { OrdersModule } from '../orders';
import { QualityModule } from '../quality';
import { DispatchCommand } from './application/dispatch.command';
import { CarrierPort, DevCarrier } from './infrastructure/carrier.port';
import { LogisticsRepository } from './infrastructure/logistics.repository';
import { CarrierWebhookController, ShipmentController, SupplierShipmentController } from './presentation/logistics.controller';

/** Logistics leg 1, receiving and the custody ledger (IN-16): it reads orders and quality release facts, and owns its own records. */
@Module({
  imports: [IamModule, OrdersModule, QualityModule],
  controllers: [SupplierShipmentController, ShipmentController, CarrierWebhookController],
  providers: [LogisticsRepository, DispatchCommand, { provide: CarrierPort, useClass: DevCarrier }],
})
export class LogisticsModule {}
