import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  bundleResources,
  bundleTarget,
  databricksJson,
  deployedAppName,
} from "./lib/databricks.mjs";

async function waitForAppUrl(appName) {
  const deadline = performance.now() + 600_000;
  while (true) {
    const app = databricksJson("apps", "get", appName);
    const status = app?.app_status;
    if (status?.state === "RUNNING") {
      assert.ok(
        typeof app.url === "string" && app.url,
        `Missing URL for deployed app ${appName}.`,
      );
      return app.url;
    }
    if (status?.state === "CRASHED") {
      throw new Error(
        `App ${appName} crashed during startup. ${status.message ?? ""}`.trim(),
      );
    }
    const remaining = deadline - performance.now();
    const state = status?.state ?? "unknown";
    if (remaining <= 0) {
      throw new Error(
        `App ${appName} did not reach RUNNING within 10 minutes. Last state: ${state}.`,
      );
    }
    console.log(`Waiting for app ${appName} (state: ${state}).`);
    await sleep(Math.min(15_000, remaining));
  }
}

const resources = bundleResources(bundleTarget("check_hosted_apis"));
const appUrl = await waitForAppUrl(deployedAppName(resources));
const token =
  process.env.DATABRICKS_APP_OAUTH_TOKEN ||
  databricksJson("auth", "token")?.access_token;
assert.ok(
  typeof token === "string" && token,
  "Missing Databricks access token.",
);
const request = async (
  path,
  method = "GET",
  body,
  signal = AbortSignal.timeout(190000),
  grant,
) => {
  const response = await fetch(`${appUrl}${path}`, {
    method,
    redirect: "error",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(grant === undefined ? {} : { "x-genie-access": grant }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(
    response.headers.get("content-type")?.includes("application/json"),
    `${path}: expected JSON, got HTTP ${response.status} ${response.headers.get("content-type")}`,
  );
  const result = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
};
const metadata = await request("/api/metadata");
const overview = await request("/api/overview");
assert.ok(metadata.trips > 0);
assert.equal(overview.summary.trips, metadata.trips);
const trips = await request("/api/trips");
assert.equal(trips.total, metadata.trips);
assert.ok(trips.rows.length > 0);
assert.ok(
  trips.rows.every(
    (trip) =>
      trip.details &&
      /^yellow_tripdata_\d{4}-(0[1-9]|1[0-2])\.csv\.gz$/.test(
        trip.details.source_file,
      ) &&
      Object.hasOwn(trip.details, "total_amount"),
  ),
  "Hosted trip records must include source lineage and itemized charges",
);
assert.ok(
  trips.rows.some((trip) => trip.details.pickup_location),
  "Hosted trip records must expose recorded GPS endpoints",
);
if (trips.total > trips.rows.length) {
  assert.ok(
    trips.nextCursor,
    "Expected a continuation for the remaining trips",
  );
  const query = new URLSearchParams({
    cursor: JSON.stringify(trips.nextCursor),
  });
  const next = await request(`/api/trips?${query.toString()}`);
  const seen = new Set(trips.rows.map((trip) => trip.trip_id));
  assert.ok(
    next.rows.length > 0 && next.rows.every((trip) => !seen.has(trip.trip_id)),
    "The trip cursor must advance past the first page",
  );
}
for (const endpoint of ["pickup", "dropoff"]) {
  const activity = await request(`/api/trip-map?endpoint=${endpoint}`);
  assert.equal(activity.endpoint, endpoint);
  assert.equal(activity.matchingTrips, metadata.trips);
  assert.ok(
    activity.locatedTrips > 0 && activity.locatedTrips <= metadata.trips,
  );
  assert.equal(
    activity.cells.reduce((total, cell) => total + cell.trips, 0),
    activity.shownTrips,
  );
  assert.ok(activity.cells.every((cell) => cell.boundary.type === "Polygon"));
  if (!activity.truncated)
    assert.equal(activity.shownTrips, activity.locatedTrips);
}
const id = randomUUID();
const created = await request("/api/saved-views", "PUT", {
  id,
  title: "Deployed app verification",
  body: "Temporary app-identity persistence check",
  filters: { zip: "10001" },
  version: null,
});
try {
  let page = await request("/api/saved-views");
  const cursors = new Set();
  while (
    !page.rows.some((savedView) => savedView.id === id) &&
    page.nextCursor
  ) {
    const cursor = JSON.stringify(page.nextCursor);
    assert.ok(!cursors.has(cursor), "Saved-view continuation did not advance");
    cursors.add(cursor);
    page = await request(`/api/saved-views?${new URLSearchParams({ cursor })}`);
  }
  assert.ok(page.rows.some((savedView) => savedView.id === id));
} finally {
  await request(`/api/saved-views/${id}?version=${created.version}`, "DELETE");
}
const verifyGenie = async (mode, pollIntervalMs) => {
  const signal = AbortSignal.timeout(180_000);
  let operation;
  try {
    operation = await request(
      "/api/genie",
      "POST",
      {
        mode,
        content:
          "How many trips are in the configured trips table? Return a single total_trips column.",
      },
      signal,
    );
    assert.ok(operation.conversationId);
    assert.ok(operation.messageId);
    assert.ok(operation.grant, "Genie did not return a viewer grant");
    assert.equal(operation.mode ?? "chat", mode);
    const messagePath = `/api/genie/${encodeURIComponent(operation.conversationId)}/messages/${encodeURIComponent(operation.messageId)}`;
    const query = `?mode=${mode}`;
    const read = (path) =>
      request(`${path}${query}`, "GET", undefined, signal, operation.grant);
    let progress = await read(messagePath);
    while (progress.state === "pending") {
      await sleep(pollIntervalMs, undefined, { signal });
      progress = await read(messagePath);
    }
    assert.equal(progress.mode ?? "chat", mode);
    assert.equal(
      progress.state,
      "completed",
      `Genie returned ${progress.status}`,
    );
    const reply = await read(`${messagePath}/result`);
    assert.equal(reply.mode ?? "chat", mode);
    assert.ok(
      reply.queries.some((query) =>
        query.rows.some((row) =>
          row.some((cell) => Number(cell) === metadata.trips),
        ),
      ),
      "Genie SQL results did not contain the expected trip count",
    );
    return operation.conversationId;
  } catch (cause) {
    const reference = operation
      ? ` Conversation ${operation.conversationId}, message ${operation.messageId}.`
      : "";
    const problem = signal.aborted
      ? "Timed out after 3 minutes."
      : "Verification failed.";
    throw new Error(`Genie ${mode}: ${problem}${reference}`, { cause });
  }
};

const chatConversation = await verifyGenie("chat", 1_000);
const agentConversation = await verifyGenie("agent", 5_000);
assert.notEqual(agentConversation, chatConversation);
console.log(
  `Deployed app verified: SQL, pickup/drop-off GPS maps, Lakebase persistence, and grounded answers in Genie Chat and Agent mode using the app identity. ${appUrl}`,
);
