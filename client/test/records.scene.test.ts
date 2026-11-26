import { test } from "node:test";
import type { TripComment } from "@dsiem/analytics-shared/trip-comments";
import { Dialog } from "@foldkit/ui";
import {
  click,
  Command,
  expect,
  given,
  Mount,
  role,
  scene,
  Subscription,
  text,
  within,
} from "foldkit/scene";
import * as Features from "../src/app/features";
import { LoadCommentCounts } from "../src/features/trips/commands";
import { Message } from "../src/features/trips/messages";
import { RecordsViewport } from "../src/features/trips/viewport-dom";
import { fail, succeed } from "../src/lib/command-result";
import { app, open } from "./app-scene";
import { enrichedTrip as trip, tripSummaryFor } from "./trip-fixture";

const emit = (message: Message) =>
  Subscription.emit(Features.trips.toParentMessage(message));
const firstPage = [
  emit(
    Message.TripBatchReceived({ generation: 1, rows: [tripSummaryFor(trip)] }),
  ),
  Mount.resolve(
    RecordsViewport,
    Message.TripsScrolled({
      generation: 1,
      viewport: {
        firstRow: 0,
        visibleEnd: 20,
        tabStart: 0,
        tabEnd: 20,
        rowHeight: 36,
      },
    }),
  ),
  Command.resolve(
    LoadCommentCounts({ version: 1, tripIds: [trip.trip_id] }),
    Message.LoadedCommentCounts({
      version: 1,
      result: succeed({ [trip.trip_id]: 0 }),
    }),
  ),
];
const finished = emit(
  Message.TripPreviewFinished({
    generation: 1,
    result: { _tag: "Complete", hasMore: false },
  }),
);
const inspector = role("dialog", { name: "Record details" });
const openInspector = [
  click(role("button", { name: /^Details and comments for trip/ })),
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
  Mount.resolve(
    Dialog.AcquireResources,
    Dialog.Message.SucceededAcquireResources(),
  ),
];

test("Records shows the first page while the continuation is pending", () => {
  const second = { ...tripSummaryFor(trip), trip_id: "second", fare: 37 };
  const records = role("table", { name: "Matching trips" });
  const cell = (name: string) => within(records, role("cell", { name }));
  scene(
    app,
    given(open("/trips")),
    ...firstPage,
    expect(cell("$12.00")).toExist(),
    expect(text("1 loaded")).toExist(),
    expect(cell("$37.00")).toBeAbsent(),
    emit(Message.TripBatchReceived({ generation: 1, rows: [second] })),
    Command.resolve(
      LoadCommentCounts({ version: 2, tripIds: [second.trip_id] }),
      Message.LoadedCommentCounts({
        version: 2,
        result: succeed({ [second.trip_id]: 0 }),
      }),
    ),
    finished,
    expect(cell("$37.00")).toExist(),
    expect(text("2 trips")).toExist(),
  );
});

test("the inspector shows payment, full charge and recorded source details", () => {
  scene(
    app,
    given(open("/trips")),
    ...firstPage,
    finished,
    ...openInspector,
    emit(
      Message.LoadedTripDetails({
        tripId: trip.trip_id,
        generation: 1,
        result: succeed(trip),
      }),
    ),
    expect(inspector).toContainText("Cash"),
    expect(inspector).toContainText("$15.80"),
    expect(inspector).toContainText("40.75000, -73.99000"),
    expect(inspector).toContainText("40.76000, -73.98000"),
    expect(inspector).toContainText("yellow_tripdata_2016-01.csv.gz"),
  );
});

test("retrying older comments preserves the thread through a failed page", () => {
  const recent: TripComment = {
    id: "00000000-0000-4000-8000-000000000001",
    trip: tripSummaryFor(trip),
    author: null,
    body: "Recent comment",
    created_at: "2026-11-14T10:00:00Z",
  };
  const older: TripComment = {
    ...recent,
    id: "00000000-0000-4000-8000-000000000002",
    body: "Older comment",
    created_at: "2026-11-14T09:00:00Z",
  };
  const loaded = (
    generation: number,
    result: ReturnType<typeof Message.LoadedComments>["result"],
  ) =>
    emit(Message.LoadedComments({ tripId: trip.trip_id, generation, result }));
  const comments = within(inspector, role("list", { name: "Record comments" }));
  const recentComment = within(comments, text(recent.body));
  const olderComment = within(comments, text(older.body));
  const loadOlder = within(
    inspector,
    role("button", { name: "Load older comments" }),
  );
  const loading = within(inspector, role("button", { name: "Loading…" }));
  const alert = within(inspector, role("alert"));
  const outage = "Try loading older comments again.";

  scene(
    app,
    given(open("/trips")),
    ...firstPage,
    finished,
    ...openInspector,
    loaded(
      1,
      succeed({
        rows: [recent],
        nextCursor: { id: recent.id, createdAt: "2026-11-14T10:00:00.000000Z" },
      }),
    ),
    click(loadOlder),
    expect(loading).toBeDisabled(),
    expect(recentComment).toExist(),
    loaded(2, fail(outage)),
    expect(alert).toHaveText(outage),
    expect(recentComment).toExist(),
    expect(olderComment).toBeAbsent(),
    click(
      within(inspector, role("button", { name: "Retry loading comments" })),
    ),
    expect(loading).toBeDisabled(),
    loaded(3, succeed({ rows: [older], nextCursor: null })),
    expect(alert).toBeAbsent(),
    expect(recentComment).toExist(),
    expect(olderComment).toExist(),
    expect(loadOlder).toBeAbsent(),
  );
});
