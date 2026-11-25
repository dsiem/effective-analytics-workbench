import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { GenieContext } from "@dsiem/analytics-shared/genie";
import type { Overview } from "@dsiem/analytics-shared/overview";
import {
  dailyChartContext,
  hourlyChartContext,
  overviewContext,
  zonesChartContext,
} from "../src/features/overview/context";
import { init } from "../src/features/overview/model";

const overview: Overview = {
  summary: {
    trips: 730,
    revenue: 7300,
    avg_fare: 10,
    avg_distance: 1,
    avg_duration: 10,
  },
  daily: Array.from({ length: 730 }, (_, index) => ({
    day: new Date(Date.UTC(2016, 0, 1 + index)).toISOString().slice(0, 10),
    trips: 1,
    revenue: 10,
  })),
  hourly: [],
  zones: [],
  queriedAt: "2018-01-01T00:00:00.000Z",
};

function contexts(data: Overview) {
  return [
    overviewContext({
      ...init(),
      overview: { data, loading: false, error: "" },
    }),
    dailyChartContext("Trips by pickup date", data, "trips"),
  ];
}

test("page and chart Genie snapshots include every fitting day and identify the coverage of longer series", () => {
  for (const rows of [overview.daily.slice(0, 60), overview.daily]) {
    for (const context of contexts({ ...overview, daily: rows })) {
      assert.ok(Schema.is(GenieContext)(context));
      const snapshot = JSON.parse(context.data ?? "");
      const kept = snapshot.daily.length;
      if (rows.length === 60) assert.equal(kept, rows.length);
      else assert.ok(kept > 0 && kept < rows.length);
      assert.deepEqual(snapshot.daily, rows.slice(-kept));
      assert.equal(snapshot.dailyCoverage.recordedDays, rows.length);
      assert.equal(snapshot.dailyCoverage.from, rows[0]?.day);
      assert.equal(snapshot.dailyCoverage.to, rows.at(-1)?.day);
    }
  }
});

test("oversized overview fields still produce a valid summary for Genie", () => {
  const data = { ...overview, queriedAt: "x".repeat(25_000) };
  for (const context of [
    ...contexts(data),
    hourlyChartContext(data),
    zonesChartContext(data),
  ]) {
    assert.ok(Schema.is(GenieContext)(context));
    assert.deepEqual(JSON.parse(context.data ?? ""), {
      scope: "summary-only",
      summary: overview.summary,
      recordedDays: overview.daily.length,
    });
  }
});
