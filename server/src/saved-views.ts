import { Context, Effect, Layer, Schema, Struct } from "effect";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Statement } from "effect/sql/Statement";
import { pageWindow } from "@dsiem/analytics-shared/cursor-page";
import {
  SavedView,
  SavedViewCursor,
  type SavedViewInput,
  type SavedViewPin,
  type SavedViewSearch,
  type SavedViewsPage,
} from "@dsiem/analytics-shared/saved-views";
import { SavedViewConflict, SavedViewNotFound } from "./errors.js";
import { Lakebase, type LakebaseSql, lakebaseFailure } from "./lakebase.js";

const page = pageWindow(24);

const makeSavedViews = (sql: LakebaseSql) => {
  const columns = sql`id::text AS id, title, body, filters, pinned, version,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;
  const visible = sql`last_write IS DISTINCT FROM 'delete'`;
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
        visible,
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
        lakebaseFailure(
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
          deleted: Schema.Boolean,
          replayed: Schema.Boolean,
        }),
        sql`SELECT ${columns}, NOT (${visible}) AS deleted,
          (${replay}) IS TRUE AS replayed FROM app.saved_views WHERE id=${id}::uuid`,
      );
      if (current?.replayed)
        return Struct.omit(current, ["replayed", "deleted"]);
      return yield* current && !current.deleted ? conflict(id) : notFound(id);
    });
  const save = ({ id, title, body, filters, version }: SavedViewInput) => {
    const sameDraft = sql`title=${title} AND body=${body} AND filters=${sql.json(filters)}::jsonb`;
    return (
      version === null
        ? write(
            id,
            sql`INSERT INTO app.saved_views (id,title,body,filters)
              VALUES (${id}::uuid,${title},${body},${sql.json(filters)})
              ON CONFLICT (id) DO NOTHING RETURNING ${columns}`,
            sql`version=1 AND last_write IS NULL AND ${sameDraft}`,
          )
        : write(
            id,
            sql`UPDATE app.saved_views SET title=${title}, body=${body},
              filters=${sql.json(filters)}, version=version+1, updated_at=now(), last_write='edit'
              WHERE id=${id}::uuid AND version=${version}::bigint AND ${visible}
              RETURNING ${columns}`,
            sql`version=${version + 1}::bigint AND last_write='edit' AND ${sameDraft}`,
          )
    ).pipe(Effect.withSpan("savedViews.save"));
  };
  const pin = (id: string, { version, pinned }: SavedViewPin) =>
    write(
      id,
      sql`UPDATE app.saved_views SET pinned=${pinned}, last_write='pin',
        version=version+1, updated_at=now()
        WHERE id=${id}::uuid AND version=${version}::bigint AND ${visible} RETURNING ${columns}`,
      sql`version=${version + 1}::bigint AND last_write='pin' AND pinned=${pinned}`,
    ).pipe(Effect.withSpan("savedViews.pin"));
  const remove = (id: string, version: number) =>
    write(
      id,
      // Keep the ID and deleted version reserved. Discard the user's content.
      sql`UPDATE app.saved_views SET last_write='delete', title='Deleted', body='',
        filters='{}'::jsonb, pinned=false, updated_at=now()
        WHERE id=${id}::uuid AND version=${version}::bigint AND ${visible} RETURNING ${columns}`,
      sql`last_write='delete' AND version=${version}::bigint`,
    ).pipe(Effect.asVoid, Effect.withSpan("savedViews.remove"));
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
