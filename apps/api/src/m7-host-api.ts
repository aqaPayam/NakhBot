import { Module, type DynamicModule } from '@nestjs/common';
import { M7ReportApiModule } from './m7-report-api.js';
import { M7AdminReportApiModule } from './m7-admin-report-api.js';
import { M7AdminModerationApiModule } from './m7-admin-moderation-api.js';
import { M7SupportApiModule } from './m7-support-api.js';
import { M7AppealApiModule } from './m7-appeal-api.js';
import { M7OperationalHealthApiModule } from './m7-operational-health-api.js';
import type { M7HostApiOptions } from './m7-host-services.js';
import { M7TotpApiModule } from './m7-totp-api.js';
import { M8AccountReturnApprovalApiModule } from './m8-account-return-approval-api.js';
/** Explicit opt-in; ordinary startup registers this host only when administration is enabled. */
@Module({})
export class M7HostApiModule {
  public static register(options: M7HostApiOptions): DynamicModule {
    return {
      module: M7HostApiModule,
      imports: [
        ...(options.totp === undefined ? [] : [M7TotpApiModule.register(options.totp)]),
        ...(options.accountReturnApproval === undefined
          ? []
          : [M8AccountReturnApprovalApiModule.register(options.accountReturnApproval)]),
        M7ReportApiModule.register(options.reports),
        M7AdminReportApiModule.register(options.adminReports),
        M7AdminModerationApiModule.register(options.adminModeration),
        M7SupportApiModule.register(options.support),
        M7AppealApiModule.register(options.appeals),
        M7OperationalHealthApiModule.register(options.operationalHealth),
      ],
    };
  }
}
