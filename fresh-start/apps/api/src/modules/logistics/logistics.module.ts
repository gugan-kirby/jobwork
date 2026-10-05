import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { OrdersModule } from '../orders';
import { QualityModule } from '../quality';
import { DispatchCommand } from './application/dispatch.command';
import { LogisticsView } from './application/logistics-view';
import { MaterialCommand } from './application/material.command';
import { ReceivingCommand } from './application/receiving.command';
import { CarrierPort, DevCarrier } from './infrastructure/carrier.port';
import { LogisticsRepository } from './infrastructure/logistics.repository';
import { CarrierWebhookController, DiscrepancyController, LogisticsViewController, ShipmentController, SupplierShipmentController } from './presentation/logistics.controller';

/** Logistics leg 1, receiving and the custody ledger (IN-16): it reads orders and quality release facts, and owns its own records. */
@Module({
  imports: [IamModule, OrdersModule, QualityModule],
  controllers: [SupplierShipmentController, ShipmentController, DiscrepancyController, LogisticsViewController, CarrierWebhookController],
  providers: [LogisticsRepository, DispatchCommand, ReceivingCommand, MaterialCommand, LogisticsView, { provide: CarrierPort, useClass: DevCarrier }],
})
export class LogisticsModule {}
