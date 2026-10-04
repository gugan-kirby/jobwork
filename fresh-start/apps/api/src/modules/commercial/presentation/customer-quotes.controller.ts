import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  customerQuoteDecisionRequestSchema,
  type CustomerQuote,
  type CustomerQuoteListItem,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireRole } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { QuoteCommand } from '../application/quote.command';
import { QuoteNotFound } from '../domain/quote';
import { CommercialRepository, type QuoteRecord } from '../infrastructure/commercial.repository';
import { projectCustomerQuote, projectCustomerQuoteListItem, visibleVersion } from './customer-quote.projection';
import { renderQuoteDocument } from './quote-document';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * The customer's quotations (`FR-406`, F-07.6, prototype tiles 9–10 corrected). Every
 * read returns the customer projection and nothing else; a quotation that was never sent
 * does not exist from here, and neither does anyone else's.
 */
@Controller('quotations')
export class CustomerQuotesController {
  constructor(
    private readonly quotes: QuoteCommand,
    private readonly repo: CommercialRepository,
  ) {}

  private requireCustomer(actor: Actor): string {
    if (actor.organizationType !== 'customer') throw new NotAuthorized('Customer organizations only');
    requireRole(actor, 'customer_requester', 'customer_approver');
    return requireOrganization(actor);
  }

  private async owned(actor: Actor, quotationId: string): Promise<QuoteRecord> {
    const organizationId = this.requireCustomer(actor);
    const quote = await this.repo.findQuote(quotationId);
    if (!quote || quote.customerOrganizationId !== organizationId || quote.reference === null || !visibleVersion(quote)) {
      throw new QuoteNotFound();
    }
    return quote;
  }

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ quotations: CustomerQuoteListItem[] }> {
    const organizationId = this.requireCustomer(actor);
    const rows = await this.repo.listQuotesForCustomer(organizationId);
    return {
      quotations: rows
        .map((row) => projectCustomerQuoteListItem(row))
        .filter((item): item is CustomerQuoteListItem => item !== null),
    };
  }

  @Get(':quotationId')
  async get(@CurrentActor() actor: Actor, @Param('quotationId') quotationId: string): Promise<CustomerQuote> {
    const quote = await this.owned(actor, quotationId);
    const siblings = await this.repo.listSiblings(quote.offerSetId);
    const projected = projectCustomerQuote(quote, siblings);
    if (!projected) throw new QuoteNotFound();
    return projected;
  }

  @Get(':quotationId/document')
  async document(@CurrentActor() actor: Actor, @Param('quotationId') quotationId: string): Promise<{ html: string; contentHash: string }> {
    const quote = await this.owned(actor, quotationId);
    const version = visibleVersion(quote)!;
    return { html: renderQuoteDocument(quote, version, quote.customerDisplayName), contentHash: version.contentHash };
  }

  @Post(':quotationId/request-revision')
  async requestRevision(
    @CurrentActor() actor: Actor,
    @Param('quotationId') quotationId: string,
    @Req() request: FastifyRequest,
  ): Promise<CustomerQuote> {
    const body = parseBody(customerQuoteDecisionRequestSchema, request.body);
    await this.quotes.requestRevision(actor, quotationId, body, { idempotencyKey: idempotencyKey(request) });
    return this.get(actor, quotationId);
  }

  @Post(':quotationId/reject')
  async reject(
    @CurrentActor() actor: Actor,
    @Param('quotationId') quotationId: string,
    @Req() request: FastifyRequest,
  ): Promise<CustomerQuote> {
    const body = parseBody(customerQuoteDecisionRequestSchema, request.body);
    await this.quotes.reject(actor, quotationId, body, { idempotencyKey: idempotencyKey(request) });
    return this.get(actor, quotationId);
  }
}
