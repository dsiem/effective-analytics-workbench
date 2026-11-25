import assert from "node:assert/strict";
import { test } from "node:test";
import { Dialog } from "@foldkit/ui";
import { Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AsyncData, Url } from "foldkit";
import { given, message, model, story } from "foldkit/story";
import { AppApi } from "@dsiem/analytics-shared/api";
import { TripCommentInput } from "@dsiem/analytics-shared/trip-comments";
import { Message as AppMessage } from "../src/app/message";
import { Message as NavigationMessage } from "../src/app/navigation";
import * as Features from "../src/app/features";
import { init, update } from "../src/app/update";
import { overviewViewMessage } from "../src/app/view-messages";
import { Message as FilterMessage } from "../src/features/filters/messages";
import * as Filters from "../src/features/filters/model";
import { updateFilters } from "../src/features/filters/update";
import { Message as GenieMessage } from "../src/features/genie/messages";
import * as Genie from "../src/features/genie/model";
import { presentGenie, updateGenie } from "../src/features/genie/update";
import { Message as OverviewMessage } from "../src/features/overview/messages";
import * as Overview from "../src/features/overview/model";
import {
  reloadOverview,
  updateOverview,
} from "../src/features/overview/update";
import { Message as OverviewViewMessage } from "../src/features/overview/view-messages";
import { Message as SavedMessage } from "../src/features/saved-views/messages";
import * as SavedViews from "../src/features/saved-views/model";
import { updateSavedViews } from "../src/features/saved-views/update";
import { Message as TripMessage } from "../src/features/trips/messages";
import * as Trips from "../src/features/trips/model";
import { subscriptions } from "../src/features/trips/subscription";
import { reloadTrips, updateTrips } from "../src/features/trips/update";
import { ApiClient } from "../src/lib/api-client";
import { fail, succeed } from "../src/lib/command-result";
import { tripSummaryFor } from "./trip-fixture";

const open = (path: string) =>
  init(Option.getOrThrow(Url.fromString(`http://localhost${path}`)));
const app = (path: string) => open(path).model;

const navigatedTo = (
  location: Pick<
    ReturnType<typeof NavigationMessage.Navigated>,
    "path" | "query"
  >,
) => Features.navigation.toParentMessage(NavigationMessage.Navigated(location));

function runRequest(
  load: ReturnType<typeof init>,
  name: string,
  fetch: typeof globalThis.fetch,
) {
  const command = load.commands?.find((command) => command.name === name);
  assert.ok(command);
  return Effect.runPromise(
    command.effect.pipe(
      Effect.provideServiceEffect(
        ApiClient,
        Effect.gen(function* () {
          const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
          return yield* HttpApiClient.makeWith(AppApi, {
            httpClient,
            baseUrl: "http://fixture.test",
          });
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
}

const trip = {
  trip_id: "trip-1",
  pickup_at: "2016-01-01 10:00:00",
  dropoff_at: "2016-01-01 10:15:00",
  pickup_zip: "10001",
  dropoff_zip: "10019",
  distance: 2,
  fare: 12,
  duration: 15,
  details: {
    source_file: "test.csv",
    vendor_id: null,
    passenger_count: null,
    rate_code_id: null,
    store_and_fwd_flag: null,
    payment_type: null,
    pickup_location: null,
    dropoff_location: null,
    tip_amount: null,
    tolls_amount: null,
    extra: null,
    mta_tax: null,
    improvement_surcharge: null,
    total_amount: null,
  },
};

test("view intents are translated by the shell with their analysis scope intact", () => {
  const context = {
    page: "overview" as const,
    title: "Trips by pickup date",
    data: "[]",
  };
  const changed = update(
    app("/"),
    overviewViewMessage(
      OverviewViewMessage.Analyze({ context, question: "Explain these fares" }),
    ),
  );
  assert.equal(changed.model.genieState.genieOpen, true);
  assert.deepEqual(
    changed.model.genieState.genieSelection,
    Option.some(context),
  );
  assert.equal(changed.model.genieState.genieDraft, "Explain these fares");
  const picked = update(
    app("/trip-map"),
    Features.filters.toParentMessage(FilterMessage.PickZip({ zip: "10019" })),
  );
  assert.ok(
    picked.commands?.some(
      (command) => command.args?.href === "/trip-map?zip=10019",
    ),
  );
  const navigated = update(
    picked.model,
    navigatedTo({ path: "/trip-map", query: "zip=10019" }),
  );
  assert.equal(navigated.model.filtersState.filterDraft.zip, "10019");
});

test("Records completes an empty trip page", async () => {
  const httpClient = HttpClient.make((request, url) => {
    assert.equal(url.pathname, "/api/trips");
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          rows: [],
          nextCursor: null,
          hasMoreMatches: false,
        }),
      ),
    );
  });
  const { trips } = subscriptions;
  const start = reloadTrips(Trips.init(), {
    filters: {},
    sort: "newest",
  }).model;
  const deps = trips.modelToDependencies(start);
  const messages = await Effect.runPromise(
    trips.dependenciesToStream(deps).pipe(
      Stream.runCollect,
      Effect.provideServiceEffect(
        ApiClient,
        HttpApiClient.makeWith(AppApi, {
          httpClient,
          baseUrl: "http://fixture.test",
        }),
      ),
    ),
  );
  const loaded = messages.reduce(
    (model, message) => updateTrips(model, message).model,
    start,
  );
  assert.deepEqual(loaded.preview, { _tag: "Ready", rows: [], hasMore: false });
});

test("returning to a filter ignores batches and errors from its original stream", () => {
  const opened = open("/trips?zip=10001");
  const visit = (zip: string) =>
    navigatedTo({ path: "/trips", query: `zip=${zip}` });
  const changed = update(opened.model, visit("10002"));
  const returned = update(changed.model, visit("10001"));
  const data = { rows: [tripSummaryFor(trip)], hasMore: false };
  const trips = Features.trips.toParentMessage;
  const generation = returned.model.tripsState.loadGeneration;
  const oldGeneration = opened.model.tripsState.loadGeneration;
  story(
    update,
    given(returned.model),
    message(
      trips(
        TripMessage.TripBatchReceived({
          generation,
          rows: [tripSummaryFor(trip)],
        }),
      ),
    ),
    message(
      trips(
        TripMessage.TripBatchReceived({
          generation: oldGeneration,
          rows: [tripSummaryFor({ ...trip, trip_id: "old" })],
        }),
      ),
    ),
    message(
      trips(
        TripMessage.TripPreviewFinished({
          generation: oldGeneration,
          result: { _tag: "Failed", error: "Timed out" },
        }),
      ),
    ),
    message(
      trips(
        TripMessage.TripPreviewFinished({
          generation,
          result: { _tag: "Complete", hasMore: false },
        }),
      ),
    ),
    model(({ tripsState }) => {
      assert.deepEqual(tripsState.preview, { _tag: "Ready", ...data });
    }),
  );
});

test("returning to an Overview filter keeps the fresh summary when the original load fails", () => {
  const opened = open("/?zip=10001");
  const visit = (zip: string) =>
    navigatedTo({ path: "/", query: `zip=${zip}` });
  const changed = update(opened.model, visit("10002"));
  const returned = update(changed.model, visit("10001"));
  const data = {
    summary: {
      trips: 17,
      revenue: 100,
      avg_fare: 6,
      avg_distance: 2,
      avg_duration: 10,
    },
    daily: [],
    hourly: [],
    zones: [],
    queriedAt: "2026-11-17T09:00:00Z",
  };
  const loaded = (
    change: ReturnType<typeof init>,
    result: ReturnType<typeof OverviewMessage.LoadedOverview>["result"],
  ) =>
    Features.overview.toParentMessage(
      OverviewMessage.LoadedOverview({
        generation: change.model.overviewState.loadGeneration,
        result,
      }),
    );
  story(
    update,
    given(returned.model),
    message(loaded(returned, succeed(data))),
    message(loaded(opened, fail("Original load timed out"))),
    model(({ overviewState }) => {
      assert.deepEqual(overviewState.overview, AsyncData.succeed(data));
    }),
  );
});

test("reopening the same trip keeps fresh comments when the original list arrives late", async () => {
  const inspect = Features.trips.toParentMessage(
    TripMessage.InspectComments({ trip }),
  );
  const opened = update(app("/trips"), inspect);
  const closed = update(
    opened.model,
    Features.trips.toParentMessage(TripMessage.CloseTrip()),
  );
  const reopened = update(closed.model, inspect);
  const note = {
    id: "00000000-0000-4000-8000-000000000001",
    trip,
    body: "Current note",
    author: null,
    created_at: "2026-11-17T09:00:00Z",
  };
  const reply = (model: ReturnType<typeof app>, rows: [typeof note] | []) =>
    Features.trips.toParentMessage(
      TripMessage.LoadedComments({
        tripId: trip.trip_id,
        generation: model.tripsState.commentLoadGeneration,
        result: succeed({ rows, nextCursor: null }),
      }),
    );
  const fresh = reply(reopened.model, [note]);
  const stale = reply(opened.model, []);
  story(
    update,
    given(reopened.model),
    message(fresh),
    message(stale),
    model(({ tripsState }) => {
      assert.deepEqual(
        Option.getOrUndefined(
          tripsState.inspector.pipe(
            Option.flatMap((inspector) => inspector.comments.data),
          ),
        )?.rows.map(({ body }) => body),
        ["Current note"],
      );
    }),
  );
});

test("lost comment responses replay the attempted payload until the draft is edited", async () => {
  let next = open("/trips");
  const send = (action: TripMessage) => {
    next = update(next.model, Features.trips.toParentMessage(action));
  };
  async function post() {
    send(TripMessage.PostComment());
    const reply = await runRequest(
      next,
      "PostComment",
      async (url, options) => {
        const payload = Schema.decodeUnknownSync(TripCommentInput)(
          await new Request(url, options).json(),
        );
        submissions.push(payload);
        throw new TypeError("Response lost");
      },
    );
    next = update(next.model, reply);
  }
  const detailReply = (record: typeof trip) =>
    TripMessage.LoadedTripDetails({
      tripId: record.trip_id,
      generation: next.model.tripsState.detailLoadGeneration,
      result: succeed(record),
    });
  const submissions: TripCommentInput[] = [];
  send(TripMessage.InspectTrip({ trip }));
  send(detailReply(trip));
  send(TripMessage.CommentChanged({ body: "First finding" }));
  await post();
  send(TripMessage.CloseTrip());
  send(TripMessage.InspectTrip({ trip: { ...trip, fare: 14 } }));
  const refreshedDetails = detailReply({ ...trip, fare: 14 });
  await post();
  const [first, retry] = submissions;
  assert.ok(first);
  assert.deepEqual(retry, first);
  send(TripMessage.CommentChanged({ body: "Edited finding" }));
  send(refreshedDetails);
  await post();
  const edited = submissions[2];
  assert.ok(edited);
  assert.notEqual(edited.id, first.id);
  assert.equal(edited.body, "Edited finding");
  assert.equal(edited.trip.fare, 14);
  assert.deepEqual(edited.trip.details, trip.details);
});

test("trip details ignore an earlier selection and retry independently", () => {
  const send = (model: ReturnType<typeof app>, action: TripMessage) =>
    update(model, Features.trips.toParentMessage(action)).model;
  const first = send(app("/trips"), TripMessage.InspectTrip({ trip }));
  const other = { ...trip, trip_id: "trip-2" };
  const opened = send(first, TripMessage.InspectTrip({ trip: other }));
  const reply = (model: typeof first, record: typeof trip, error = "") =>
    TripMessage.LoadedTripDetails({
      tripId: record.trip_id,
      generation: model.tripsState.detailLoadGeneration,
      result: error ? fail(error) : succeed(record),
    });
  const failed = send(opened, reply(opened, other, "Details timed out"));
  assert.equal(send(failed, reply(first, trip)), failed);
  const retry = send(failed, TripMessage.RetryTripDetails());
  assert.equal(
    retry.tripsState.commentLoadGeneration,
    opened.tripsState.commentLoadGeneration,
  );
  assert.deepEqual(
    Option.getOrUndefined(retry.tripsState.inspector)?.details,
    AsyncData.Loading(),
  );
  assert.deepEqual(
    Option.getOrUndefined(send(retry, reply(retry, other)).tripsState.inspector)
      ?.details,
    AsyncData.succeed(other),
  );
});

test("a completed focus command keeps the current model reference", () => {
  const initial = app("/");
  const result = update(initial, AppMessage.CompletedFocus());
  assert.ok(result.model === initial, "the completion returned a new model");
  assert.deepEqual(result.commands, []);
});

test("a standalone trip feature closes its inspector and ignores late comments", () => {
  const opened = updateTrips(Trips.init(), TripMessage.InspectTrip({ trip }));
  assert.equal(opened.model.inspectorDialog.isOpen, true);
  const closed = updateTrips(
    opened.model,
    TripMessage.GotInspectorDialogMessage({
      message: Dialog.Message.RequestedClose(),
    }),
  );
  assert.ok(Option.isNone(closed.model.inspector));
  assert.equal(closed.model.inspectorDialog.isOpen, false);
  assert.ok(closed.commands?.some((command) => command.name === "CloseDialog"));
  const late = updateTrips(
    closed.model,
    TripMessage.LoadedComments({
      tripId: trip.trip_id,
      generation: opened.model.commentLoadGeneration,
      result: succeed({ rows: [], nextCursor: null }),
    }),
  );
  assert.ok(Option.isNone(late.model.inspector));
  assert.equal(late.model.inspectorDialog.isOpen, false);
});

test("navigation retains the trip feature's dialog cleanup commands", () => {
  const opened = update(
    app("/trips"),
    Features.trips.toParentMessage(TripMessage.InspectTrip({ trip })),
  );
  const navigated = update(opened.model, navigatedTo({ path: "/", query: "" }));
  assert.ok(Option.isNone(navigated.model.tripsState.inspector));
  assert.equal(navigated.model.tripsState.inspectorDialog.isOpen, false);
  assert.ok(
    navigated.commands?.some((command) => command.name === "CloseDialog"),
  );
});

test("sort URLs survive reload and history; saved views restore global scope with default sort", () => {
  const open = (path: string) =>
    init(Option.getOrThrow(Url.fromString(`http://localhost${path}`)));
  const tripLoad = (result: ReturnType<typeof init>) => {
    const { preview } = result.model.tripsState;
    return preview._tag === "Loading" ? preview.query : undefined;
  };
  const opened = open("/trips?zip=10001&sort=fare");
  assert.equal(tripLoad(opened)?.sort, "fare");
  const sorted = update(
    opened.model,
    Features.trips.toParentMessage(TripMessage.SortTrips({ sort: "distance" })),
  );
  assert.equal(tripLoad(sorted)?.sort, "distance");
  assert.ok(
    sorted.commands?.some(
      (command) => command.args?.href === "/trips?zip=10001&sort=distance",
    ),
  );
  const arrived = update(
    sorted.model,
    navigatedTo({ path: "/trips", query: "zip=10001&sort=distance" }),
  );
  assert.equal(
    arrived.model.tripsState.loadGeneration,
    sorted.model.tripsState.loadGeneration,
  );
  const back = update(
    sorted.model,
    navigatedTo({ path: "/trips", query: "zip=10001&sort=fare" }),
  );
  assert.equal(tripLoad(back)?.sort, "fare");
  const applied = update(
    back.model,
    Features.filters.toParentMessage(FilterMessage.ApplyFilters()),
  );
  assert.ok(
    applied.commands?.some(
      (command) => command.args?.href === "/trips?zip=10001&sort=fare",
    ),
  );
  const restoring = update(
    back.model,
    Features.savedViews.toParentMessage(
      SavedMessage.RestoreView({
        savedView: {
          id: "00000000-0000-4000-8000-000000000003",
          title: "January pickups",
          body: "",
          filters: { from: "2016-01-01" },
          version: 1,
          pinned: false,
          created_at: "2026-11-16T10:00:00Z",
          updated_at: "2026-11-16T10:00:00Z",
        },
      }),
    ),
  );
  assert.ok(
    restoring.commands?.some(
      (command) => command.args?.href === "/trips?from=2016-01-01",
    ),
  );
  const restored = update(
    back.model,
    navigatedTo({ path: "/trips", query: "from=2016-01-01" }),
  );
  assert.equal(tripLoad(restored)?.sort, "newest");
  assert.equal(restored.model.filtersState.filterDraft.from, "2016-01-01");
  assert.equal(tripLoad(open("/trips?sort=invalid"))?.sort, "newest");
  const repeated = tripLoad(
    open("/trips?zip=10002&sort=fare&zip=10001&sort=distance"),
  );
  assert.equal(repeated?.sort, "fare");
  assert.deepEqual(repeated?.filters, { zip: "10001" });
});

test("comment counts from an older trip window cannot replace the current rows' counts", () => {
  const loaded = (model: Trips.Model) => {
    const response = updateTrips(
      model,
      TripMessage.TripBatchReceived({
        generation: model.loadGeneration,
        rows: [tripSummaryFor(trip)],
      }),
    );
    return updateTrips(
      response.model,
      TripMessage.TripsScrolled({
        viewport: {
          firstRow: 0,
          visibleEnd: 1,
          tabStart: 0,
          tabEnd: 1,
          rowHeight: 44,
        },
        generation: model.loadGeneration,
      }),
    ).model;
  };
  const start = (model: Trips.Model) =>
    reloadTrips(model, { filters: {}, sort: "newest" }).model;
  const initial = loaded(start(Trips.init()));
  const reset = updateTrips(initial, TripMessage.ResetTrips()).model;
  const refreshed = loaded(start(reset));
  const current = updateTrips(
    refreshed,
    TripMessage.LoadedCommentCounts({
      version: refreshed.commentCounts.version,
      result: succeed({ [trip.trip_id]: 3 }),
    }),
  ).model;
  const late = updateTrips(
    current,
    TripMessage.LoadedCommentCounts({
      version: initial.commentCounts.version,
      result: succeed({ [trip.trip_id]: 0 }),
    }),
  ).model;
  assert.equal(late.commentCounts.data?.[trip.trip_id], 3);
});

test("comment-count denial needs an explicit retry and uses the current window", () => {
  const start = reloadTrips(Trips.init(), { filters: {}, sort: "newest" });
  const rows = Array.from({ length: 100 }, (_, index) => ({
    ...trip,
    trip_id: `trip-${index}`,
  }));
  const top = {
    firstRow: 0,
    visibleEnd: 10,
    tabStart: 0,
    tabEnd: 10,
    rowHeight: 44,
  };
  const loaded = updateTrips(
    start.model,
    TripMessage.TripBatchReceived({
      generation: start.model.loadGeneration,
      rows: rows.map(tripSummaryFor),
    }),
  );
  const atTop = updateTrips(
    loaded.model,
    TripMessage.TripsScrolled({
      viewport: top,
      generation: loaded.model.loadGeneration,
    }),
  );
  assert.ok(atTop.commands?.some(({ name }) => name === "LoadCommentCounts"));
  const scrolled = updateTrips(
    atTop.model,
    TripMessage.TripsScrolled({
      viewport: {
        firstRow: 60,
        visibleEnd: 70,
        tabStart: 60,
        tabEnd: 70,
        rowHeight: 44,
      },
      generation: loaded.model.loadGeneration,
    }),
  );
  const failed = updateTrips(
    scrolled.model,
    TripMessage.LoadedCommentCounts({
      version: atTop.model.commentCounts.version,
      result: fail({
        _tag: "AccessDenied",
        message: "Permission is required",
      }),
    }),
  );
  assert.ok(!failed.commands?.some(({ name }) => name === "LoadCommentCounts"));
  const retry = updateTrips(failed.model, TripMessage.RetryCommentCounts());
  const current = retry.commands?.find(
    ({ name }) => name === "LoadCommentCounts",
  );
  assert.ok(current, "The current window received no count request");
  const ids = current.args?.tripIds;
  assert.ok(Array.isArray(ids));
  assert.ok(ids.includes("trip-60"));
  assert.ok(!ids.includes("trip-0"));

  const nextSearch = reloadTrips(failed.model, {
    filters: { zip: trip.pickup_zip },
    sort: "newest",
  }).model;
  const newRows = updateTrips(
    nextSearch,
    TripMessage.TripBatchReceived({
      generation: nextSearch.loadGeneration,
      rows: [tripSummaryFor(trip)],
    }),
  );
  const visible = updateTrips(
    newRows.model,
    TripMessage.TripsScrolled({
      generation: nextSearch.loadGeneration,
      viewport: top,
    }),
  );
  assert.deepEqual(
    visible.commands?.find(({ name }) => name === "LoadCommentCounts")?.args
      ?.tripIds,
    [trip.trip_id],
    "A new Records search should request counts without manual retry",
  );
});

test("analysis links distinguish valid, malformed, and absent run IDs", () => {
  const linked = app("/analysis?zip=invalid&run=123&run=invalid");
  assert.equal(
    Option.getOrUndefined(linked.analysisRunsState.selected)?.id,
    123,
  );
  assert.equal(linked.analysisRunsState.invalidLink, false);
  const malformed = update(
    linked,
    navigatedTo({ path: "/analysis", query: "run=01" }),
  ).model;
  assert.ok(Option.isNone(malformed.analysisRunsState.selected));
  assert.equal(malformed.analysisRunsState.invalidLink, true);
  const absent = update(
    malformed,
    navigatedTo({ path: "/analysis", query: "" }),
  ).model;
  assert.ok(Option.isNone(absent.analysisRunsState.selected));
  assert.equal(absent.analysisRunsState.invalidLink, false);
});

test("saved views own editor dismissal and prevent closing an in-flight save", () => {
  const context = { filters: {} };
  const created = updateSavedViews(
    SavedViews.init(),
    SavedMessage.CreatedSavedView({ id: "draft" }),
    context,
  );
  assert.equal(created.model.dialogs.savedView.isOpen, true);
  const named = updateSavedViews(
    created.model,
    SavedMessage.SavedViewChanged({ field: "title", value: "My view" }),
    context,
  );
  const saving = updateSavedViews(
    named.model,
    SavedMessage.SaveSavedView(),
    context,
  );
  for (const message of [
    SavedMessage.CloseSavedView(),
    SavedMessage.GotSavedViewDialogMessage({
      message: Dialog.Message.RequestedClose(),
    }),
  ]) {
    const blocked = updateSavedViews(saving.model, message, context);
    assert.equal(Option.getOrUndefined(blocked.model.editor)?.saving, true);
    assert.equal(blocked.model.dialogs.savedView.isOpen, true);
  }
  const failed = updateSavedViews(
    saving.model,
    SavedMessage.SavedViewSaved({ result: fail("Try again") }),
    context,
  );
  const closed = updateSavedViews(
    failed.model,
    SavedMessage.CloseSavedView(),
    context,
  );
  assert.ok(Option.isNone(closed.model.editor));
  assert.equal(closed.model.dialogs.savedView.isOpen, false);
});

test("saved views keep deletion open during a write and close it after success", () => {
  const context = { filters: {} };
  const savedView = {
    id: "8aa0cc1a-6033-4fd0-9a61-908958570382",
    title: "View",
    body: "",
    filters: {},
    version: 1,
    pinned: false,
    created_at: "",
    updated_at: "",
  };
  const opened = updateSavedViews(
    SavedViews.init(),
    SavedMessage.DeleteSavedView({ savedView }),
    context,
  );
  assert.equal(opened.model.dialogs.delete.isOpen, true);
  const busy = updateSavedViews(
    opened.model,
    SavedMessage.ConfirmDelete(),
    context,
  );
  for (const message of [
    SavedMessage.CloseDelete(),
    SavedMessage.GotDeleteDialogMessage({
      message: Dialog.Message.RequestedClose(),
    }),
  ]) {
    const blocked = updateSavedViews(busy.model, message, context);
    assert.equal(
      Option.getOrUndefined(blocked.model.deleting)?.id,
      savedView.id,
    );
    assert.equal(blocked.model.dialogs.delete.isOpen, true);
  }
  const deleted = updateSavedViews(
    busy.model,
    SavedMessage.MutatedSavedView({
      result: succeed({ removed: true }),
    }),
    context,
  );
  assert.ok(Option.isNone(deleted.model.deleting));
  assert.equal(deleted.model.dialogs.delete.isOpen, false);
});

test("Genie owns its modal presentation without discarding the conversation on resize", () => {
  const context = {
    filters: {},
    context: { page: "trips" as const, title: "Trips" },
  };
  const opened = updateGenie(
    Genie.init(),
    GenieMessage.OpenGenie({ context: null, question: "Explain" }),
    context,
  );
  const mobile = presentGenie(opened.model, true);
  assert.equal(mobile.model.helperDialog.isOpen, true);
  const desktop = presentGenie(mobile.model, false);
  assert.equal(desktop.model.helperDialog.isOpen, false);
  assert.equal(desktop.model.genieOpen, true);
  assert.equal(desktop.model.genieDraft, "Explain");
  const remounted = presentGenie(desktop.model, true);
  const closed = updateGenie(
    remounted.model,
    GenieMessage.GotGenieDialogMessage({
      message: Dialog.Message.RequestedClose(),
    }),
    context,
  );
  assert.equal(closed.model.genieOpen, false);
  assert.equal(closed.model.helperDialog.isOpen, false);
});

test("Genie submits the filters and pinned chart from Send after navigation", async () => {
  const chart = {
    page: "overview" as const,
    title: "Pinned fare chart",
    data: "[]",
  };
  const pinned = update(
    app("/?zip=10001"),
    Features.genie.toParentMessage(
      GenieMessage.OpenGenie({ context: chart, question: null }),
    ),
  ).model;
  const sent = update(
    pinned,
    Features.genie.toParentMessage(
      GenieMessage.SendQuestion({ question: "Explain these fares" }),
    ),
  );
  const navigated = update(
    sent.model,
    navigatedTo({ path: "/trips", query: "zip=10002" }),
  ).model;
  const created = await runRequest(sent, "CreateQuestion", async () => {
    assert.fail("Creating a turn should not make a request");
  });
  const submitting = update(navigated, created);
  let payload: unknown;
  await runRequest(submitting, "SubmitQuestion", async (input, options) => {
    const request = new Request(input, options);
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/api/genie");
    payload = await request.json();
    return Response.json({
      conversationId: "conversation",
      messageId: "message",
    });
  });
  assert.deepEqual(payload, {
    content: "Explain these fares",
    filters: { zip: "10001" },
    context: chart,
  });
});

test("Genie resumes restored reads without replaying conversation submissions", () => {
  const context = {
    filters: {},
    context: { page: "genie" as const, title: "Analysis" },
  };
  const operation = { conversationId: "conversation", messageId: "message" };
  const restored = updateGenie(
    Genie.init(),
    GenieMessage.RestoredConversation({
      turns: [
        { id: "waiting", question: "First", state: "waiting", operation },
        {
          id: "retrieving",
          question: "Second",
          state: "retrieving",
          operation,
        },
        {
          id: "unknown",
          question: "Third",
          state: "submission-unknown",
          error: "Response lost",
        },
      ],
      persistenceError: "",
    }),
    context,
  );
  assert.equal(restored.model.turns.length, 3);
  assert.deepEqual(
    restored.commands?.map((command) => command.name),
    ["RetrieveQuestion"],
  );
});

test("overview accepts only the active response and requests selection invalidation", () => {
  const model = reloadOverview(Overview.init()).model;
  const stale = updateOverview(
    model,
    OverviewMessage.LoadedOverview({
      generation: model.loadGeneration - 1,
      result: fail("old failure"),
    }),
  );
  assert.equal(stale.model, model);
  assert.equal(stale.outMessage, undefined);
  const current = updateOverview(
    model,
    OverviewMessage.LoadedOverview({
      generation: model.loadGeneration,
      result: fail("Warehouse unavailable"),
    }),
  );
  assert.deepEqual(
    current.model.overview,
    AsyncData.fail("Warehouse unavailable"),
  );
  assert.deepEqual(current.outMessage, { _tag: "SelectionInvalidated" });
});

test("application opens Genie, dismisses mobile navigation, and requests focus", () => {
  const initial = app("/trips");
  const model = {
    ...initial,
    layout: { ...initial.layout, mobileNavigation: true },
  };
  const changed = update(
    model,
    Features.genie.toParentMessage(
      GenieMessage.OpenGenie({ context: null, question: null }),
    ),
  );
  assert.equal(changed.model.genieState.genieOpen, true);
  assert.equal(changed.model.layout.mobileNavigation, false);
  assert.ok(changed.commands?.some((command) => command.name === "Focus"));
});

test("invalid draft filters report an error without requesting navigation", () => {
  const result = updateFilters(
    {
      ...Filters.init(),
      filterDraft: { from: "2016-02-20", to: "2016-01-10", zip: "" },
      error: "",
    },
    FilterMessage.ApplyFilters(),
    { filters: { zip: "10001" }, metadata: null },
  );
  assert.equal(result.outMessage, undefined);
  assert.match(result.model.error, /start date must be on or before/);
});
