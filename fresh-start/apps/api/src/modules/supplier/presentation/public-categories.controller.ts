import { Controller, Get } from '@nestjs/common';
import { Public } from '../../../platform/http/public.decorator';
import { SupplierRepository } from '../infrastructure/supplier.repository';

/**
 * `GET /public/categories` (F-MX.3, `D-17`): what a guest may learn before signing in —
 * the process families JobWork sources and the processes under each. Labels and codes
 * only. No ids that lead anywhere, no counts, no availability, nothing about who does
 * the work: guest browsing is category education, not supplier discovery (doc 14 §4,
 * `UC-01`).
 */

export interface PublicCategory {
  code: string;
  label: string;
  processes: Array<{ code: string; label: string }>;
}

@Controller('public')
export class PublicCategoriesController {
  constructor(private readonly repo: SupplierRepository) {}

  @Public()
  @Get('categories')
  async categories(): Promise<{ families: PublicCategory[] }> {
    const rows = await this.repo.listTaxonomy();
    const families = rows
      .filter((row) => row.kind === 'process' && row.isFamily)
      .map((family) => ({
        code: family.code,
        label: family.label,
        processes: rows
          .filter((row) => row.kind === 'process' && !row.isFamily && row.parentId === family.id)
          .map((row) => ({ code: row.code, label: row.label })),
      }))
      .filter((family) => family.processes.length > 0);
    return { families };
  }
}
