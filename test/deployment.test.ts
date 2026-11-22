import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gpsFixture } from "../client/test/gps-fixture.js";
import type { SavedView } from "../shared/saved-views.js";

const run = promisify(execFile);

for (const scenario of [
  null,
  "federated token",
  "delayed startup",
  "startup crash",
  "warehouse",
  "trips",
  "details",
  "trip cursor",
  "gps",
  "create",
  "list",
  "genie",
  "agent",
  "agent unavailable",
] as const) {
  const federated = scenario === "federated token";
  const delayedStartup = scenario === "delayed startup";
  const crashed = scenario === "startup crash";
  const failure = federated || delayedStartup ? null : scenario;
  const token = federated ? "test-federated-token" : "test-cli-token";
  const description = delayedStartup
    ? "waits for the deployed app to run before checking its APIs"
    : crashed
      ? "fails before calling app APIs when the deployed app crashes"
      : failure
        ? `fails on ${failure} errors despite RUNNING`
        : `checks SQL, paginated persistence, and both Genie modes with ${federated ? "a supplied token" : "the CLI login"}`;
  test(`hosted verification ${description}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "deployed-check-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let saved: SavedView | undefined;
    let created = 0;
    let deleted = 0;
    let followedCursor = false;
    let apiRequests = 0;
    const genieRequests: string[] = [];
    const cursor = {
      id: "472a6613-2337-4af1-a416-e9b6b61064dd",
      pinned: true,
      updatedAt: "2026-11-13T10:00:00.000001Z",
    };
    const server = createServer(async (request, response) => {
      apiRequests++;
      const url = new URL(request.url ?? "/", "http://localhost");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/metadata")
        return failure === "warehouse"
          ? reply({ error: { message: "Warehouse unavailable" } }, 503)
          : reply({ trips: 10 });
      if (url.pathname === "/api/overview")
        return reply({ summary: { trips: 10 } });
      if (url.pathname === "/api/trips") {
        if (failure === "trips")
          return reply({ error: { message: "Trips unavailable" } }, 503);
        if (url.searchParams.has("page"))
          return reply({ error: "Unsupported page parameter" }, 400);
        const next = url.searchParams.get("cursor");
        const tripCursor = {
          sort: "newest",
          filters: {},
          after: {
            trip_id: "trip-5",
            pickup_at: "2015-01-01 10:00:00",
            dropoff_at: "2015-01-01 10:10:00",
            pickup_zip: "10001",
            dropoff_zip: "Unknown",
            fare: 10,
            distance: 2,
          },
        };
        if (next !== null && next !== JSON.stringify(tripCursor))
          return reply({ error: "Invalid cursor" }, 400);
        return reply({
          total: 10,
          pageSize: 5,
          nextCursor: next === null ? tripCursor : null,
          rows: Array.from({ length: 5 }, (_, i) => ({
            trip_id: `trip-${(next === null || failure === "trip cursor" ? 1 : 6) + i}`,
            details:
              failure === "details"
                ? undefined
                : {
                    source_file: "yellow_tripdata_2015-01.csv.gz",
                    total_amount: 10,
                    pickup_location: { longitude: -73.99, latitude: 40.75 },
                  },
          })),
        });
      }
      if (url.pathname === "/api/trip-map") {
        if (failure === "gps")
          return reply({ error: { message: "GPS unavailable" } }, 503);
        const endpoint =
          url.searchParams.get("endpoint") === "dropoff" ? "dropoff" : "pickup";
        const activity = gpsFixture(endpoint);
        return reply({
          ...activity,
          matchingTrips: 10,
          locatedTrips: 8,
          shownTrips: 8,
          totalCells: 1,
          cells: [{ ...activity.cells[0], trips: 8 }],
        });
      }
      if (url.pathname === "/api/saved-views" && request.method === "PUT") {
        if (failure === "create")
          return reply({ error: { message: "Create failed" } }, 503);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        saved = {
          ...JSON.parse(Buffer.concat(chunks).toString()),
          version: 1,
        } as SavedView;
        created++;
        return reply(saved);
      }
      if (url.pathname === "/api/saved-views" && request.method === "GET") {
        if (failure === "list")
          return reply({ error: { message: "Listing unavailable" } }, 503);
        if (url.searchParams.has("cursor")) {
          assert.deepEqual(
            JSON.parse(url.searchParams.get("cursor") ?? ""),
            cursor,
          );
          followedCursor = true;
          return reply({ rows: saved ? [saved] : [], nextCursor: null });
        }
        // A newly created unpinned saved view can sit behind existing pinned saved views.
        return reply({ rows: [{ id: cursor.id }], nextCursor: cursor });
      }
      if (
        url.pathname.startsWith("/api/saved-views/") &&
        request.method === "DELETE"
      ) {
        assert.equal(url.pathname, `/api/saved-views/${saved?.id}`);
        assert.equal(url.searchParams.get("version"), String(saved?.version));
        deleted++;
        saved = undefined;
        return reply({ deleted: true });
      }
      if (url.pathname === "/api/genie" && request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { mode, conversationId, content } = JSON.parse(
          Buffer.concat(chunks).toString(),
        );
        assert.ok(mode === "chat" || mode === "agent");
        assert.equal(conversationId, undefined);
        assert.match(content, /total_trips/);
        genieRequests.push(`submit:${mode}`);
        if (mode === "agent" && failure === "agent unavailable")
          return reply(
            {
              error: {
                code: "genie_agent_mode_unavailable",
                message: "Agent mode is disabled in this Databricks workspace.",
              },
            },
            503,
          );
        return reply({
          conversationId: `conversation-${mode}`,
          messageId: `message-${mode}`,
          grant: `viewer-grant-${mode}`,
          ...(mode === "agent" ? { mode } : {}),
        });
      }
      if (url.pathname.startsWith("/api/genie/") && request.method === "GET") {
        const mode = url.searchParams.get("mode");
        assert.ok(mode === "chat" || mode === "agent");
        assert.equal(request.headers["x-genie-access"], `viewer-grant-${mode}`);
        const operation = {
          conversationId: `conversation-${mode}`,
          messageId: `message-${mode}`,
          ...(mode === "agent" ? { mode } : {}),
        };
        const path = `/api/genie/${operation.conversationId}/messages/${operation.messageId}`;
        if (url.pathname === `${path}/result`) {
          genieRequests.push(`result:${mode}`);
          const incorrectCount =
            mode === "chat" ? failure === "genie" : failure === "agent";
          return reply({
            ...operation,
            queries: [{ rows: [[incorrectCount ? "999" : "10"]] }],
          });
        }
        assert.equal(url.pathname, path);
        genieRequests.push(`poll:${mode}`);
        return reply({ ...operation, state: "completed", status: "COMPLETED" });
      }
      reply({ error: "Unexpected route" }, 404);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const responses = {
      "bundle summary": {
        resources: {
          apps: { app: { name: "configured-app", id: "deployed-app" } },
        },
      },
      "apps get": {
        app_status: crashed
          ? { state: "CRASHED", message: "Fixture failed to start" }
          : { state: "RUNNING" },
        url: `http://127.0.0.1:${address.port}`,
      },
      ...(federated || crashed
        ? {}
        : { "auth token": { access_token: token } }),
    };
    await writeFile(
      join(directory, "databricks"),
      `#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2);
if (args[0] === "bundle") {
  assert.deepEqual(args, ["bundle", "summary", "-t", "prod", "--force-pull", "-o", "json"]);
}
if (args[0] === "apps") {
  assert.deepEqual(args, ["apps", "get", "deployed-app", "-o", "json"]);
  const pollMarker = ${JSON.stringify(join(directory, "app-polled"))};
  if (${delayedStartup} && !existsSync(pollMarker)) {
    writeFileSync(pollMarker, "");
    console.log(JSON.stringify({ app_status: { state: "DEPLOYING" } }));
    process.exit(0);
  }
}
const response = responses[args.slice(0, 2).join(" ")];
assert.ok(response, "Unexpected CLI call");
console.log(JSON.stringify(response));
`,
      { mode: 0o700 },
    );
    const verification = run(
      process.execPath,
      [resolve("scripts/check-hosted-apis.mjs")],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          DATABRICKS_BUNDLE_TARGET: "prod",
          DATABRICKS_HOST: "https://workspace.invalid",
          DATABRICKS_APP_OAUTH_TOKEN: federated ? token : "",
        },
        timeout: delayedStartup ? 25_000 : 15_000,
      },
    );
    if (crashed)
      await assert.rejects(
        verification,
        /App deployed-app crashed during startup\. Fixture failed to start/,
      );
    else if (failure === "agent unavailable")
      await assert.rejects(verification, /genie_agent_mode_unavailable/);
    else if (failure === "agent")
      await assert.rejects(
        verification,
        /Genie SQL results did not contain the expected trip count/,
      );
    else if (failure) await assert.rejects(verification);
    else
      assert.match(
        (await verification).stdout,
        /grounded answers in Genie Chat and Agent mode/,
      );
    if (crashed) assert.equal(apiRequests, 0);
    if (delayedStartup)
      assert.match(
        (await verification).stdout,
        /Waiting for app deployed-app \(state: DEPLOYING\)/,
      );
    assert.equal(
      created,
      [
        "warehouse",
        "startup crash",
        "trips",
        "details",
        "trip cursor",
        "gps",
        "create",
      ].includes(failure ?? "")
        ? 0
        : 1,
    );
    assert.equal(
      deleted,
      created,
      "verification must clean up its temporary saved view on success and failure",
    );
    const checksGenie =
      failure === null || failure.startsWith("agent") || failure === "genie";
    assert.equal(followedCursor, checksGenie);
    assert.deepEqual(
      genieRequests,
      checksGenie
        ? [
            "submit:chat",
            "poll:chat",
            "result:chat",
            ...(failure === "genie" ? [] : ["submit:agent"]),
            ...(failure === "agent unavailable" || failure === "genie"
              ? []
              : ["poll:agent", "result:agent"]),
          ]
        : [],
    );
  });
}
