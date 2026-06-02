export interface BookingPriorityInput {
  booking_id: number;
  booking_name: string;
}

export interface BookingPriorityResult<T extends BookingPriorityInput> {
  prioritized: T[];
  deferred: T[];
  ordered: T[];
}

export function bookingMatchesOriginFilters(booking: BookingPriorityInput, originFilters: string[]): boolean {
  if (originFilters.length === 0) return true;

  const bookingName = booking.booking_name.trim().toLowerCase();
  return originFilters.some((origin) => {
    const normalized = origin.trim().toLowerCase();
    return normalized.length > 0 && bookingName.includes(normalized);
  });
}

export function orderBookingsByOriginHint<T extends BookingPriorityInput>(
  bookings: T[],
  originFilters: string[]
): BookingPriorityResult<T> {
  if (originFilters.length === 0) {
    return { prioritized: bookings, deferred: [], ordered: bookings };
  }

  const prioritized: T[] = [];
  const deferred: T[] = [];

  for (const booking of bookings) {
    if (bookingMatchesOriginFilters(booking, originFilters)) {
      prioritized.push(booking);
    } else {
      deferred.push(booking);
    }
  }

  return {
    prioritized,
    deferred,
    ordered: [...prioritized, ...deferred],
  };
}
