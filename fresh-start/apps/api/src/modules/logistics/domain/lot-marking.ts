/** JobWork's own lot marking for a stock lot: the supplier's lot code never reaches the customer. */
export function customerLotMarking(stockLotId: string): string {
  return `JW-${stockLotId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
