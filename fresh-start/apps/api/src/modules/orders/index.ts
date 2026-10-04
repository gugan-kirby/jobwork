// Public surface of the orders module (ES-03). Other modules import from here only.
export { OrdersModule } from './orders.module';
export { OrdersRepository } from './infrastructure/orders.repository';
export { FinanceRepository } from './infrastructure/finance.repository';
export { ProductionRepository, type BaselineRecord } from './infrastructure/production.repository';
export { baselineHash, governingConflicts } from './domain/production';
