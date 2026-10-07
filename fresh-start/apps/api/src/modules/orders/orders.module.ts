import { Module } from '@nestjs/common';
import { CommercialModule } from '../commercial';
import { IamModule } from '../iam';
import { AcceptQuoteCommand } from './application/accept-quote.command';
import { DispatchFinance } from './application/dispatch-finance';
import { OrderClosure } from './application/order-closure';
import { SettlementCommand } from './application/settlement.command';
import { SettlementRepository } from './infrastructure/settlement.repository';
import { FinanceBillsController, SupplierBillsController } from './presentation/settlement.controller';
import { MoneyFlow } from './application/money-flow';
import { OrderCommand } from './application/order.command';
import { OrdersView } from './application/orders-view';
import { PaymentCommand } from './application/payment.command';
import { ProductionCommand } from './application/production.command';
import { ProductionRepository } from './infrastructure/production.repository';
import { ProductionController, SupplierProductionController } from './presentation/production.controller';
import { FinanceRepository } from './infrastructure/finance.repository';
import { DevGateway, PaymentGateway } from './infrastructure/gateway';
import { OrdersRepository } from './infrastructure/orders.repository';
import {
  AcceptQuoteController,
  CustomerInvoicesController,
  CustomerOrdersController,
  CustomerPaymentsController,
} from './presentation/customer.controller';
import {
  FinanceController,
  InternalPaymentsController,
  PaymentWebhookController,
  SalesOrdersController,
  SupplierPurchaseOrdersController,
} from './presentation/internal.controller';

/**
 * Acceptance, orders, purchase orders and the payment boundary (IN-08). Depends on the
 * commercial module for the quote it accepts and the approval rail it reuses; nothing in
 * commercial depends on it (the allocation effect is registered into commercial's
 * registry at start-up).
 */
@Module({
  imports: [IamModule, CommercialModule],
  controllers: [
    AcceptQuoteController,
    CustomerOrdersController,
    CustomerInvoicesController,
    CustomerPaymentsController,
    SalesOrdersController,
    FinanceController,
    SupplierPurchaseOrdersController,
    PaymentWebhookController,
    InternalPaymentsController,
    ProductionController,
    SupplierProductionController,
    SupplierBillsController,
    FinanceBillsController,
  ],
  providers: [
    OrdersRepository,
    FinanceRepository,
    MoneyFlow,
    DispatchFinance,
    SettlementRepository,
    SettlementCommand,
    OrderClosure,
    OrdersView,
    AcceptQuoteCommand,
    OrderCommand,
    PaymentCommand,
    ProductionRepository,
    ProductionCommand,
    DevGateway,
    // `T-03`: the provider is chosen by configuration; `dev` is the only adapter until the decision lands.
    { provide: PaymentGateway, useExisting: DevGateway },
  ],
  exports: [OrdersRepository, FinanceRepository, ProductionRepository, DispatchFinance, OrderClosure, SettlementRepository],
})
export class OrdersModule {}
