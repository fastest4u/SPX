import {
  listDriversByTeam,
  type TeamSpxDriverRecord,
} from "../repositories/team-spx-driver-repository.js";
import { logger } from "../utils/logger.js";

export interface TeamDriverPoolOptions {
  teamId: number;
  loadDrivers?: (teamId: number) => Promise<TeamSpxDriverRecord[]>;
  clock?: () => number;
  random?: () => number;
}

export interface AllocateDriversOptions {
  count: number;
  vehicleTypeId?: number | null;
  vehicleTypeName?: string | null;
  bookingId?: number;
  excludeDriverIds?: Iterable<number>;
  excludeDriverNames?: Iterable<string>;
}

export interface NextDriverOptions {
  vehicleTypeId?: number | null;
  vehicleTypeName?: string | null;
  bookingId?: number;
  excludeDriverIds?: Iterable<number>;
  excludeDriverNames?: Iterable<string>;
}

const DEFAULT_DRIVER_COOLDOWN_MS = 10 * 60_000;
const MAX_TRACKED_BOOKINGS = 200;

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

export function isMeaningfulVehicleTypeText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && /[\p{L}\p{N}]/u.test(trimmed);
}

function normalizeVehicleTypeKey(value: string | null | undefined): string {
  if (!isMeaningfulVehicleTypeText(value)) return "";
  return normalizeText(value).replace(/\s+/g, "");
}

function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

export class TeamDriverPool {
  public readonly teamId: number;
  private readonly loadDriversFn: (teamId: number) => Promise<TeamSpxDriverRecord[]>;
  private readonly clock: () => number;
  private readonly random: () => number;

  private drivers: TeamSpxDriverRecord[] = [];
  private driversById = new Map<number, TeamSpxDriverRecord>();
  private byVehicleType = new Map<number, TeamSpxDriverRecord[]>();
  private byVehicleTypeName = new Map<string, TeamSpxDriverRecord[]>();
  private readonly deckByBucket = new Map<string, TeamSpxDriverRecord[]>();
  private readonly usedIdsInCycle = new Map<string, Set<number>>();
  private readonly usedNamesInCycle = new Map<string, Set<string>>();
  private readonly bookingAssignedIds = new Map<number, Set<number>>();
  private readonly bookingAssignedNames = new Map<number, Set<string>>();
  private readonly driverCooldownUntil = new Map<number, number>();
  private initialized = false;
  private lastReloadAt = 0;
  private reloadInFlight: Promise<void> | null = null;
  private reloadQueued = false;

  constructor(options: TeamDriverPoolOptions) {
    this.teamId = options.teamId;
    this.loadDriversFn = options.loadDrivers ?? ((id) => listDriversByTeam(id, { onlyEnabled: true }));
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async init(): Promise<void> {
    await this.reloadDrivers();
    this.initialized = true;
  }

  async reloadDrivers(): Promise<void> {
    if (this.reloadInFlight) {
      // Queue one follow-up reload so DB commits made while an earlier SELECT was in flight are never missed.
      this.reloadQueued = true;
      await this.reloadInFlight;
      if (this.reloadInFlight) {
        await this.reloadInFlight;
      }
      return;
    }

    const runReload = async (): Promise<void> => {
      try {
        do {
          this.reloadQueued = false;
          await this.executeSingleReload();
        } while (this.reloadQueued);
      } finally {
        this.reloadInFlight = null;
      }
    };

    this.reloadInFlight = runReload();
    return this.reloadInFlight;
  }

  private async executeSingleReload(): Promise<void> {
    try {
      const loaded = await this.loadDriversFn(this.teamId);
      const enabledDrivers = loaded.filter((d) => d.enabled && d.driverId > 0 && d.driverName.trim().length > 0);
      this.drivers = enabledDrivers;
      this.lastReloadAt = this.clock();

      const byId = new Map<number, TeamSpxDriverRecord>();
      const byType = new Map<number, TeamSpxDriverRecord[]>();
      const byName = new Map<string, TeamSpxDriverRecord[]>();
      const activeIds = new Set<number>();

      for (const driver of enabledDrivers) {
        activeIds.add(driver.driverId);
        byId.set(driver.driverId, driver);

        const typeBucket = byType.get(driver.vehicleType);
        if (typeBucket) typeBucket.push(driver);
        else byType.set(driver.vehicleType, [driver]);

        const nameKey = normalizeVehicleTypeKey(driver.vehicleTypeName);
        if (nameKey) {
          const nameBucket = byName.get(nameKey);
          if (nameBucket) nameBucket.push(driver);
          else byName.set(nameKey, [driver]);
        }
      }

      this.driversById = byId;
      this.byVehicleType = byType;
      this.byVehicleTypeName = byName;
      this.deckByBucket.clear();

      for (const id of this.driverCooldownUntil.keys()) {
        if (!activeIds.has(id)) this.driverCooldownUntil.delete(id);
      }

      for (const [bucketKey, usedIds] of this.usedIdsInCycle) {
        const rebuiltNames = new Set<string>();
        for (const id of usedIds) {
          const active = byId.get(id);
          if (!active) {
            usedIds.delete(id);
          } else {
            const norm = normalizeText(active.driverName);
            if (norm) rebuiltNames.add(norm);
          }
        }
        if (usedIds.size === 0) {
          this.usedIdsInCycle.delete(bucketKey);
          this.usedNamesInCycle.delete(bucketKey);
        } else {
          this.usedNamesInCycle.set(bucketKey, rebuiltNames);
        }
      }

      for (const [bookingId, bookedIds] of this.bookingAssignedIds) {
        const rebuiltNames = new Set<string>();
        for (const id of bookedIds) {
          const active = byId.get(id);
          if (!active) {
            bookedIds.delete(id);
          } else {
            const norm = normalizeText(active.driverName);
            if (norm) rebuiltNames.add(norm);
          }
        }
        if (bookedIds.size === 0) {
          this.bookingAssignedIds.delete(bookingId);
          this.bookingAssignedNames.delete(bookingId);
        } else {
          this.bookingAssignedNames.set(bookingId, rebuiltNames);
        }
      }
    } catch (err) {
      logger.error("team-driver-pool-reload-failed", {
        teamId: this.teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  triggerBackgroundReloadIfStale(maxAgeMs = 30_000): void {
    if (this.reloadInFlight) return;
    if (this.clock() - this.lastReloadAt <= maxAgeMs) return;
    void this.reloadDrivers();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  hasDrivers(vehicleType?: number | null): boolean {
    if (typeof vehicleType === "number" && Number.isInteger(vehicleType) && vehicleType > 0) {
      return (this.byVehicleType.get(vehicleType)?.length ?? 0) > 0;
    }
    return this.drivers.length > 0;
  }

  getDriverCount(vehicleType?: number | null): number {
    if (typeof vehicleType === "number" && Number.isInteger(vehicleType) && vehicleType > 0) {
      return this.byVehicleType.get(vehicleType)?.length ?? 0;
    }
    return this.drivers.length;
  }

  recordDriverFailure(driverId: number, cooldownMs = DEFAULT_DRIVER_COOLDOWN_MS): void {
    if (!Number.isInteger(driverId) || driverId <= 0) return;
    this.driverCooldownUntil.set(driverId, this.clock() + Math.max(1_000, cooldownMs));
  }

  releaseBookingDriver(bookingId: number, driverId: number, driverName?: string): void {
    if (!Number.isInteger(bookingId) || bookingId <= 0) return;
    if (!Number.isInteger(driverId) || driverId <= 0) return;

    const ids = this.bookingAssignedIds.get(bookingId);
    if (!ids || !ids.has(driverId)) return;

    ids.delete(driverId);
    if (ids.size === 0) {
      this.bookingAssignedIds.delete(bookingId);
      this.bookingAssignedNames.delete(bookingId);
      return;
    }

    // Rebuild remaining assigned names from still-active assigned IDs so shared names stay tracked accurately.
    const names = this.bookingAssignedNames.get(bookingId);
    if (names) {
      const rebuilt = new Set<string>();
      for (const remainingId of ids) {
        const record = this.driversById.get(remainingId);
        const norm = record ? normalizeText(record.driverName) : "";
        if (norm) rebuilt.add(norm);
      }
      if (rebuilt.size === 0 && driverName) {
        names.delete(normalizeText(driverName));
      } else {
        this.bookingAssignedNames.set(bookingId, rebuilt);
      }
    }
  }

  clearCooldowns(): void {
    this.driverCooldownUntil.clear();
  }

  nextDriver(options: NextDriverOptions = {}): TeamSpxDriverRecord | null {
    return this.allocateDrivers({ ...options, count: 1 })[0] ?? null;
  }

  allocateDrivers(options: AllocateDriversOptions): TeamSpxDriverRecord[] {
    const requestedCount = Math.max(0, Math.floor(options.count));
    if (requestedCount === 0 || this.drivers.length === 0) return [];

    const resolved = this.resolveCandidates(options.vehicleTypeId, options.vehicleTypeName);
    if (!resolved || resolved.candidates.length === 0) return [];

    const { bucketKey, candidates } = resolved;
    const now = this.clock();

    const explicitExcludedIds = new Set<number>(options.excludeDriverIds ?? []);
    const explicitExcludedNames = new Set<string>(
      [...(options.excludeDriverNames ?? [])].map((name) => normalizeText(name)).filter(Boolean),
    );

    const batchExcludedIds = new Set<number>(explicitExcludedIds);
    const batchExcludedNames = new Set<string>(explicitExcludedNames);

    const bookingId = typeof options.bookingId === "number" && Number.isInteger(options.bookingId) && options.bookingId > 0
      ? options.bookingId
      : undefined;

    const bookedIds = bookingId !== undefined ? this.bookingAssignedIds.get(bookingId) : undefined;
    const bookedNames = bookingId !== undefined ? this.bookingAssignedNames.get(bookingId) : undefined;

    const effectiveExcludedIds = new Set<number>(batchExcludedIds);
    const effectiveExcludedNames = new Set<string>(batchExcludedNames);
    if (bookedIds) {
      for (const id of bookedIds) effectiveExcludedIds.add(id);
    }
    if (bookedNames) {
      for (const name of bookedNames) effectiveExcludedNames.add(name);
    }

    const allocated: TeamSpxDriverRecord[] = [];
    for (let i = 0; i < requestedCount; i++) {
      let picked = this.pickOneFromBucket(bucketKey, candidates, now, effectiveExcludedIds, effectiveExcludedNames);
      if (!picked && (bookedIds?.size || bookedNames?.size)) {
        // All distinct drivers for this vehicle type were already used on this bookingId:
        // fall back within the SAME vehicle type bucket (still honoring explicit + current-batch exclusions)
        // so SPX does not fall back to legacy /accept and fail with retcode 131490411.
        picked = this.pickOneFromBucket(bucketKey, candidates, now, batchExcludedIds, batchExcludedNames);
        if (picked) {
          logger.warn("team-driver-pool-booking-exhausted-reusing", {
            teamId: this.teamId,
            bookingId,
            bucketKey,
            driverId: picked.driverId,
          });
        }
      }
      if (!picked && allocated.length > 0) {
        // Single batch requested more slots than distinct driver names available in this vehicle type.
        picked = this.pickOneFromBucket(bucketKey, candidates, now, explicitExcludedIds, explicitExcludedNames);
        if (picked) {
          logger.warn("team-driver-pool-batch-exhausted-reusing", {
            teamId: this.teamId,
            bookingId,
            bucketKey,
            driverId: picked.driverId,
          });
        }
      }
      if (!picked) break;

      allocated.push(picked);
      batchExcludedIds.add(picked.driverId);
      effectiveExcludedIds.add(picked.driverId);
      const normalizedName = normalizeText(picked.driverName);
      if (normalizedName) {
        batchExcludedNames.add(normalizedName);
        effectiveExcludedNames.add(normalizedName);
      }
    }

    if (allocated.length > 0 && bookingId !== undefined) {
      this.rememberBookingAssignments(bookingId, allocated);
    }

    return allocated;
  }

  private resolveCandidates(
    vehicleTypeId?: number | null,
    vehicleTypeName?: string | null,
  ): { bucketKey: string; candidates: TeamSpxDriverRecord[] } | null {
    const hasNumericType = typeof vehicleTypeId === "number" && Number.isInteger(vehicleTypeId) && vehicleTypeId > 0;
    const normalizedNameKey = normalizeVehicleTypeKey(vehicleTypeName);

    if (hasNumericType) {
      // Strict numeric vehicle_type matching: never cross-assign a different numeric vehicle_type via fuzzy name containment.
      const exact = this.byVehicleType.get(vehicleTypeId);
      if (exact && exact.length > 0) {
        return { bucketKey: `vt:${vehicleTypeId}`, candidates: exact };
      }
      return null;
    }

    if (normalizedNameKey) {
      return this.findByVehicleTypeName(normalizedNameKey);
    }

    // Without vehicle type hints, only auto-pick when the team's enabled drivers belong to a single vehicle type.
    if (this.byVehicleType.size === 1) {
      const onlyEntry = this.byVehicleType.entries().next().value;
      if (onlyEntry && onlyEntry[1].length > 0) {
        return { bucketKey: `vt:${onlyEntry[0]}`, candidates: onlyEntry[1] };
      }
    }

    return null;
  }

  private findByVehicleTypeName(
    normalizedNameKey: string,
  ): { bucketKey: string; candidates: TeamSpxDriverRecord[] } | null {
    const exact = this.byVehicleTypeName.get(normalizedNameKey);
    if (exact && exact.length > 0) {
      return { bucketKey: `vt:${exact[0].vehicleType}`, candidates: exact };
    }

    // Only allow containment matching when the query is specific (>= 3 chars) and resolves unambiguously to ONE vehicle type.
    if (normalizedNameKey.length < 3) return null;
    const matchedBuckets = new Map<number, TeamSpxDriverRecord[]>();
    for (const [key, list] of this.byVehicleTypeName) {
      if (list.length === 0) continue;
      if (key.includes(normalizedNameKey) || normalizedNameKey.includes(key)) {
        matchedBuckets.set(list[0].vehicleType, list);
      }
    }

    if (matchedBuckets.size === 1) {
      const [vehicleType, list] = matchedBuckets.entries().next().value!;
      return { bucketKey: `vt:${vehicleType}`, candidates: list };
    }

    return null;
  }

  private getOrBuildDeck(bucketKey: string, candidates: TeamSpxDriverRecord[]): TeamSpxDriverRecord[] {
    let deck = this.deckByBucket.get(bucketKey);
    if (!deck || deck.length !== candidates.length) {
      deck = shuffleInPlace([...candidates], this.random);
      this.deckByBucket.set(bucketKey, deck);
    }
    return deck;
  }

  private hasAnyEligibleCandidate(
    candidates: TeamSpxDriverRecord[],
    batchExcludedIds: Set<number>,
    batchExcludedNames: Set<string>,
  ): boolean {
    for (const driver of candidates) {
      if (batchExcludedIds.has(driver.driverId)) continue;
      const normName = normalizeText(driver.driverName);
      if (normName && batchExcludedNames.has(normName)) continue;
      return true;
    }
    return false;
  }

  private pickOneFromBucket(
    bucketKey: string,
    candidates: TeamSpxDriverRecord[],
    now: number,
    batchExcludedIds: Set<number>,
    batchExcludedNames: Set<string>,
  ): TeamSpxDriverRecord | null {
    const deck = this.getOrBuildDeck(bucketKey, candidates);
    let usedIds = this.usedIdsInCycle.get(bucketKey);
    let usedNames = this.usedNamesInCycle.get(bucketKey);
    if (!usedIds) {
      usedIds = new Set<number>();
      this.usedIdsInCycle.set(bucketKey, usedIds);
    }
    if (!usedNames) {
      usedNames = new Set<string>();
      this.usedNamesInCycle.set(bucketKey, usedNames);
    }

    const findMatch = (ignoreCycle: boolean, ignoreCooldown: boolean): TeamSpxDriverRecord | null => {
      for (const driver of deck) {
        if (batchExcludedIds.has(driver.driverId)) continue;
        const normName = normalizeText(driver.driverName);
        if (normName && batchExcludedNames.has(normName)) continue;
        if (!ignoreCooldown && (this.driverCooldownUntil.get(driver.driverId) ?? 0) > now) continue;
        if (!ignoreCycle) {
          if (usedIds.has(driver.driverId)) continue;
          if (normName && usedNames.has(normName)) continue;
        }
        return driver;
      }
      return null;
    };

    let chosen = findMatch(false, false);
    if (!chosen) {
      // Do not wipe cycle progress if every candidate is excluded by batch/booking constraints.
      if (!this.hasAnyEligibleCandidate(candidates, batchExcludedIds, batchExcludedNames)) {
        return null;
      }
      // Current cycle exhausted for eligible drivers: reshuffle a fresh cycle while still honoring exclusions.
      usedIds.clear();
      usedNames.clear();
      const reshuffled = shuffleInPlace([...candidates], this.random);
      this.deckByBucket.set(bucketKey, reshuffled);
      chosen = this.findInList(reshuffled, now, batchExcludedIds, batchExcludedNames, false);
      if (!chosen) {
        // Last resort if all non-excluded drivers are currently on cooldown: pick earliest-expiring cooldown driver.
        chosen = this.findInList(reshuffled, now, batchExcludedIds, batchExcludedNames, true);
      }
    }

    if (chosen) {
      usedIds.add(chosen.driverId);
      const normName = normalizeText(chosen.driverName);
      if (normName) usedNames.add(normName);
    }
    return chosen;
  }

  private findInList(
    list: TeamSpxDriverRecord[],
    now: number,
    batchExcludedIds: Set<number>,
    batchExcludedNames: Set<string>,
    ignoreCooldown: boolean,
  ): TeamSpxDriverRecord | null {
    if (!ignoreCooldown) {
      for (const driver of list) {
        if (batchExcludedIds.has(driver.driverId)) continue;
        const normName = normalizeText(driver.driverName);
        if (normName && batchExcludedNames.has(normName)) continue;
        if ((this.driverCooldownUntil.get(driver.driverId) ?? 0) > now) continue;
        return driver;
      }
      return null;
    }

    let best: TeamSpxDriverRecord | null = null;
    let bestCooldown = Number.POSITIVE_INFINITY;
    for (const driver of list) {
      if (batchExcludedIds.has(driver.driverId)) continue;
      const normName = normalizeText(driver.driverName);
      if (normName && batchExcludedNames.has(normName)) continue;
      const until = this.driverCooldownUntil.get(driver.driverId) ?? 0;
      if (until < bestCooldown) {
        bestCooldown = until;
        best = driver;
      }
    }
    return best;
  }

  private rememberBookingAssignments(bookingId: number, drivers: TeamSpxDriverRecord[]): void {
    let ids = this.bookingAssignedIds.get(bookingId);
    let names = this.bookingAssignedNames.get(bookingId);
    if (!ids) {
      ids = new Set<number>();
      this.bookingAssignedIds.set(bookingId, ids);
    }
    if (!names) {
      names = new Set<string>();
      this.bookingAssignedNames.set(bookingId, names);
    }
    for (const driver of drivers) {
      ids.add(driver.driverId);
      const normName = normalizeText(driver.driverName);
      if (normName) names.add(normName);
    }
    while (this.bookingAssignedIds.size > MAX_TRACKED_BOOKINGS) {
      const oldestKey = this.bookingAssignedIds.keys().next().value;
      if (oldestKey === undefined) break;
      this.bookingAssignedIds.delete(oldestKey);
      this.bookingAssignedNames.delete(oldestKey);
    }
  }
}

const poolRegistry = new Map<number, TeamDriverPool>();
const initPromises = new Map<number, Promise<TeamDriverPool>>();

export async function getOrCreateTeamDriverPool(teamId: number): Promise<TeamDriverPool> {
  const existing = poolRegistry.get(teamId);
  if (existing && existing.isInitialized()) return existing;

  const inflight = initPromises.get(teamId);
  if (inflight) return inflight;

  const initPromise = (async () => {
    const pool = existing ?? new TeamDriverPool({ teamId });
    poolRegistry.set(teamId, pool);
    await pool.init();
    return pool;
  })().finally(() => {
    initPromises.delete(teamId);
  });

  initPromises.set(teamId, initPromise);
  return initPromise;
}

export async function reloadTeamDriverPool(teamId: number): Promise<void> {
  const existing = poolRegistry.get(teamId);
  if (existing) {
    await existing.reloadDrivers();
  }
}

export function clearTeamDriverPoolRegistry(): void {
  poolRegistry.clear();
  initPromises.clear();
}
