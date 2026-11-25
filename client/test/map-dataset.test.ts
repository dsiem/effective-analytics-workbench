import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  mapCellLimit,
  MapSummary,
  TripMap,
} from "@dsiem/analytics-shared/map-dataset";
import { jsonMap, pickedIndex } from "../src/features/gps/dataset";
import { gpsFixture } from "./gps-fixture";

test("map resources preserve cells and picking while keeping geometry out of summaries", () => {
  const fixture = gpsFixture();
  const resource = jsonMap(fixture);
  for (const [i, row] of fixture.cells.entries()) {
    const { boundary, ...summary } = row;
    assert.deepEqual(resource.cell(i), summary);
    assert.deepEqual(resource.ring(i), boundary.coordinates[0]);
    assert.equal(resource.index(row.id), i);
    assert.equal(pickedIndex(resource, "gps-cells", i), i);
  }
  assert.equal(pickedIndex(resource, "gps-cells", fixture.cells.length), -1);
  assert.equal(pickedIndex(resource, "gps-selection", 0), -1);
  assert.equal(pickedIndex(resource, "gps-cells", -1), -1);
  assert.equal(pickedIndex(resource, "gps-cells", NaN), -1);
  assert.ok(Schema.is(MapSummary)(resource.summary));
  assert.equal(JSON.stringify(resource.summary).includes("coordinates"), false);
});

test("map summaries stay bounded for empty and large datasets", () => {
  const fixture = gpsFixture();
  const empty = jsonMap({ ...fixture, cells: [] });
  assert.deepEqual(empty.summary.cells, []);
  assert.equal(empty.summary.loaded, 0);
  assert.equal(empty.cell(0), undefined);
  const first = fixture.cells[0];
  assert.ok(first);
  const rows = Array.from({ length: 6 }, (_, i) => ({
    ...first,
    id: `cell-${i}`,
  }));
  const data = jsonMap({ ...fixture, cells: rows });
  assert.equal(data.summary.cells.length, 5);
  assert.equal(data.summary.loaded, 6);
});

test("map resources reject duplicate identities", () => {
  const fixture = gpsFixture();
  const first = fixture.cells[0];
  assert.ok(first);
  assert.throws(
    () => jsonMap({ ...fixture, cells: [first, first] }),
    /Duplicate map cell/,
  );
});

test("the map API rejects responses over the cell limit", () => {
  const fixture = gpsFixture();
  const cell = fixture.cells[0];
  assert.ok(cell);
  assert.ok(Schema.is(TripMap)(fixture));
  assert.equal(
    Schema.is(TripMap)({
      ...fixture,
      cells: Array.from({ length: mapCellLimit + 1 }, () => cell),
    }),
    false,
  );
});
