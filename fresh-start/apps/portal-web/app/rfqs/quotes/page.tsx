'use client';

import { RfqList } from '../rfq-list';

/** The vendor's Quotes tab (VF-18, reference screen 15): the requests it has quoted. */
export default function SupplierQuotesPage(): React.JSX.Element {
  return <RfqList quotedOnly />;
}
