import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { Booking } from "../src/models/types.js";

const mutableEnv = env as unknown as {
  AUTO_ACCEPT_ENABLED: boolean;
  BOOKING_DETAIL_CONCURRENCY: number;
  BOOKING_REPROCESS_COOLDOWN_MS: number;
};

const original = {
  AUTO_ACCEPT_ENABLED: mutableEnv.AUTO_ACCEPT_ENABLED,
  BOOKING_DETAIL_CONCURRENCY: mutableEnv.BOOKING_DETAIL_CONCURRENCY,
  BOOKING_REPROCESS_COOLDOWN_MS: mutableEnv.BOOKING_REPROCESS_COOLDOWN_MS,
};

function booking(bookingId: number): Booking {
  return {
    booking_id: bookingId,
    booking_name: `booking-${bookingId}`,
    agency_name: "SPX",
  } as Booking;
}

async function main(): Promise<void> {
  setLogLevel(LogLevel.ERROR);
  Object.assign(mutableEnv, {
    AUTO_ACCEPT_ENABLED: false,
    BOOKING_DETAIL_CONCURRENCY: 4,
    BOOKING_REPROCESS_COOLDOWN_MS: 0,
  });

  const poller = new Poller();
  const launched: number[] = [];
  const releases = new Map<number, () => void>();

  Object.assign(poller as unknown as { processOneBooking: unknown }, {
    processOneBooking: (item: Booking) => {
      launched.push(item.booking_id);
      return new Promise<boolean>((resolve) => {
        releases.set(item.booking_id, () => resolve(true));
      });
    },
  });

  const schedule = (poller as unknown as {
    scheduleBookingDetails: (bookings: Booking[]) => Promise<void>;
  }).scheduleBookingDetails.bind(poller);

  await schedule([booking(1), booking(2), booking(3), booking(4)]);
  assert.deepEqual(
    launched,
    [1, 2, 3],
    "startup bookings must use only background capacity and leave one reserved slot"
  );

  await schedule([booking(1), booking(2), booking(3), booking(4), booking(5)]);
  assert.deepEqual(
    launched,
    [1, 2, 3, 5],
    "a newly observed booking must launch immediately through the reserved fast-lane slot"
  );

  // A second new booking is pending because all four slots are occupied.
  await schedule([booking(1), booking(2), booking(3), booking(4), booking(5), booking(6)]);
  assert.deepEqual(launched, [1, 2, 3, 5], "the second new booking must wait while total capacity is full");

  // A partial/stale list response may omit the pending booking for one poll.
  // That must not permanently downgrade it to background work.
  await schedule([booking(1), booking(2), booking(3), booking(4), booking(5)]);
  releases.get(5)?.();
  await new Promise((resolve) => setImmediate(resolve));
  await schedule([booking(1), booking(2), booking(3), booking(4), booking(6)]);
  assert.deepEqual(
    launched,
    [1, 2, 3, 5, 6],
    "a pending fast-lane booking must keep priority across a transient list omission"
  );

  for (const release of releases.values()) release();
  await new Promise((resolve) => setImmediate(resolve));
}

main()
  .then(() => {
    console.log("poller-fast-lane.test.ts passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    Object.assign(mutableEnv, original);
    setLogLevel(LogLevel.INFO);
  });
