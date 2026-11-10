import { Module } from '@nestjs/common';
import { APP_GUARD } from '../../runtime/container';
import { AccountService } from './application/account.service';
import { AuthService } from './application/auth.service';
import { InvitationService } from './application/invitation.service';
import { OrganizationService } from './application/organization.service';
import { RegistrationService } from './application/registration.service';
import { SiteService } from './application/site.service';
import { Argon2Hasher } from './infrastructure/argon2-hasher';
import { IamRepository } from './infrastructure/iam.repository';
import { PASSWORD_HASHER, type PasswordHasher } from './infrastructure/password-hasher';
import { PgcryptoHasher } from './infrastructure/pgcrypto-hasher';
import { AccountController } from './presentation/account.controller';
import { AdminController } from './presentation/admin.controller';
import { AuthController } from './presentation/auth.controller';
import { CsrfGuard } from './presentation/csrf.guard';
import { InvitationController } from './presentation/invitation.controller';
import { SessionGuard } from './presentation/session.guard';
import { SitesController } from './presentation/sites.controller';
import { ConfigService } from '../../platform/config/config.service';
import { DatabaseService } from '../../platform/database/database.service';

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
    {
      provide: PASSWORD_HASHER,
      useFactory: (config: ConfigService, db: DatabaseService): PasswordHasher =>
        config.env.PASSWORD_HASHER === 'pgcrypto-bcrypt' ? new PgcryptoHasher(db) : new Argon2Hasher(),
      inject: [ConfigService, DatabaseService],
    },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [IamRepository, AuthService, InvitationService, AccountService],
})
export class IamModule {}
