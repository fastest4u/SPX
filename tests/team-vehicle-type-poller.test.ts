process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "test-secret-key-16-bytes";

import assert from "node:assert/strict";
import { ApiClient, buildBiddingListBody } from "../src/services/api-client.js";
import { Poller } from "../src/controllers/poller.js";
import { toTeamPatch, patchTouchesRuntime } from "../src/controllers/teams-controller.js";
import { createTeam, updateTeam, getTeamById } from "../src/repositories/team-repository.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { isAdhocBookingName } from "../src/utils/booking-extractor.js";

async function testApiClientVehicleType() {
  // Test buildBiddingListBody
  const body13 = buildBiddingListBody(1, 13);
  assert.strictEqual(body13.vehicle_type, 13, "buildBiddingListBody(1, 13) should have vehicle_type = 13");

  const body2 = buildBiddingListBody(1, 2);
  assert.strictEqual(body2.vehicle_type, 2, "buildBiddingListBody(1, 2) should have vehicle_type = 2");

  const bodyNull = buildBiddingListBody(1, undefined);
  assert.strictEqual(bodyNull.vehicle_type, undefined, "buildBiddingListBody(1, undefined) should NOT have vehicle_type");

  // Test ApiClient constructor with biddingVehicleType
  const client13 = new ApiClient({ biddingVehicleType: 13 });
  const client13Body = (client13 as unknown as { buildBody: () => { vehicle_type?: number } }).buildBody();
  assert.strictEqual(client13Body.vehicle_type, 13, "ApiClient with biddingVehicleType: 13 should build body with vehicle_type = 13");

  const client2 = new ApiClient({ biddingVehicleType: 2 });
  const client2Body = (client2 as unknown as { buildBody: () => { vehicle_type?: number } }).buildBody();
  assert.strictEqual(client2Body.vehicle_type, 2, "ApiClient with biddingVehicleType: 2 should build body with vehicle_type = 2");

  const clientAll = new ApiClient({ biddingVehicleType: null });
  const clientAllBody = (clientAll as unknown as { buildBody: () => { vehicle_type?: number } }).buildBody();
  assert.strictEqual(clientAllBody.vehicle_type, undefined, "ApiClient with biddingVehicleType: null should build body without vehicle_type");

  const clientDefault = new ApiClient({});
  const clientDefaultBody = (clientDefault as unknown as { buildBody: () => { vehicle_type?: number } }).buildBody();
  assert.strictEqual(clientDefaultBody.vehicle_type, undefined, "ApiClient with default options should build body without vehicle_type (poll all)");
}

function testTeamsControllerParsing() {
  // Parsing integer
  const patch13 = toTeamPatch({ biddingVehicleType: 13 });
  assert.strictEqual(patch13.biddingVehicleType, 13);

  const patch2 = toTeamPatch({ biddingVehicleType: "2" });
  assert.strictEqual(patch2.biddingVehicleType, 2);

  // Parsing null / empty -> null
  const patchNull = toTeamPatch({ biddingVehicleType: null });
  assert.strictEqual(patchNull.biddingVehicleType, null);

  const patchEmpty = toTeamPatch({ biddingVehicleType: "" });
  assert.strictEqual(patchEmpty.biddingVehicleType, null);

  // patchTouchesRuntime
  assert.strictEqual(patchTouchesRuntime({ biddingVehicleType: 13 }), true, "biddingVehicleType change must trigger runtime restart");
  assert.strictEqual(patchTouchesRuntime({ biddingVehicleType: null }), true, "biddingVehicleType change to null must trigger runtime restart");
  assert.strictEqual(patchTouchesRuntime({ name: "Renamed Team" }), false, "name change alone does not touch runtime");
}

async function testTeamRepositoryCrud() {
  process.env.DB_MODE = "memory";
  resetMemoryDb();

  // Create team with vehicle_type = 13 (6WH)
  const team6WH = await createTeam({
    name: "Team 6-Wheel",
    biddingVehicleType: 13,
    spxCookie: "test-cookie-1",
    spxDeviceId: "test-device-1",
  });
  assert.strictEqual(team6WH.biddingVehicleType, 13, "Created team should have biddingVehicleType = 13");

  // Create team with vehicle_type = 2 (4WH)
  const team4WH = await createTeam({
    name: "Team 4-Wheel",
    biddingVehicleType: 2,
    spxCookie: "test-cookie-2",
    spxDeviceId: "test-device-2",
  });
  assert.strictEqual(team4WH.biddingVehicleType, 2, "Created team should have biddingVehicleType = 2");

  // Create team with vehicle_type = null (All)
  const teamAll = await createTeam({
    name: "Team All Vehicles",
    biddingVehicleType: null,
    spxCookie: "test-cookie-3",
    spxDeviceId: "test-device-3",
  });
  assert.strictEqual(teamAll.biddingVehicleType, null, "Created team should have biddingVehicleType = null");

  // Update team vehicle type: 13 -> 2
  const updatedTo2 = await updateTeam(team6WH.id, { biddingVehicleType: 2 });
  assert.strictEqual(updatedTo2?.biddingVehicleType, 2, "Updated team should now have biddingVehicleType = 2");

  // Update team vehicle type: 2 -> null (all)
  const updatedToAll = await updateTeam(team6WH.id, { biddingVehicleType: null });
  assert.strictEqual(updatedToAll?.biddingVehicleType, null, "Updated team should now have biddingVehicleType = null");

  // Fetch from DB to verify persistence
  const fetched = await getTeamById(team6WH.id);
  assert.strictEqual(fetched?.biddingVehicleType, null, "Fetched team should persist biddingVehicleType = null");
}

function testPollerVehicleType() {
  const poller13 = new Poller(undefined, {
    teamId: 1,
    teamName: "Team 13",
    apiClient: new ApiClient(),
    lineGroupId: "test-group",
    biddingVehicleType: 13,
  });
  assert.strictEqual(
    (poller13 as unknown as { effectiveBiddingVehicleType: number | undefined }).effectiveBiddingVehicleType,
    13,
    "Poller with biddingVehicleType: 13 should have effectiveBiddingVehicleType = 13"
  );

  const poller2 = new Poller(undefined, {
    teamId: 2,
    teamName: "Team 2",
    apiClient: new ApiClient(),
    lineGroupId: "test-group",
    biddingVehicleType: 2,
  });
  assert.strictEqual(
    (poller2 as unknown as { effectiveBiddingVehicleType: number | undefined }).effectiveBiddingVehicleType,
    2,
    "Poller with biddingVehicleType: 2 should have effectiveBiddingVehicleType = 2"
  );

  const pollerNull = new Poller(undefined, {
    teamId: 3,
    teamName: "Team Null",
    apiClient: new ApiClient(),
    lineGroupId: "test-group",
    biddingVehicleType: null,
  });
  assert.strictEqual(
    (pollerNull as unknown as { effectiveBiddingVehicleType: number | undefined }).effectiveBiddingVehicleType,
    undefined,
    "Poller with biddingVehicleType: null should have effectiveBiddingVehicleType = undefined (no filter)"
  );

  const pollerDefault = new Poller(undefined, {
    teamId: 4,
    teamName: "Team Default",
    apiClient: new ApiClient(),
    lineGroupId: "test-group",
  });
  assert.strictEqual(
    (pollerDefault as unknown as { effectiveBiddingVehicleType: number | undefined }).effectiveBiddingVehicleType,
    undefined,
    "Poller with default context should have effectiveBiddingVehicleType = undefined (no filter)"
  );
}

function testIsAdhocBookingFilter() {
  assert.strictEqual(isAdhocBookingName("[3270855] [ADHOC] UPC All-Mile Clear Backlo"), true);
  assert.strictEqual(isAdhocBookingName("[ADHOC] Bangkok lanes"), true);
  assert.strictEqual(isAdhocBookingName("ADHOC 6W"), true);
  assert.strictEqual(isAdhocBookingName("adhoc small"), true);
  assert.strictEqual(isAdhocBookingName("[3270299] (รถหลัก) F2 ASNAM >> FSOCE 4W"), false);
  assert.strictEqual(isAdhocBookingName("(รถหลัก) Normal line"), false);
  assert.strictEqual(isAdhocBookingName(""), false);
  assert.strictEqual(isAdhocBookingName(null), false);
  assert.strictEqual(isAdhocBookingName(undefined), false);
}

async function run() {
  await testApiClientVehicleType();
  testTeamsControllerParsing();
  await testTeamRepositoryCrud();
  testPollerVehicleType();
  testIsAdhocBookingFilter();
  console.log("team-vehicle-type-poller: all assertions passed successfully!");
}

run().catch((err) => {
  console.error("team-vehicle-type-poller test failed:", err);
  process.exit(1);
});
