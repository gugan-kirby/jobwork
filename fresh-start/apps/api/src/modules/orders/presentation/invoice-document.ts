import type { InvoiceRecord } from '../infrastructure/finance.repository';

/**
 * The invoice document (FR-804): rendered deterministically from the frozen invoice
 * columns, its content hash printed on it. Issued by JobWork to the customer; nothing of
 * the buy side is in the inputs, so nothing of it can be in the output. Statutory fields
 * (GSTIN, HSN/SAC, place of supply, e-invoice IRN) arrive with the tax-provider decision
 * and finance review (doc 10 §8) — the document says so instead of inventing them.
 */

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function money(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = String(Math.floor(abs / 100));
  const head = major.slice(0, -3);
  const tail = major.slice(-3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `${sign}${currency === 'INR' ? '₹' : `${currency} `}${grouped}.${String(abs % 100).padStart(2, '0')}`;
}

export function renderInvoiceDocument(invoice: InvoiceRecord): string {
  const rows = invoice.lines
    .map(
      (l) =>
        `<tr><td>${l.lineNo}</td><td>${escape(l.description)}</td><td class="n">${l.quantity} ${escape(l.unit)}</td><td class="n">${money(l.amountMinor, invoice.currency)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${escape(invoice.number)}</title>
<style>
body{font:0.875rem/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:rgb(21,26,45);margin:2.5rem;max-width:50rem}
h1{font-size:1.375rem;margin:0 0 0.25rem}.muted{color:rgb(102,112,133)}table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{padding:0.5rem;border-bottom:thin solid rgb(225,230,238);text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}
.total td{font-weight:600}.box{border:thin solid rgb(225,230,238);border-radius:0.5rem;padding:0.75rem;margin:0.75rem 0}.mono{font-family:ui-monospace,Menlo,monospace;font-size:0.75rem;word-break:break-all}
</style></head><body>
<h1>JobWork — Tax invoice ${escape(invoice.number)}</h1>
<p class="muted">${escape(invoice.kind)} invoice · issued ${invoice.issuedAt.toISOString().slice(0, 10)} · due ${invoice.dueAt.toISOString().slice(0, 10)}</p>
<p>Bill to: <strong>${escape(invoice.customerDisplayName)}</strong><br>Against order ${escape(invoice.salesOrderNumber)} — ${escape(invoice.salesOrderTitle)}</p>
<table><thead><tr><th>#</th><th>Description</th><th class="n">Quantity</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot>
<tr><td colspan="3" class="n">Taxable value</td><td class="n">${money(invoice.subtotalMinor, invoice.currency)}</td></tr>
<tr><td colspan="3" class="n">GST (${(invoice.taxRateBp / 100).toFixed(2)} %)</td><td class="n">${money(invoice.taxMinor, invoice.currency)}</td></tr>
<tr class="total"><td colspan="3" class="n">Total</td><td class="n">${money(invoice.totalMinor, invoice.currency)}</td></tr>
<tr><td colspan="3" class="n">Received</td><td class="n">${money(invoice.paidMinor, invoice.currency)}</td></tr>
</tfoot></table>
<div class="box">Pay through the JobWork portal, or by bank transfer quoting <strong>${escape(invoice.number)}</strong>. Payments are made to JobWork only — never to a workshop.</div>
<p class="muted">Statutory particulars (GSTIN, HSN/SAC, place of supply, e-invoice reference) are confirmed by JobWork finance before dispatch.</p>
<p class="muted">Content hash: <span class="mono">${escape(invoice.contentHash)}</span></p>
</body></html>`;
}
