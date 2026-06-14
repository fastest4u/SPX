# New Booking Fast Lane Design

## Goal

Ensure a booking first observed after poller startup can begin its detail fetch immediately, even when recurring bookings are continuously consuming background detail capacity.

## Architecture

The poller keeps a bounded set of booking IDs waiting for the fast lane. The first list observed after startup only primes the seen-booking set, so old bookings are not misclassified as new. Later unseen booking IDs enter the fast-lane set and remain there until they are launched. A transient partial list response cannot remove their priority; the bounded set evicts the oldest entry only if it reaches its safety cap.

Detail concurrency is divided logically:

- Fast-lane work may use any free slot up to `BOOKING_DETAIL_CONCURRENCY`.
- Background work may use only the non-reserved portion of the limit.
- The reserve is derived from the configured limit: 25%, with a minimum of one slot when concurrency is at least two and a maximum of eight slots.
- A concurrency limit of one has no reserve, so existing behavior remains usable.

Fast-lane bookings run before recurring bookings. Existing origin-hint ordering remains active within each lane and remains sort-only; it never excludes a booking.

## Data Flow

1. Fetch the bidding list.
2. Detect booking IDs not previously observed after startup.
3. Add new IDs to the pending fast-lane set.
4. Apply existing origin-hint ordering.
5. Partition the ordered list into pending fast-lane and background bookings.
6. Launch fast-lane detail work up to the total concurrency limit.
7. Launch background detail work only up to the background limit.
8. Remove a booking from the pending fast-lane set when its detail task launches.
9. Continue using page-level request-list callbacks so rule matching and Accept start as soon as the first detail page arrives.

## Correctness Constraints

- Preserve `activeDetailBookingIds` duplicate protection.
- Preserve re-process cooldown and failure backoff behavior.
- Preserve cross-tick `NeedBudget` and accept request deduplication.
- Do not classify startup bookings as new.
- Do not remove a pending fast-lane booking merely because all slots are busy; retry it on the next poll.
- Keep pending priority across transient list omissions; bound memory with FIFO eviction.
- Do not change Accept retry or verification behavior.

## Observability

Emit a structured aggregate log when fast-lane work is queued, launched, or blocked. Include reserve size, lane inflight counts, pending count, and concurrency limit.

## Testing

- Unit-test reserve sizing and stable lane partitioning.
- Integration-test poller scheduling with background capacity occupied:
  - startup bookings fill only background capacity;
  - a newly appearing booking uses the reserved slot immediately;
  - an older unlaunched booking does not consume the reserve.
- Run the full test suite, typecheck, build, and diff whitespace check.
