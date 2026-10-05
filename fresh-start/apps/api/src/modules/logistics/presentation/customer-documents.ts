import { createHash } from 'node:crypto';
import type { CustomerDelivery, SiteSnapshot } from '@jobwork/contracts';

/**
 * Customer-facing logistics documents (IN-17; `R-08`; doc 11 "identity leakage"): the shipping
 * label and the delivery note. Rendered deterministically from the customer's own projection of
 * the delivery and JobWork's name and city as consignor — nothing else is an input, so nothing of
 * the supplier can be in the output. Each carries the hash of its own content.
 */

export interface RenderedDocument {
  html: string;
  contentHash: string;
}

/** JobWork as consignor: its name and the city of its hub, never a workshop. */
export interface Consignor {
  name: 'JobWork';
  city: string;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `body{font:0.875rem/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:rgb(21,26,45);margin:2rem;max-width:50rem}
h1{font-size:1.25rem;margin:0 0 0.25rem}.muted{color:rgb(102,112,133)}table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{padding:0.4rem 0.5rem;border-bottom:thin solid rgb(225,230,238);text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}
.label{border:0.125rem solid rgb(21,26,45);border-radius:0.5rem;padding:1rem;margin:0 0 1.5rem;page-break-after:always}
.to{font-size:1.125rem;font-weight:600}.box{border:thin solid rgb(225,230,238);border-radius:0.5rem;padding:0.75rem;margin:0.75rem 0}`;

function address(a: SiteSnapshot | null): string {
  if (!a) return '';
  const lines = [a.label, a.addressLine1, a.addressLine2, `${a.city}, ${a.state} ${a.postalCode}`].filter((x) => x.trim() !== '');
  return lines.map(escape).join('<br>');
}

function weight(g: number | null): string {
  return g === null ? '' : `${(g / 1000).toFixed(1)} kg`;
}

function done(html: string): RenderedDocument {
  return { html, contentHash: createHash('sha256').update(html).digest('hex') };
}

/** One label per package, for the carton and the carrier. */
export function renderShippingLabels(d: CustomerDelivery, from: Consignor): RenderedDocument {
  const count = d.packages.length;
  const labels = d.packages
    .map((p) => {
      const contents = p.items.map((i) => `${escape(i.lotMarking)} × ${escape(i.quantity)} ${escape(i.unit === 'piece' ? 'Nos' : i.unit)}`).join(', ');
      return `<section class="label">
<p class="muted">From: ${escape(from.name)}, ${escape(from.city)}</p>
<p class="to">${address(d.destination)}</p>
<p>Attn: ${escape(d.destination?.contactName ?? '')} · ${escape(d.destination?.contactPhone ?? '')}</p>
<p><strong>${escape(d.number)}</strong> · package ${p.packageNo} of ${count}${p.weightG === null ? '' : ` · ${weight(p.weightG)}`} · order ${escape(d.orderNumber)}</p>
<p>Carrier: ${d.carrier.name ? `${escape(d.carrier.name)} · ${escape(d.carrier.trackingReference)}` : 'to be assigned'}</p>
<p class="muted">Contents: ${contents}</p>
</section>`;
    })
    .join('\n');
  return done(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Labels ${escape(d.number)}</title><style>${STYLE}</style></head><body>
${labels}
</body></html>`);
}

/** The packing list that travels with the goods and that the customer checks the delivery against. */
export function renderDeliveryNote(d: CustomerDelivery, from: Consignor, warrantyStatement: string): RenderedDocument {
  const rows = d.packages
    .flatMap((p) =>
      p.items.map(
        (i) =>
          `<tr><td>${p.packageNo}</td><td>${escape(i.description)}</td><td>${escape(i.lotMarking)}</td><td>${i.serials.map(escape).join(', ')}</td><td class="n">${escape(i.quantity)} ${escape(i.unit === 'piece' ? 'Nos' : i.unit)}</td></tr>`,
      ),
    )
    .join('');
  const documents = [d.documents.invoiceNumber ? `Tax invoice ${escape(d.documents.invoiceNumber)}` : '', d.documents.eWaybillNumber ? `E-way bill ${escape(d.documents.eWaybillNumber)}` : ''].filter(Boolean).join(' · ');
  return done(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Delivery note ${escape(d.number)}</title><style>${STYLE}</style></head><body>
<h1>${escape(from.name)} — Delivery note ${escape(d.number)}</h1>
<p class="muted">Order ${escape(d.orderNumber)} · ${d.packages.length} package${d.packages.length === 1 ? '' : 's'} · ${escape(d.totalQuantity)} in all${documents ? ` · ${documents}` : ''}</p>
<p>Deliver to:<br>${address(d.destination)}</p>
<table><thead><tr><th>Package</th><th>Item</th><th>Lot</th><th>Serials</th><th class="n">Quantity</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="box">Check this delivery against the note. Report a shortage, damage or defect in the JobWork portal, with photos, within the period shown there. ${escape(warrantyStatement)}</div>
<p class="muted">Dispatched by ${escape(from.name)}, ${escape(from.city)}. Quote ${escape(d.number)} in anything about this delivery.</p>
</body></html>`);
}
