import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { AdmitSupplierCommand } from './application/admit-supplier.command';
import { DeclareCertificationCommand } from './application/declare-certification.command';
import { ExpireVerificationsCommand } from './application/expire-verifications.command';
import { ExitNetworkCommand } from './application/exit-network.command';
import { OnboardingDecisionCommand } from './application/onboarding-decision.command';
import { SetAvailabilityCommand } from './application/set-availability.command';
import { WithdrawDeclarationCommand } from './application/withdraw-declaration.command';
import { SupplierView } from './application/supplier-view';
import { UpdateSupplierProfileCommand } from './application/update-profile.command';
import { ReviewVerificationCommand } from './application/review-verification.command';
import { RevokeVerificationCommand } from './application/revoke-verification.command';
import { PublishCapabilityCommand } from './application/publish-capability.command';
import { SubmitVerificationCommand } from './application/submit-verification.command';
import { EligibilityProjection } from './infrastructure/eligibility.projection';
import { SupplierRepository } from './infrastructure/supplier.repository';
import { CapabilitiesController } from './presentation/capabilities.controller';
import { SupplierProfileController } from './presentation/profile.controller';
import { SuppliersController } from './presentation/suppliers.controller';
import { CapabilityCardsController } from './presentation/capability-cards.controller';
import { PublicCategoriesController } from './presentation/public-categories.controller';
import { NetworkApplicationCommand } from './application/network-application.command';
import { ApplicationsController, PublicApplicationsController } from './presentation/applications.controller';
import { NetworkApplicationRepository } from './infrastructure/supplier.repository';
import { InternalVerificationController } from './presentation/internal-verification.controller';
import { VerificationController } from './presentation/verification.controller';

@Module({
  imports: [IamModule],
  controllers: [
    // Static paths first: `/suppliers/me/...` must never be read as a profile id.
    SupplierProfileController,
    VerificationController,
    CapabilitiesController,
    CapabilityCardsController,
    PublicCategoriesController,
    PublicApplicationsController,
    ApplicationsController,
    InternalVerificationController,
    SuppliersController,
  ],
  providers: [
    SupplierRepository,
    NetworkApplicationRepository,
    NetworkApplicationCommand,
    AdmitSupplierCommand,
    UpdateSupplierProfileCommand,
    OnboardingDecisionCommand,
    SetAvailabilityCommand,
    WithdrawDeclarationCommand,
    ExitNetworkCommand,
    DeclareCertificationCommand,
    SupplierView,
    SubmitVerificationCommand,
    ReviewVerificationCommand,
    RevokeVerificationCommand,
    ExpireVerificationsCommand,
    PublishCapabilityCommand,
    EligibilityProjection,
  ],
  exports: [SupplierRepository, EligibilityProjection, SupplierView],
})
export class SupplierModule {}
