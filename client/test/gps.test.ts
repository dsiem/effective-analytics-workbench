import assert from "node:assert/strict";
import { test } from "node:test";
import { Option } from "effect";
import { AsyncData, Url } from "foldkit";
import { pageContext } from "../src/app/analysis-context";
import * as Features from "../src/app/features";
import { init, update } from "../src/app/update";
import { Message as GenieMessage } from "../src/features/genie/messages";
import { gpsContext } from "../src/features/gps/context";
import { jsonMap } from "../src/features/gps/dataset";
import { Message as M } from "../src/features/gps/messages";
import { dataKey, frameKey, init as initGps } from "../src/features/gps/model";
import { reloadGps, updateGps } from "../src/features/gps/update";
import { fail, succeed } from "../src/lib/command-result";
import { gpsFixture } from "./gps-fixture";

const summary = (endpoint: "pickup" | "dropoff" = "pickup") =>
  jsonMap(gpsFixture(endpoint)).summary;

test("same-query retries reject old dataset and render revisions", () => {
  const previous = initGps();
  const location = { query: "", filters: {} };
  const current = reloadGps(previous, location).model;
  for (const message of [
    M.LoadedGps({
      key: dataKey("", "pickup", previous.revision),
      result: succeed(summary()),
    }),
    M.GpsReady({
      key: frameKey("", "pickup", null, previous.revision),
      error: "",
    }),
  ])
    assert.equal(updateGps(current, message, location).model, current);
});

test("stale endpoint, filter and render responses cannot replace the active GPS map", () => {
  const query = "from=2016-01-10";
  const model = { ...initGps(), endpoint: "dropoff" as const };
  for (const message of [
    M.LoadedGps({
      key: dataKey(query, "pickup"),
      result: succeed(summary()),
    }),
    M.LoadedGps({
      key: dataKey("", "dropoff"),
      result: succeed(summary("dropoff")),
    }),
    M.GpsReady({ key: dataKey(query, "pickup"), error: "Old renderer failed" }),
  ])
    assert.deepEqual(
      updateGps(model, message, { query, filters: { from: "2016-01-10" } })
        .model,
      model,
    );
});

test("selection and Genie use the same GPS endpoint, counts and area without copying all geometry", () => {
  const activity = summary("dropoff");
  const model = {
    ...initGps(),
    endpoint: "dropoff" as const,
    activity: AsyncData.succeed(activity),
  };
  const cell = activity.cells[0];
  assert.ok(cell);
  const selected = updateGps(model, M.GpsSelect({ id: cell.id }), {
    query: "",
    filters: {},
  }).model;
  const context = gpsContext(selected, { zip: "10001" });
  const data = JSON.parse(context.data ?? "{}");
  assert.deepEqual(data.query.filters, { zip: "10001" });
  assert.equal(data.endpoint, "dropoff");
  assert.equal(data.resolution, 10);
  assert.equal(data.locatedTrips, 80);
  assert.equal(data.selectedArea.trips, 60);
  assert.equal(data.selectedArea.id, cell.id);
  assert.equal(data.selectedArea.boundary, undefined);
  const cleared = updateGps(selected, M.GpsSelect({ id: null }), {
    query: "",
    filters: {},
  });
  assert.ok(Option.isNone(cleared.model.selected));
});

test("leaving the GPS page ignores its late responses and keeps the current page context", () => {
  const model = init(
    Option.getOrThrow(Url.fromString("http://localhost/trips")),
  ).model;
  const result = update(
    model,
    Features.gps.toParentMessage(
      M.LoadedGps({
        key: dataKey("", "pickup"),
        result: succeed(summary()),
      }),
    ),
  );
  assert.deepEqual(result.model, model);
  assert.equal(pageContext(result.model).page, "trips");
});

test("an old map reply keeps pinned Genie context until the map scope changes", () => {
  const initialized = init(
    Option.getOrThrow(Url.fromString("http://localhost/trip-map")),
  ).model;
  const activity = summary();
  const currentReply = Features.gps.toParentMessage(
    M.LoadedGps({
      key: dataKey("", "pickup", initialized.gpsState.revision),
      result: succeed(activity),
    }),
  );
  const loaded = update(initialized, currentReply).model;
  const context = { page: "map" as const, title: "Pinned map context" };
  const pinned = update(
    loaded,
    Features.genie.toParentMessage(
      GenieMessage.OpenGenie({ question: null, context }),
    ),
  ).model;
  const stale = update(
    pinned,
    Features.gps.toParentMessage(
      M.LoadedGps({
        key: dataKey("", "pickup", pinned.gpsState.revision - 1),
        result: fail("old failure"),
      }),
    ),
  );
  assert.deepEqual(stale.model.genieState.genieSelection, Option.some(context));
  assert.equal(stale.model, pinned);
  const rendered = update(
    stale.model,
    Features.gps.toParentMessage(
      M.GpsReady({
        key: frameKey("", "pickup", null, pinned.gpsState.revision),
        error: "",
      }),
    ),
  ).model;
  assert.deepEqual(rendered.genieState.genieSelection, Option.some(context));
  const cell = activity.cells[0];
  assert.ok(cell);
  const changed = update(
    rendered,
    Features.gps.toParentMessage(M.GpsSelect({ id: cell.id })),
  );
  assert.deepEqual(changed.model.gpsState.selected, Option.some(cell.id));
  assert.ok(Option.isNone(changed.model.genieState.genieSelection));
});
