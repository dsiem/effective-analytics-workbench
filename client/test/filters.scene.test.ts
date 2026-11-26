import assert from "node:assert/strict";
import { test } from "node:test";
import {
  click,
  Command,
  expect,
  given,
  label,
  Mount,
  role,
  scene,
  text,
  type,
  within,
} from "foldkit/scene";
import { pendingOverview } from "../src/features/overview/subscription";
import { subscriptions as trips } from "../src/features/trips/subscription";
import { GpsMount, RefreshGps } from "../src/features/gps/mount";
import { Message as GpsMessage } from "../src/features/gps/messages";
import {
  app,
  followNavigation,
  navigated,
  open,
  withDataset,
} from "./app-scene";

const apply = role("button", { name: "Apply" });
const reset = role("button", { name: "Reset" });
const save = role("button", { name: "Save view" });
const start = label("Pickup start date");
const end = label("Pickup end date");
const zip = label("Pickup ZIP code");
const invalid = role("heading", { name: "Invalid Explore filters" });
const filterAlert = within(role("form", { name: "Filters" }), role("alert"));

const invalidQueries = [
  "from=2016-02-01&to=2016-01-01",
  "from=2016-02-30",
  "zip=invalid",
];

for (const [path, heading] of [
  ["/", "Trip overview"],
  ["/trips", "Trip records"],
  ["/trip-map", "Trip hotspots"],
  ["/genie", "Genie"],
] as const) {
  for (const query of invalidQueries) {
    test(`${path} blocks invalid filters (${query}) until they are cleared`, () => {
      const model = open(`${path}?${query}`);
      assert.equal(
        pendingOverview(model.overviewState, model.location.filters)._tag,
        "None",
      );
      assert.equal(
        trips.trips.modelToDependencies(model.tripsState).request,
        null,
      );
      scene(
        app,
        given(model),
        expect(invalid).toExist(),
        expect(role("alert")).toContainText(
          "start date must be on or before the end date",
        ),
        Mount.expectNone(),
        click(role("button", { name: "Clear invalid filters" })),
        ...followNavigation(path),
        expect(invalid).toBeAbsent(),
        expect(role("heading", { name: heading })).toExist(),
        ...(path === "/trip-map"
          ? [
              Command.resolve(RefreshGps, GpsMessage.CompletedRefreshGps()),
              Mount.resolve(
                GpsMount,
                GpsMessage.GpsReady({ key: '["","pickup",null,1]', error: "" }),
              ),
            ]
          : []),
      );
    });
  }
}

test("navigation carries invalid filters until the user fixes them", () => {
  scene(
    app,
    given(open("/trips?zip=invalid")),
    expect(role("link", { name: "Trip overview" })).toHaveAttr(
      "href",
      "/?zip=invalid",
    ),
    navigated("/?zip=invalid"),
    expect(invalid).toExist(),
    type(zip, "10001"),
    click(apply),
    ...followNavigation("/?zip=10001"),
    expect(invalid).toBeAbsent(),
    expect(zip).toHaveValue("10001"),
  );
});

test("clearing both dates preserves the applied ZIP", () => {
  scene(
    app,
    given(withDataset("/trips?from=2016-01-10&to=2016-01-20&zip=10001")),
    type(start, ""),
    type(end, ""),
    click(apply),
    ...followNavigation("/trips?zip=10001"),
    expect(start).toHaveValue(""),
    expect(end).toHaveValue(""),
    expect(zip).toHaveValue("10001"),
  );
});

for (const [query, from, to] of [
  ["from=2016-01-10", "2016-01-10", ""],
  ["to=2016-02-20", "", "2016-02-20"],
] as const) {
  test(`an open date range survives a direct link (${query})`, () => {
    scene(
      app,
      given(withDataset(`/trips?${query}`)),
      expect(start).toHaveValue(from),
      expect(end).toHaveValue(to),
      expect(apply).toBeDisabled(),
    );
  });
}

test("dates outside the dataset are rejected and both boundaries are accepted", () => {
  scene(
    app,
    given(withDataset("/trips?zip=10001")),
    type(start, "2016-01-02"),
    type(end, "2016-02-26"),
    click(apply),
    Command.expectNone(),
    expect(filterAlert).toExist(),
    type(start, "2016-01-03"),
    type(end, "2016-02-25"),
    click(apply),
    ...followNavigation("/trips?from=2016-01-03&to=2016-02-25&zip=10001"),
    expect(filterAlert).toBeAbsent(),
    expect(apply).toBeDisabled(),
  );
});

test("reversed dates keep the applied records in place and show a validation error", () => {
  scene(
    app,
    given(withDataset("/trips?zip=10001")),
    type(start, "2016-02-20"),
    type(end, "2016-01-10"),
    click(apply),
    Command.expectNone(),
    expect(role("heading", { name: "Trip records" })).toExist(),
    expect(filterAlert).toContainText(
      "start date must be on or before the end date",
    ),
  );
});

test("reset clears unapplied edits even when All trips is already applied", () => {
  scene(
    app,
    given(open("/trips")),
    type(zip, "10002"),
    expect(text("Unapplied changes")).toExist(),
    expect(save).toBeDisabled(),
    click(reset),
    ...followNavigation("/trips"),
    expect(zip).toHaveValue(""),
    expect(text("Unapplied changes")).toBeAbsent(),
    expect(save).toBeEnabled(),
  );
});
