export interface FastLaneBooking {
  booking_id: number;
}

export interface FastLanePartition<T extends FastLaneBooking> {
  fastLane: T[];
  background: T[];
  ordered: T[];
}

export function fastLaneReserveForConcurrency(concurrency: number): number {
  const limit = Number.isFinite(concurrency) ? Math.max(0, Math.floor(concurrency)) : 0;
  if (limit <= 1) return 0;
  return Math.min(8, Math.max(1, Math.ceil(limit * 0.25)));
}

export function partitionBookingsByFastLane<T extends FastLaneBooking>(
  bookings: T[],
  fastLaneBookingIds: ReadonlySet<number>
): FastLanePartition<T> {
  const fastLane: T[] = [];
  const background: T[] = [];

  for (const booking of bookings) {
    if (fastLaneBookingIds.has(booking.booking_id)) {
      fastLane.push(booking);
    } else {
      background.push(booking);
    }
  }

  return {
    fastLane,
    background,
    ordered: [...fastLane, ...background],
  };
}
