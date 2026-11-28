import { Context, Effect, Layer } from "effect";
import { Filters } from "@dsiem/analytics-shared/filters";
import type {
  SavedViewInput,
  SavedViewPin,
  SavedViewSearch,
} from "@dsiem/analytics-shared/saved-views";
import type { SqlClient } from "effect/sql/SqlClient";
import { Lakebase } from "./lakebase.js";
import { makeSavedViewStore } from "@dsiem/analytics/saved-views";

import { taxiSavedViewTable } from "./lakebase-schema.js";
const makeSavedViews = (sql: SqlClient) =>
  makeSavedViewStore(sql, {
    table: taxiSavedViewTable,
    filters: Filters,
    searchFields: ["from", "to", "zip"],
  });

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
