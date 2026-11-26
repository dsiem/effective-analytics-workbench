import assert from "node:assert/strict";
import { test } from "node:test";
import { Option } from "effect";
import { pagePaths } from "@dsiem/analytics-shared/page-paths";
import {
  pageUrls,
  parseLocation,
  routePath,
  withTripSort,
} from "../src/app/route";

test("client route builders match the server's exact paths", () => {
  assert.deepEqual(pageUrls, pagePaths);
  for (const [tag, path] of Object.entries(pagePaths)) {
    const { route } = parseLocation(path, "");
    assert.equal(route._tag, tag);
    assert.equal(routePath(route), path);
  }
  for (const path of ["//", "//trips", "/trips/", "/analysis/123", "genie"]) {
    assert.deepEqual(parseLocation(path, "").route, { _tag: "NotFound", path });
  }
});

test("route query values keep their first occurrence while filters keep the last", () => {
  const query = "sort=fare&zip=10019&sort=distance&zip=10001";
  const trips = parseLocation("/trips", query);
  assert.deepEqual(trips.route, { _tag: "Trips", sort: "fare" });
  assert.deepEqual(trips.filters, Option.some({ zip: "10001" }));
  assert.equal(trips.query, query);
  assert.equal(withTripSort(query, "newest"), "zip=10019&zip=10001");

  assert.deepEqual(parseLocation("/analysis", "run=01&run=123").route, {
    _tag: "AnalysisRuns",
    run: { _tag: "InvalidRun" },
  });
  assert.deepEqual(parseLocation("/analysis", "run=%31%32%33&run=456").route, {
    _tag: "AnalysisRuns",
    run: { _tag: "SelectedRun", id: 123 },
  });
});

test("malformed Explore filters are distinct from an unfiltered link", () => {
  assert.deepEqual(parseLocation("/trips", "").filters, Option.some({}));
  for (const query of [
    "from=2016-02-01&to=2016-01-01",
    "from=2016-02-30",
    "zip=invalid",
  ]) {
    assert.deepEqual(
      parseLocation("/trips", query).filters,
      Option.none(),
      query,
    );
  }
});
