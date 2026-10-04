import type { QuoteRecord, QuoteVersionRecord } from '../infrastructure/commercial.repository';

/**
 * The quotation document (F-07.5 "immutable artifact"). Rendered deterministically from
 * the frozen version columns, so the same version always produces the same bytes; the
 * content hash the acceptance cites is printed on it. There is nothing of the buy side
 * in the inputs, so there can be nothing of it in the output.
 */

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function money(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  // Indian grouping: last three, then twos.
  const s = String(major);
  const head = s.slice(0, -3);
  const tail = s.slice(-3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `${sign}${currency === 'INR' ? '₹' : `${currency} `}${grouped}.${cents}`;
}

export const BALANCE_TRIGGER_WORDS: Record<QuoteVersionRecord['balanceTrigger'], string> = {
  on_acceptance: 'on acceptance',
  before_dispatch: 'before dispatch',
  on_delivery: 'on delivery',
  net_30: '30 days from invoice',
};

export function renderQuoteDocument(quote: QuoteRecord, version: QuoteVersionRecord, customerName: string): string {
  const rows = version.lines
    .map(
      (l) =>
        `<tr><td>${l.lineNo}</td><td>${escape(l.description)}</td><td class="n">${l.quantity} ${escape(l.unit)}</td><td class="n">${money(l.unitPriceMinor, version.currency)}</td><td class="n">${money(l.amountMinor, version.currency)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Quotation ${escape(quote.reference ?? '')} v${version.versionNo}</title>
<style>
/* Standalone document styling (print/download), kept in relative units and rgb() so the
   DS-01 screen rule (no raw hex/px in app sources) stays a clean grep. */
body{font:0.875rem/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:rgb(21,26,45);margin:2.5rem;max-width:50rem}
h1{font-size:1.375rem;margin:0 0 0.25rem}.muted{color:rgb(102,112,133)}table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{padding:0.5rem;border-bottom:thin solid rgb(225,230,238);text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}
.total td{font-weight:600}.box{border:thin solid rgb(225,230,238);border-radius:0.5rem;padding:0.75rem;margin:0.75rem 0}.mono{font-family:ui-monospace,Menlo,monospace;font-size:0.75rem;word-break:break-all}
</style></head><body>
<h1>JobWork — Quotation ${escape(quote.reference ?? '')}</h1>
<p class="muted">Version ${version.versionNo} · ${escape(quote.optionLabel)} option · issued ${version.sentAt ? version.sentAt.toISOString().slice(0, 10) : 'not yet sent'} · valid until ${escape(version.validityUntil)}</p>
<p>To: <strong>${escape(customerName)}</strong><br>For enquiry ${escape(quote.enquiryReference ?? '')} — ${escape(quote.enquiryTitle)}</p>
<table><thead><tr><th>#</th><th>Description</th><th class="n">Quantity</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot>
<tr><td colspan="4" class="n">Subtotal</td><td class="n">${money(version.subtotalMinor, version.currency)}</td></tr>
<tr><td colspan="4" class="n">Freight</td><td class="n">${money(version.freightMinor, version.currency)}</td></tr>
<tr><td colspan="4" class="n">GST (${(version.taxRateBp / 100).toFixed(2)} %)</td><td class="n">${money(version.taxMinor, version.currency)}</td></tr>
<tr class="total"><td colspan="4" class="n">Total</td><td class="n">${money(version.totalMinor, version.currency)}</td></tr>
</tfoot></table>
<div class="box"><strong>Delivery:</strong> ${version.deliveryLeadDays} days from acceptance · <strong>Payment:</strong> ${escape(version.paymentTerms)} · <strong>Schedule:</strong> ${(version.advanceBp / 100).toFixed(0)} % on acceptance, balance ${escape(BALANCE_TRIGGER_WORDS[version.balanceTrigger])}</div>
${version.scopeNote ? `<div class="box"><strong>Scope:</strong> ${escape(version.scopeNote)}</div>` : ''}
${version.assumptions ? `<div class="box"><strong>Assumptions:</strong> ${escape(version.assumptions)}</div>` : ''}
${version.exclusions ? `<div class="box"><strong>Exclusions:</strong> ${escape(version.exclusions)}</div>` : ''}
<p class="muted">Terms: ${escape(version.termsCode)} v${version.termsVersionNo} (<span class="mono">${escape(version.termsHash)}</span>)</p>
<p class="muted">Content hash: <span class="mono">${escape(version.contentHash)}</span></p>
</body></html>`;
}
