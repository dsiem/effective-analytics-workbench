import { test } from "node:test";
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
import { succeed } from "../src/lib/command-result";
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
  const dialog = role("dialog", { name: "Record details" });
  scene(
    app,
    given(open("/trips")),
    ...firstPage,
    finished,
    click(role("button", { name: /^Details and comments for trip/ })),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    Mount.resolve(
      Dialog.AcquireResources,
      Dialog.Message.SucceededAcquireResources(),
    ),
    emit(
      Message.LoadedTripDetails({
        tripId: trip.trip_id,
        generation: 1,
        result: succeed(trip),
      }),
    ),
    expect(dialog).toContainText("Cash"),
    expect(dialog).toContainText("$15.80"),
    expect(dialog).toContainText("40.75000, -73.99000"),
    expect(dialog).toContainText("40.76000, -73.98000"),
    expect(dialog).toContainText("yellow_tripdata_2016-01.csv.gz"),
  );
});
