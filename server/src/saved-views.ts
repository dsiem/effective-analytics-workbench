import { Context, Effect, Layer, Schema } from "effect";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Statement } from "effect/sql/Statement";
import { pageWindow } from "../../shared/cursor-page.js";
import {
  SavedView,
  SavedViewCursor,
  type SavedViewInput,
  type SavedViewPin,
  type SavedViewSearch,
  type SavedViewsPage,
} from "../../shared/saved-views.js";
import { SavedViewConflict, SavedViewNotFound } from "./errors.js";
import { Lakebase, type LakebaseSql, lakebaseFailure } from "./lakebase.js";

const page = pageWindow(24);

const makeSavedViews = (sql: LakebaseSql) => {
  const columns = sql`id::text AS id, title, body, filters, pinned, version,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;
  const list = (search: SavedViewSearch) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        ...SavedView.fields,
        cursor_updated_at: SavedViewCursor.fields.updatedAt,
      }),
      execute: () => sql`SELECT ${columns},
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
      FROM app.saved_views AS saved_views
      WHERE ${sql.and([
        ...(search.cursor
          ? [
              sql`(pinned, updated_at, id) <
            (${search.cursor.pinned}, ${search.cursor.updatedAt}::timestamptz, ${search.cursor.id}::uuid)`,
            ]
          : []),
        ...(search.ids ? [sql.in("id", search.ids)] : []),
        ...(search.q?.match(/\S+/gu) ?? []).map(
          (token) => sql`strpos(lower(concat_ws(' ', title, body,
            filters->>'from', filters->>'to', filters->>'zip')), lower(${token})) > 0`,
        ),
      ])}
      ORDER BY saved_views.pinned DESC, saved_views.updated_at DESC, saved_views.id DESC LIMIT ${page.fetchLimit}`,
    })(undefined).pipe(
      Effect.mapError(
        lakebaseFailure(
          "Saved views are under lock. You need permission to open them.",
        ),
      ),
      Effect.map((results): SavedViewsPage =>
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
  const missingWrite = (id: string) =>
    sql`SELECT id FROM app.saved_views WHERE id = ${id}::uuid`.pipe(
      Effect.mapError(
        lakebaseFailure(
          "Saved views are under lock. You need permission to open them.",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.fail(rows.length ? conflict(id) : notFound(id)),
      ),
    );
  const write = (id: string, execute: () => Statement<unknown>) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: SavedView,
      execute,
    })(undefined).pipe(
      Effect.mapError(
        lakebaseFailure(
          "This view is locked for changes. You need permission to save it.",
        ),
      ),
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : missingWrite(id),
      ),
    );
  const save = (input: SavedViewInput) =>
    write(input.id, () =>
      input.version === null
        ? sql`INSERT INTO app.saved_views (id,title,body,filters)
          VALUES (${input.id}::uuid,${input.title},${input.body},${sql.json(input.filters)})
          ON CONFLICT (id) DO NOTHING RETURNING ${columns}`
        : sql`UPDATE app.saved_views SET title=${input.title}, body=${input.body},
          filters=${sql.json(input.filters)}, version=version+1, updated_at=now()
          WHERE id=${input.id}::uuid AND version=${input.version}
          RETURNING ${columns}`,
    ).pipe(Effect.withSpan("savedViews.save"));
  const pin = (id: string, input: SavedViewPin) =>
    write(
      id,
      () => sql`UPDATE app.saved_views SET pinned=${input.pinned},
      version=version+1, updated_at=now()
      WHERE id=${id}::uuid AND version=${input.version} RETURNING ${columns}`,
    ).pipe(Effect.withSpan("savedViews.pin"));
  const remove = (id: string, version: number) =>
    sql`DELETE FROM app.saved_views WHERE id = ${id}::uuid AND version=${version} RETURNING id`.pipe(
      Effect.mapError(
        lakebaseFailure(
          "This view is staying put. You need permission to delete it.",
        ),
      ),
      Effect.flatMap((rows) => (rows.length ? Effect.void : missingWrite(id))),
    );
  return { list, save, pin, remove };
};

const makeSavedViewsService = (database: typeof Lakebase.Service) => ({
  list: (search: SavedViewSearch) =>
    database.use((sql) => makeSavedViews(sql).list(search)),
  save: (input: SavedViewInput) =>
    database.use((sql) => makeSavedViews(sql).save(input)),
  pin: (id: string, input: SavedViewPin) =>
    database.use((sql) => makeSavedViews(sql).pin(id, input)),
  remove: (id: string, version: number) =>
    database.use((sql) => makeSavedViews(sql).remove(id, version)),
});

export class SavedViews extends Context.Service<
  SavedViews,
  ReturnType<typeof makeSavedViewsService>
>()("app/SavedViews") {
  static readonly layer = Layer.effect(
    SavedViews,
    Effect.map(Lakebase, makeSavedViewsService),
  );
}
