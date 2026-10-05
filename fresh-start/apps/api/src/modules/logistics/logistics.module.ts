import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial';
import { CommunicationModule } from '../communication';
import { IamModule } from '../iam';
import { OrdersModule } from '../orders';
import { QualityModule } from '../quality';
import { CustomerDeliveries } from './application/customer-deliveries';
import { CustomerDispatchCommand } from './application/customer-dispatch.command';
import { DispatchCommand } from './application/dispatch.command';
import { LogisticsView } from './application/logistics-view';
import { MaterialCommand } from './application/material.command';
import { ReceivingCommand } from './application/receiving.command';
import { CarrierPort, DevCarrier } from './infrastructure/carrier.port';
import { LogisticsRepository } from './infrastructure/logistics.repository';
import { CustomerDeliveriesController, CustomerDispatchController } from './presentation/customer-dispatch.controller';
import { CarrierWebhookController, DiscrepancyController, LogisticsViewController, ShipmentController, SupplierShipmentController } from './presentation/logistics.controller';

/**
 * Logistics (IN-16, IN-17): both legs, receiving and the custody ledger. It reads orders, finance's
 * payment facts and quality release facts, borrows communication's identity screen and the approval
 * rail, and owns its own records.
 */
@Module({
  imports: [IamModule, OrdersModule, QualityModule, CommercialModule, CommunicationModule],
  controllers: [SupplierShipmentController, ShipmentController, DiscrepancyController, LogisticsViewController, CarrierWebhookController, CustomerDispatchController, CustomerDeliveriesController],
  providers: [LogisticsRepository, DispatchCommand, ReceivingCommand, MaterialCommand, LogisticsView, CustomerDeliveries, CustomerDispatchCommand, { provide: CarrierPort, useClass: DevCarrier }],
})
export class LogisticsModule {}
