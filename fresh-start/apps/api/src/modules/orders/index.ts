// Public surface of the orders module (ES-03). Other modules import from here only.
export { OrdersModule } from './orders.module';
export { OrdersRepository, type SalesOrderRecord } from './infrastructure/orders.repository';
export { FinanceRepository } from './infrastructure/finance.repository';
export { DispatchFinance, type DispatchPaymentFacts } from './application/dispatch-finance';
export { ProductionRepository, type BaselineRecord } from './infrastructure/production.repository';
export { baselineHash, governingConflicts } from './domain/production';
export { OrderClosure } from './application/order-closure';
export { SettlementRepository } from './infrastructure/settlement.repository';
