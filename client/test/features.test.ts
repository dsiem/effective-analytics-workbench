import assert from "node:assert/strict";
import { test } from "node:test";
import { Dialog } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Url } from "foldkit";
import { given, message, model, story } from "foldkit/story";
import { AppApi } from "../../shared/api";
import { TripCommentInput } from "../../shared/trip-comments";
import { Message as AppMessage } from "../src/app/message";
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
import { updateTrips } from "../src/features/trips/update";
import { ApiClient } from "../src/lib/api-client";
import { tripCursorFor } from "./trip-fixture";

const open = (path: string) =>
  init(Option.getOrThrow(Url.fromString(`http://localhost${path}`)));
const app = (path: string) => open(path).model;

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
          return (yield* HttpApiClient.makeWith(AppApi, {
            httpClient,
            baseUrl: "http://fixture.test",
          })).app;
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
}

const respond = (
  load: ReturnType<typeof init>,
  name: string,
  response: Response,
) => runRequest(load, name, async () => response);

const originalTimeout = () =>
  Response.json(
    {
      error: { code: "workspace_timeout", message: "Original load timed out" },
    },
    { status: 504 },
  );

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
  assert.deepEqual(changed.model.genieState.genieSelection, context);
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
    AppMessage.Navigated({ path: "/trip-map", query: "zip=10019" }),
  );
  assert.equal(navigated.model.filtersState.filterDraft.zip, "10019");
});

test("returning to a filter keeps fresh trip results when the original load fails", async () => {
  const opened = open("/trips?zip=10001");
  const visit = (zip: string) =>
    AppMessage.Navigated({ path: "/trips", query: `zip=${zip}` });
  const changed = update(opened.model, visit("10002"));
  const returned = update(changed.model, visit("10001"));
  const data = { rows: [], total: 0, pageSize: 25, nextCursor: null };
  const fresh = await respond(returned, "LoadTrips", Response.json(data));
  const stale = await respond(opened, "LoadTrips", originalTimeout());
  story(
    update,
    given(returned.model),
    message(fresh),
    message(stale),
    model(({ tripsState }) => {
      assert.equal(tripsState.trips.error, "");
      assert.deepEqual(tripsState.trips.data, data);
    }),
  );
});

test("returning to an Overview filter keeps the fresh summary when the original load fails", async () => {
  const opened = open("/?zip=10001");
  const visit = (zip: string) =>
    AppMessage.Navigated({ path: "/", query: `zip=${zip}` });
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
  const fresh = await respond(returned, "LoadOverview", Response.json(data));
  const stale = await respond(opened, "LoadOverview", originalTimeout());
  story(
    update,
    given(returned.model),
    message(fresh),
    message(stale),
    model(({ overviewState }) => {
      assert.equal(overviewState.overview.error, "");
      assert.deepEqual(overviewState.overview.data, data);
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
  const fresh = await respond(
    reopened,
    "LoadComments",
    Response.json({ rows: [note], nextCursor: null }),
  );
  const stale = await respond(
    opened,
    "LoadComments",
    Response.json({ rows: [], nextCursor: null }),
  );
  story(
    update,
    given(reopened.model),
    message(fresh),
    message(stale),
    model(({ tripsState }) => {
      assert.deepEqual(
        tripsState.comments.data?.rows.map(({ body }) => body),
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
  const submissions: TripCommentInput[] = [];
  send(TripMessage.InspectTrip({ trip }));
  send(TripMessage.CommentChanged({ body: "First finding" }));
  await post();
  send(TripMessage.CloseTrip());
  send(TripMessage.InspectTrip({ trip: { ...trip, fare: 14 } }));
  await post();
  const [first, retry] = submissions;
  assert.ok(first);
  assert.deepEqual(retry, first);
  send(TripMessage.CommentChanged({ body: "Edited finding" }));
  await post();
  const edited = submissions[2];
  assert.ok(edited);
  assert.notEqual(edited.id, first.id);
  assert.equal(edited.body, "Edited finding");
  assert.equal(edited.trip.fare, 14);
});

test("an idle message keeps the current model reference", () => {
  const initial = app("/");
  const result = update(initial, AppMessage.Idle());
  assert.ok(result.model === initial, "Idle returned a new model");
  assert.deepEqual(result.commands, []);
});

test("a standalone trip feature closes its inspector and ignores late comments", () => {
  const opened = updateTrips(Trips.init(), TripMessage.InspectTrip({ trip }));
  assert.equal(opened.model.inspectorDialog.isOpen, true);
  const closed = updateTrips(
    opened.model,
    TripMessage.InspectorDialog({ message: Dialog.Message.RequestedClose() }),
  );
  assert.equal(closed.model.selectedTrip, null);
  assert.equal(closed.model.inspectorDialog.isOpen, false);
  assert.ok(closed.commands?.some((command) => command.name === "CloseDialog"));
  const late = updateTrips(
    closed.model,
    TripMessage.LoadedComments({
      tripId: trip.trip_id,
      generation: opened.model.commentLoadGeneration,
      data: { rows: [], nextCursor: null },
      error: "",
      more: false,
    }),
  );
  assert.equal(late.model.selectedTrip, null);
  assert.equal(late.model.inspectorDialog.isOpen, false);
});

test("navigation retains the trip feature's dialog cleanup commands", () => {
  const opened = update(
    app("/trips"),
    Features.trips.toParentMessage(TripMessage.InspectTrip({ trip })),
  );
  const navigated = update(
    opened.model,
    AppMessage.Navigated({ path: "/", query: "" }),
  );
  assert.equal(navigated.model.tripsState.selectedTrip, null);
  assert.equal(navigated.model.tripsState.inspectorDialog.isOpen, false);
  assert.ok(
    navigated.commands?.some((command) => command.name === "CloseDialog"),
  );
});

test("sort URLs survive reload and history; saved views restore global scope with default sort", () => {
  const open = (path: string) =>
    init(Option.getOrThrow(Url.fromString(`http://localhost${path}`)));
  const tripLoad = (result: ReturnType<typeof init>) =>
    result.commands?.find(({ name }) => name === "LoadTrips")?.args;
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
    AppMessage.Navigated({ path: "/trips", query: "zip=10001&sort=distance" }),
  );
  assert.equal(tripLoad(arrived), undefined);
  const back = update(
    sorted.model,
    AppMessage.Navigated({ path: "/trips", query: "zip=10001&sort=fare" }),
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
    AppMessage.Navigated({ path: "/trips", query: "from=2016-01-01" }),
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

test("comment counts from an older trip page cannot replace the current rows' counts", () => {
  const loaded = (model: Trips.Model) =>
    updateTrips(
      model,
      TripMessage.LoadedTrips({
        generation: model.loadGeneration,
        error: "",
        data: { rows: [trip], total: 1, pageSize: 25, nextCursor: null },
      }),
    ).model;
  const firstPage = loaded(Trips.init());
  const nextPage = loaded(firstPage);
  const current = updateTrips(
    nextPage,
    TripMessage.LoadedCommentCounts({
      version: nextPage.commentCountsVersion,
      data: { [trip.trip_id]: 3 },
      error: "",
    }),
  ).model;
  const late = updateTrips(
    current,
    TripMessage.LoadedCommentCounts({
      version: firstPage.commentCountsVersion,
      data: { [trip.trip_id]: 0 },
      error: "",
    }),
  ).model;
  assert.equal(late.commentCounts.data?.[trip.trip_id], 3);
});

test("analysis links distinguish valid, malformed, and absent run IDs", () => {
  const linked = app("/analysis?zip=invalid&run=123&run=invalid");
  assert.equal(linked.analysisRunsState.selected?.id, 123);
  assert.equal(linked.analysisRunsState.invalidLink, false);
  const malformed = update(
    linked,
    AppMessage.Navigated({ path: "/analysis", query: "run=01" }),
  ).model;
  assert.equal(malformed.analysisRunsState.selected, null);
  assert.equal(malformed.analysisRunsState.invalidLink, true);
  const absent = update(
    malformed,
    AppMessage.Navigated({ path: "/analysis", query: "" }),
  ).model;
  assert.equal(absent.analysisRunsState.selected, null);
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
    SavedMessage.SavedViewDialog({ message: Dialog.Message.RequestedClose() }),
  ]) {
    const blocked = updateSavedViews(saving.model, message, context);
    assert.equal(blocked.model.editor?.saving, true);
    assert.equal(blocked.model.dialogs.savedView.isOpen, true);
  }
  const failed = updateSavedViews(
    saving.model,
    SavedMessage.SavedViewSaved({ savedView: null, error: "Try again" }),
    context,
  );
  const closed = updateSavedViews(
    failed.model,
    SavedMessage.CloseSavedView(),
    context,
  );
  assert.equal(closed.model.editor, null);
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
    SavedMessage.DeleteDialog({ message: Dialog.Message.RequestedClose() }),
  ]) {
    const blocked = updateSavedViews(busy.model, message, context);
    assert.equal(blocked.model.deleting?.id, savedView.id);
    assert.equal(blocked.model.dialogs.delete.isOpen, true);
  }
  const deleted = updateSavedViews(
    busy.model,
    SavedMessage.MutatedSavedView({ removed: true, error: "" }),
    context,
  );
  assert.equal(deleted.model.deleting, null);
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
    GenieMessage.GenieDialog({ message: Dialog.Message.RequestedClose() }),
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
    AppMessage.Navigated({ path: "/trips", query: "zip=10002" }),
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
  const model = reloadOverview(Overview.init(), {}).model;
  const stale = updateOverview(
    model,
    OverviewMessage.LoadedOverview({
      generation: model.loadGeneration - 1,
      data: null,
      error: "old failure",
    }),
  );
  assert.equal(stale.model, model);
  assert.equal(stale.outMessage, undefined);
  const current = updateOverview(
    model,
    OverviewMessage.LoadedOverview({
      generation: model.loadGeneration,
      data: null,
      error: "Warehouse unavailable",
    }),
  );
  assert.equal(current.model.overview.error, "Warehouse unavailable");
  assert.deepEqual(current.outMessage, { _tag: "SelectionInvalidated" });
});

test("trip paging clears the previous selection and retries from the same cursor", async () => {
  const opening = open("/trips?zip=10001");
  const cursor = tripCursorFor(trip, { zip: "10001" });
  const response = await respond(
    opening,
    "LoadTrips",
    Response.json({ rows: [trip], total: 2, pageSize: 1, nextCursor: cursor }),
  );
  const first = update(opening.model, response).model;
  const selected = {
    ...first,
    genieState: {
      ...first.genieState,
      genieSelection: { page: "trips" as const, title: "Old page" },
    },
  };
  const next = update(
    selected,
    Features.trips.toParentMessage(TripMessage.NextPage()),
  );
  assert.equal(Trips.tripPageNumber(next.model.tripsState), 2);
  assert.equal(next.model.genieState.genieSelection, null);
  const failed = update(
    next.model,
    await respond(next, "LoadTrips", originalTimeout()),
  );
  const error = failed.model.tripsState.trips.error;
  assert.ok(typeof error === "string");
  assert.match(error, /timed out/);
  const retry = update(failed.model, AppMessage.LoadPage());
  const retried = await runRequest(retry, "LoadTrips", async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.deepEqual(
      JSON.parse(url.searchParams.get("cursor") ?? "null"),
      cursor,
    );
    return Response.json({ rows: [], total: 1, pageSize: 1, nextCursor: null });
  });
  const last = update(retry.model, retried).model;
  assert.equal(last.tripsState.trips.data?.nextCursor, null);
  assert.equal(update(last, response).model, last);
  assert.equal(
    update(last, Features.trips.toParentMessage(TripMessage.NextPage())).model,
    last,
  );

  const previous = update(
    last,
    Features.trips.toParentMessage(TripMessage.PreviousPage()),
  );
  assert.equal(Trips.tripPageNumber(previous.model.tripsState), 1);
  assert.equal(
    previous.commands?.find(({ name }) => name === "LoadTrips")?.args?.cursor,
    null,
  );

  const filtered = update(
    last,
    AppMessage.Navigated({ path: "/trips", query: "zip=10002" }),
  );
  const request = filtered.commands?.find(
    ({ name }) => name === "LoadTrips",
  )?.args;
  assert.deepEqual(request?.filters, { zip: "10002" });
  assert.equal(request?.cursor, null);
  assert.equal(Trips.tripPageNumber(filtered.model.tripsState), 1);
});

test("trip paging accepts a continuation beyond ten thousand pages", () => {
  const cursor = tripCursorFor(trip, {});
  const state: Trips.Model = {
    ...Trips.init(),
    pageCursors: Array.from({ length: 9_999 }, () => cursor),
    trips: {
      loading: false,
      error: "",
      data: { rows: [trip], total: 10_001, pageSize: 1, nextCursor: cursor },
    },
  };
  const next = updateTrips(state, TripMessage.NextPage());
  assert.equal(Trips.tripPageNumber(next.model), 10_001);
  assert.deepEqual(next.outMessage, { _tag: "Reload" });
});

test("application opens Genie, dismisses mobile navigation, and requests focus", () => {
  const model = { ...app("/trips"), mobileNavigation: true };
  const changed = update(
    model,
    Features.genie.toParentMessage(
      GenieMessage.OpenGenie({ context: null, question: null }),
    ),
  );
  assert.equal(changed.model.genieState.genieOpen, true);
  assert.equal(changed.model.mobileNavigation, false);
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
