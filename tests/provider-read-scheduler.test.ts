import assert from "node:assert/strict";
import { ProviderReadScheduler } from "../src/services/provider-read-scheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function main(): Promise<void> {
  {
    const scheduler = new ProviderReadScheduler({ maxConcurrency: 2 });
    scheduler.deferFor(40);
    let fetchCallsDuringCooldown = 0;
    const read = scheduler.schedule(async () => {
      fetchCallsDuringCooldown += 1;
      return "done";
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fetchCallsDuringCooldown, 0);
    assert.equal(await read, "done");
    assert.equal(scheduler.getRateLimitRetryAt(), 0, "expired cooldown must not look active");
  }

  {
    const scheduler = new ProviderReadScheduler({ maxConcurrency: 1 });
    const activeGate = deferred();
    const order: string[] = [];
    const active = scheduler.schedule(async () => {
      order.push("active");
      await activeGate.promise;
    });
    await waitFor(() => order.length === 1);

    const detail = scheduler.schedule(async () => {
      order.push("detail");
    });
    const verification = scheduler.schedule(async () => {
      order.push("verification");
    }, "verification");

    activeGate.resolve();
    await Promise.all([active, detail, verification]);
    assert.deepEqual(order, ["active", "verification", "detail"]);
  }

  {
    const first = new ProviderReadScheduler({ maxConcurrency: 2 });
    const second = new ProviderReadScheduler({ maxConcurrency: 2 });
    first.deferFor(40);
    let firstCalls = 0;
    let secondCalls = 0;

    const firstRead = first.schedule(async () => { firstCalls += 1; });
    await second.schedule(async () => { secondCalls += 1; });

    assert.equal(firstCalls, 0, "one scheduler's cooldown must remain local");
    assert.equal(secondCalls, 1, "an unrelated scheduler must remain available");
    await firstRead;
  }

  {
    const scheduler = new ProviderReadScheduler({ maxConcurrency: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let maximumActive = 0;
    const reads = gates.map((gate) => scheduler.schedule(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate.promise;
      active -= 1;
    }));

    await waitFor(() => active === 2);
    assert.equal(maximumActive, 2, "healthy reads may use both bounded slots");
    gates[0].resolve();
    await waitFor(() => maximumActive === 2 && active === 2);
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(reads);
  }

  {
    const scheduler = new ProviderReadScheduler({ maxConcurrency: 1 });
    const unrelated = new ProviderReadScheduler({ maxConcurrency: 1 });
    scheduler.deferFor(40);
    let verificationAllowed = true;
    let guardedFetches = 0;
    let normalFetches = 0;
    let unrelatedFetches = 0;

    const guarded = scheduler.schedule(
      async () => { guardedFetches += 1; },
      "verification",
      async () => verificationAllowed,
    );
    const normal = scheduler.schedule(async () => { normalFetches += 1; });
    await unrelated.schedule(async () => { unrelatedFetches += 1; });
    verificationAllowed = false;

    await assert.rejects(guarded, /no longer admitted/i);
    await normal;
    assert.equal(guardedFetches, 0, "a guard closed during cooldown must suppress the provider read");
    assert.equal(normalFetches, 1, "a denied verification read must not cancel ordinary queued work");
    assert.equal(unrelatedFetches, 1, "a denied verification read must not affect another client");
  }

  {
    let now = 0;
    const timerDelays: number[] = [];
    const timerCallbacks: Array<() => void> = [];
    const scheduler = new ProviderReadScheduler({
      maxConcurrency: 1,
      now: () => now,
      setTimer: (callback, delayMs) => {
        timerCallbacks.push(callback);
        timerDelays.push(delayMs);
        return timerCallbacks.length;
      },
      clearTimer: () => undefined,
    });
    const longDelayMs = 2_147_483_647 + 5_000;
    scheduler.deferFor(longDelayMs);
    let fetches = 0;
    const read = scheduler.schedule(async () => { fetches += 1; });

    assert.equal(timerDelays[0], 2_147_483_647, "long cooldown timers must use a safe first chunk");
    now = 2_147_483_647;
    timerCallbacks[0]();
    assert.equal(timerDelays[1], 5_000, "remaining cooldown must be re-armed after the first chunk");
    assert.equal(fetches, 0);
    now = longDelayMs;
    timerCallbacks[1]();
    await read;
    assert.equal(fetches, 1);
  }

  {
    const scheduler = new ProviderReadScheduler({ maxConcurrency: 2 });
    const guardGate = deferred();
    let guardStarted = false;
    let rawReads = 0;
    const guarded = scheduler.schedule(
      async () => { rawReads += 1; },
      "verification",
      async () => {
        guardStarted = true;
        await guardGate.promise;
        return true;
      },
    );
    await waitFor(() => guardStarted);

    scheduler.deferFor(40);
    guardGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(rawReads, 0, "a cooldown extended during an async guard must block raw dispatch");
    await guarded;
    assert.equal(rawReads, 1);
  }

  console.log("provider-read-scheduler: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
