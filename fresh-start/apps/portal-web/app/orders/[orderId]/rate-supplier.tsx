'use client';

import { useState } from 'react';
import type { CustomerOrder } from '@jobwork/contracts';
import { CommandButton, Icon, TextArea } from '@jobwork/ui';
import { api } from '../../../lib/api';

/** Asks once, on a completed order, how the named supplier did (ADR-0007). */
export function RateSupplier({ order, onRated }: { order: CustomerOrder; onRated: () => Promise<void> }): React.JSX.Element | null {
  const [score, setScore] = useState(0);
  const [note, setNote] = useState('');
  if (!order.supplier || order.status !== 'completed') return null;

  if (order.rating) {
    return (
      <section className="jw-panel jw-rate" aria-label="Your rating">
        <p className="jw-rating">
          <Icon name="star" size={1.2} /> You rated {order.supplier.name} {order.rating.score} out of 5
        </p>
      </section>
    );
  }

  return (
    <section className="jw-panel jw-rate" aria-labelledby="rate-supplier">
      <h2 id="rate-supplier" className="jw-section-heading">
        Rate {order.supplier.name}
      </h2>
      <div className="jw-stars" role="radiogroup" aria-label="Rating out of 5">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={score === value}
            aria-label={`${value} out of 5`}
            className={value <= score ? 'jw-star-on' : undefined}
            onClick={() => setScore(value)}
          >
            <Icon name="star" size={1.6} />
          </button>
        ))}
      </div>
      <TextArea label="Comments" value={note} onChange={(event) => setNote(event.target.value)} />
      <CommandButton
        receiptLabel="Thank you"
        disabled={score === 0}
        disabledReason="Choose a rating"
        onCommand={async () => {
          await api(`/orders/${order.orderId}/rating`, { method: 'POST', body: { score, note: note.trim() }, idempotencyKey: `rate-${order.orderId}` });
          await onRated();
        }}
      >
        Submit Rating
      </CommandButton>
    </section>
  );
}
