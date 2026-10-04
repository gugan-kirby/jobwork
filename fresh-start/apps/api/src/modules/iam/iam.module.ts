import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountService } from './application/account.service';
import { AuthService } from './application/auth.service';
import { InvitationService } from './application/invitation.service';
import { OrganizationService } from './application/organization.service';
import { RegistrationService } from './application/registration.service';
import { SiteService } from './application/site.service';
import { IamRepository } from './infrastructure/iam.repository';
import { AccountController } from './presentation/account.controller';
import { AdminController } from './presentation/admin.controller';
import { AuthController } from './presentation/auth.controller';
import { CsrfGuard } from './presentation/csrf.guard';
import { InvitationController } from './presentation/invitation.controller';
import { SessionGuard } from './presentation/session.guard';
import { SitesController } from './presentation/sites.controller';

@Module({
  controllers: [
    AuthController,
    InvitationController,
    AccountController,
    // Static-path controller before the parameterised admin routes.
    SitesController,
    AdminController,
  ],
  providers: [
    IamRepository,
    AuthService,
    InvitationService,
    AccountService,
    OrganizationService,
    RegistrationService,
    SiteService,
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [IamRepository, AuthService, InvitationService, AccountService],
})
export class IamModule {}
