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
    booking_name: `[ADHOC] booking-${bookingId}`,
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

  Object.assign(poller as unknown as { processOneBooking: unknown; rateLimitPausedUntil: number }, {
    processOneBooking: (item: Booking) => {
      launched.push(item.booking_id);
      return Promise.resolve(true);
    },
    rateLimitPausedUntil: Date.now() + 60,
  });

  const schedule = (poller as unknown as {
    scheduleBookingDetails: (bookings: Booking[]) => Promise<void>;
  }).scheduleBookingDetails.bind(poller);

  await schedule([booking(100)]);
  assert.deepEqual(
    launched,
    [100],
    "bookings during active rateLimitPausedUntil must be awaited and launched, not dropped",
  );

  console.log("poller-rate-limit-pause: bookings are preserved during rate limit backoff");
}

main()
  .then(() => {
    Object.assign(mutableEnv, original);
  })
  .catch((err) => {
    Object.assign(mutableEnv, original);
    console.error(err);
    process.exit(1);
  });
