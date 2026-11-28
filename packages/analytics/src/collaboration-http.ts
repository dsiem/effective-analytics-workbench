import type { makeSavedViewStore } from "./saved-views.js";
import { Effect, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import { CommentCounts, commentSchemas } from "./contracts/record-comments.js";
import { Id } from "./contracts/fields.js";
import {
  SavedViewPin,
  SavedViewSearch,
  savedViewSchemas,
} from "./contracts/saved-view-store.js";
import type {
  InvalidRequest,
  PermissionDenied,
  SavedViewConflict,
  SavedViewNotFound,
  ServiceUnavailable,
} from "./errors.js";

const codes = {
  InvalidRequest: "invalid_request",
  PermissionDenied: "permission_denied",
  SavedViewConflict: "saved_view_conflict",
  SavedViewNotFound: "saved_view_not_found",
  ServiceUnavailable: "lakebase_unavailable",
} as const;

const errorBody = <C extends keyof typeof codes>(tag: C, status: number) =>
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.Literal(codes[tag]),
      message: Schema.String,
    }),
  }).pipe(HttpApiSchema.status(status));
const storageErrors = [
  errorBody("PermissionDenied", 403),
  errorBody("ServiceUnavailable", 503),
] as const;
const saveErrors = [
  ...storageErrors,
  errorBody("SavedViewNotFound", 404),
  errorBody("SavedViewConflict", 409),
] as const;
type StorageFailure =
  | InvalidRequest
  | PermissionDenied
  | SavedViewConflict
  | SavedViewNotFound
  | ServiceUnavailable<"lakebase">;
type Body<E extends StorageFailure> = E extends StorageFailure
  ? { error: { code: (typeof codes)[E["_tag"]]; message: string } }
  : never;

function response<E extends StorageFailure>(failure: E): Body<E>;
function response(failure: StorageFailure) {
  return { error: { code: codes[failure._tag], message: failure.message } };
}

export const collaborationResponse = <A, E extends StorageFailure, R>(
  operation: Effect.Effect<A, E, R>,
) =>
  operation.pipe(
    Effect.tapError((error) =>
      error._tag === "ServiceUnavailable"
        ? Effect.logError("API dependency failed", {
            service: error.service,
            errorTag: error._tag,
          })
        : Effect.void,
    ),
    Effect.mapError(response<E>),
  );

/** Hand a repository's versioned write and cursor semantics to HttpApiBuilder.handleAll. */
export function savedViewHandlers<
  Filters,
  Encoded extends Readonly<Record<string, Schema.Json>>,
>(store: ReturnType<typeof makeSavedViewStore<Filters, Encoded>>) {
  return {
    list: ({ query }: { query: SavedViewSearch }) =>
      collaborationResponse(store.list(query)),
    save: ({ payload }: { payload: Parameters<typeof store.save>[0] }) =>
      collaborationResponse(store.save(payload)),
    pin: ({
      params,
      payload,
    }: {
      params: { id: string };
      payload: SavedViewPin;
    }) => collaborationResponse(store.pin(params.id, payload)),
    remove: ({
      params,
      query,
    }: {
      params: { id: string };
      query: { version: number };
    }) =>
      collaborationResponse(store.remove(params.id, query.version)).pipe(
        Effect.as({ deleted: true as const }),
      ),
  };
}

export function savedViewsGroup<
  const Name extends string,
  const Path extends `/${string}`,
  Filters extends Schema.Top,
>(name: Name, path: Path, filters: Filters) {
  const { SavedView, SavedViewsPage, SavedViewInput } =
    savedViewSchemas(filters);
  return HttpApiGroup.make(name).add(
    HttpApiEndpoint.get("list", path, {
      query: SavedViewSearch,
      success: SavedViewsPage,
      error: storageErrors,
    }),
    HttpApiEndpoint.put("save", path, {
      payload: SavedViewInput,
      success: SavedView,
      error: saveErrors,
    }),
    HttpApiEndpoint.patch("pin", `${path}/:id/pin`, {
      params: { id: Id },
      payload: SavedViewPin,
      success: SavedView,
      error: saveErrors,
    }),
    HttpApiEndpoint.delete("remove", `${path}/:id`, {
      params: { id: Id },
      query: {
        version: Schema.NumberFromString.check(
          Schema.isInt(),
          Schema.isGreaterThan(0),
        ),
      },
      success: Schema.Struct({ deleted: Schema.Literal(true) }),
      error: saveErrors,
    }),
  );
}

export function recordCommentsGroup<
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Search extends Schema.Top,
  Counts extends Schema.Top,
>(
  name: Name,
  config: {
    readonly path: `/${string}`;
    readonly countsPath: `/${string}`;
    readonly fields: Fields;
    readonly search: Search;
    readonly counts: Counts;
  },
) {
  const { Input, Comment, Page } = commentSchemas(config.fields);
  return HttpApiGroup.make(name).add(
    HttpApiEndpoint.get("list", config.path, {
      query: config.search,
      success: Page,
      error: storageErrors,
    }).annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" }),
    HttpApiEndpoint.get("counts", config.countsPath, {
      query: config.counts,
      success: CommentCounts,
      error: storageErrors,
    }),
    HttpApiEndpoint.post("add", config.path, {
      payload: Input,
      success: Comment,
      error: [...storageErrors, errorBody("InvalidRequest", 400)],
    }),
  );
}
