import { Injectable } from '@nestjs/common';
import type { WorkPackageLogistics } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { QualityReleaseCommand, Rational } from '../../quality';
import { DomainError } from '../../../platform/http/domain-error';
import { LogisticsRepository } from '../infrastructure/logistics.repository';
import { requireLogisticsReader } from './access';

const show = (s: string): string => Rational.parse(s).toDisplay(4);

/**
 * One work package's quantities end to end, and its stock lots by location (IN-16 F-16.3;
 * doc 19 §8 "remaining commitment visible"). JobWork only: the custody ledger is never shown
 * to a supplier or a customer.
 */
@Injectable()
export class LogisticsView {
  constructor(
    private readonly repo: LogisticsRepository,
    private readonly quality: QualityReleaseCommand,
  ) {}

  async workPackage(actor: Actor, workPackageId: string): Promise<WorkPackageLogistics> {
    requireLogisticsReader(actor);
    const wp = await this.repo.workPackage(workPackageId);
    if (!wp) throw new DomainError('WORK_PACKAGE_NOT_FOUND', 404, 'Work package not found');
    const facts = await this.quality.factsFor(workPackageId);
    const quantities = await this.repo.workPackageQuantities(workPackageId);
    const outstanding = Rational.parse(quantities.ordered).sub(Rational.parse(quantities.accepted));
    return {
      workPackageId,
      workPackageNumber: wp.number,
      ordered: show(quantities.ordered),
      released: show(facts.releasedQuantity),
      shipped: show(quantities.shipped),
      received: show(quantities.received),
      accepted: show(quantities.accepted),
      quarantined: show(quantities.quarantined),
      scrapped: show(quantities.scrapped),
      returned: show(quantities.returned),
      outstanding: outstanding.compare(Rational.of(0)) > 0 ? outstanding.toDisplay(4) : '0',
      lots: (await this.repo.lotsForWorkPackage(workPackageId)).map((l) => ({
        lotId: l.id,
        lotCode: l.lotCode,
        sourceShipmentNumber: l.shipmentNumber,
        receivedQuantity: show(l.receivedQuantity),
        ownership: l.ownership,
        balances: l.balances.map((b) => ({ locationCode: b.code, label: b.label, onHand: b.onHand, quantity: show(b.quantity) })),
      })),
    };
  }
}
