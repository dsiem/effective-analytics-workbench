import { test } from "node:test";
import type { TripComment } from "@dsiem/analytics-shared/trip-comments";
import { Dialog } from "@foldkit/ui";
import {
  click,
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
import { Message } from "../src/features/trips/messages";
import { fail, succeed } from "../src/lib/command-result";
import { app, open } from "./app-scene";
import { enrichedTrip as trip, tripSummaryFor } from "./trip-fixture";

const emit = (message: Message) =>
  Subscription.emit(Features.trips.toParentMessage(message));
const inspector = role("dialog", { name: "Record details" });

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

  const inspecting = app.update(
    open("/trips"),
    Features.trips.toParentMessage(
      Message.InspectComments({ trip: recent.trip }),
    ),
  ).model;
  scene(
    app,
    given(inspecting),
    Mount.resolve(
      Dialog.AcquireResources,
      Dialog.Message.SucceededAcquireResources(),
    ),
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
