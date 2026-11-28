import { Effect, Schema, Struct } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Statement } from "effect/sql/Statement";
import { pageWindow } from "./contracts/cursor-page.js";
import {
  savedViewSchemas,
  SavedViewCursor,
  type SavedViewPin,
  type SavedViewSearch,
} from "./contracts/saved-view-store.js";
import { SavedViewConflict, SavedViewNotFound, unavailable } from "./errors.js";
import { postgresFailure } from "./errors.js";
import type { SavedViewTable } from "./saved-view-table.js";

const page = pageWindow(24);

export const makeSavedViewStore = <
  F,
  Encoded extends Readonly<Record<string, Schema.Json>>,
>(
  sql: SqlClient,
  config: {
    readonly filters: Schema.Codec<F, Encoded>;
    readonly table: SavedViewTable;
    readonly searchFields: ReadonlyArray<NoInfer<keyof Encoded & string>>;
  },
) => {
  const { SavedView, SavedViewInput } = savedViewSchemas(config.filters);
  const table = sql`${sql(config.table.schema)}.${sql(config.table.name)}`;
  const columns = sql`id::text AS id, title, body, filters, pinned, version,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;
  const visible = sql`last_write <> 'delete'`;
  const searchColumns = [
    sql`title`,
    sql`body`,
    ...config.searchFields.map((field) => sql`filters->>${field}::text`),
  ];
  const list = (search: SavedViewSearch) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        ...SavedView.fields,
        cursor_updated_at: SavedViewCursor.fields.updatedAt,
      }),
      execute: () => sql`SELECT ${columns},
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
      FROM ${table} AS saved_views
      WHERE ${sql.and([
        visible,
        ...(search.cursor
          ? [
              sql`(pinned, updated_at, id) <
            (${search.cursor.pinned}, ${search.cursor.updatedAt}::timestamptz, ${search.cursor.id}::uuid)`,
            ]
          : []),
        ...(search.ids ? [sql.in("id", search.ids)] : []),
        ...(search.q?.match(/\S+/gu) ?? []).map(
          (token) => sql`strpos(lower(concat_ws(' ',
            ${sql.csv(searchColumns)})), lower(${token})) > 0`,
        ),
      ])}
      ORDER BY saved_views.pinned DESC, saved_views.updated_at DESC, saved_views.id DESC LIMIT ${page.fetchLimit}`,
    })(undefined).pipe(
      Effect.mapError(
        postgresFailure(
          "Saved views are under lock. You need permission to open them.",
        ),
      ),
      Effect.map((results) =>
        page.fromRows(results, {
          row: ({ cursor_updated_at: _, ...savedView }) => savedView,
          cursor: ({ id, pinned, cursor_updated_at }) => ({
            id,
            pinned,
            updatedAt: cursor_updated_at,
          }),
        }),
      ),
      Effect.withSpan("savedViews.list"),
    );
  const conflict = (id: string) =>
    new SavedViewConflict({
      id,
      message:
        "This saved view changed since you opened it. Close and reopen it to load the latest version before trying again.",
    });
  const notFound = (id: string) =>
    new SavedViewNotFound({
      id,
      message:
        "This saved view has been removed. Your draft has not been saved.",
    });
  const readWrite = <A>(
    schema: Schema.Decoder<A>,
    statement: Statement<unknown>,
  ) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: schema,
      execute: () => statement,
    })(undefined).pipe(
      Effect.mapError(
        postgresFailure(
          "This view is locked for changes. You need permission to save it.",
        ),
      ),
    );
  const write = (
    id: string,
    statement: Statement<unknown>,
    replay: Statement<unknown>,
  ) =>
    Effect.gen(function* () {
      const [written] = yield* readWrite(SavedView, statement);
      if (written) return written;
      // A fresh statement sees a concurrent commit that won the version check.
      const [current] = yield* readWrite(
        Schema.Struct({
          ...SavedView.fields,
          replayed: Schema.Boolean,
        }),
        sql`SELECT ${columns},
          (${replay}) IS TRUE AS replayed FROM ${table} WHERE id=${id}::uuid AND ${visible}`,
      );
      if (current?.replayed) return Struct.omit(current, ["replayed"]);
      return yield* current ? conflict(id) : notFound(id);
    });
  const save = ({
    id,
    title,
    body,
    filters,
    version,
  }: typeof SavedViewInput.Type) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(config.filters)(filters).pipe(
        Effect.mapError((cause) =>
          unavailable(
            "lakebase",
            "The saved view filters could not be encoded.",
            cause,
          ),
        ),
      );
      const json = sql`${JSON.stringify(encoded)}::jsonb`;
      const sameDraft = sql`title=${title} AND body=${body} AND filters=${json}`;
      return yield* version === null
        ? write(
            id,
            sql`INSERT INTO ${table} (id,title,body,filters)
              VALUES (${id}::uuid,${title},${body},${json})
              ON CONFLICT (id) DO NOTHING RETURNING ${columns}`,
            sql`version=1 AND last_write='create' AND ${sameDraft}`,
          )
        : write(
            id,
            sql`UPDATE ${table} SET title=${title}, body=${body},
              filters=${json}, version=version+1, updated_at=now(), last_write='edit'
              WHERE id=${id}::uuid AND version=${version}::bigint AND ${visible}
              RETURNING ${columns}`,
            sql`version=${version + 1}::bigint AND last_write='edit' AND ${sameDraft}`,
          );
    }).pipe(Effect.withSpan("savedViews.save"));
  const pin = (id: string, { version, pinned }: SavedViewPin) =>
    write(
      id,
      sql`UPDATE ${table} SET pinned=${pinned}, last_write='pin',
        version=version+1, updated_at=now()
        WHERE id=${id}::uuid AND version=${version}::bigint AND ${visible} RETURNING ${columns}`,
      sql`version=${version + 1}::bigint AND last_write='pin' AND pinned=${pinned}`,
    ).pipe(Effect.withSpan("savedViews.pin"));
  const remove = (id: string, version: number) =>
    Effect.gen(function* () {
      // Reserve the ID and version while erasing the user's filters and text.
      const [removed] = yield* readWrite(
        Schema.Struct({ id: Schema.String }),
        sql`UPDATE ${table} SET last_write='delete', title='Deleted', body='',
          filters='{}'::jsonb, pinned=false, updated_at=now()
          WHERE id=${id}::uuid AND version=${version}::bigint AND ${visible} RETURNING id::text AS id`,
      );
      if (removed) return;
      const [current] = yield* readWrite(
        Schema.Struct({ version: Schema.Int, deleted: Schema.Boolean }),
        sql`SELECT version, NOT (${visible}) AS deleted FROM ${table} WHERE id=${id}::uuid`,
      );
      if (current?.deleted && current.version === version) return;
      return yield* current && !current.deleted ? conflict(id) : notFound(id);
    }).pipe(Effect.asVoid, Effect.withSpan("savedViews.remove"));
  return { list, save, pin, remove };
};

export {
  initializeSavedViewTable,
  type SavedViewTable,
} from "./saved-view-table.js";
