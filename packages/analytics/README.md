# @dsiem/analytics

Define a relation and its filters once, then compose record and aggregate queries
with an Effect SQL client. The taxi explorer uses this API for its records,
inspector, overview and map totals. The same functions work with a local SQL
database.

```ts
import { dataset } from "@dsiem/analytics";
import type { Constructor } from "effect/sql/Statement";

export function repairs(sql: Constructor) {
  const orders = dataset(sql, {
    table: sql("work_orders"),
    predicates: (filters: { site?: string }) => [
      filters.site !== undefined && sql`site = ${filters.site}`,
    ],
  });

  return {
    backlog: (site: string) =>
      orders.records({
        fields: { id: sql("id"), hours: sql("hours") },
        filters: { site },
        where: sql`done = 0`,
        orderBy: [sql`hours DESC`, sql`id ASC`],
        limit: 20,
      }),
    laborByTrade: (site: string) =>
      orders.aggregate({
        filters: { site },
        dimensions: { trade: sql("trade") },
        measures: { jobs: sql`COUNT(*)`, labor: sql`SUM(hours)` },
        orderBy: [sql`labor DESC`],
      }),
  };
}
```

The returned statements are Effects. Execute them with the client that built
them. Each selected alias is a key in the row type. Decode the returned values
using your driver's wire format and the result schema for your analysis.

A definition accepts an identifier or a SQL fragment as its table. To select a
Unity Catalog table, quote each of its three names with the SQL client.
Projection keys become quoted aliases. Build expressions with the tagged
template and bind filter values through interpolation. Choose sort expressions
from application-owned options when accepting input from a browser.

Supply dimensions to group by all of them. Omit dimensions to summarize the
entire selection. A numeric limit is bound as a parameter. Drivers with typed
parameters can supply a fragment such as `sql.param("INT", "20")`. For a
specialized query such as H3 binning, embed `orders.where(filters)` as the
complete `WHERE` clause.

## Page through a warehouse preview

Import `makeRecordPreview` from `@dsiem/analytics/record-preview` and create an
instance during service initialization. Supply a `start(search)` function that
applies the requested order and row limit, then returns the first rows, the
total page count, a truncation flag, and a function to read subsequent chunks
by index and cumulative row offset. Databricks' `sql.jsonPage` provides this
shape. `encodePage` converts each page to the representation for your client.
The instance returns `open(search)` and `page(cursor)`.

The cursor points to another chunk within the selected rows. The
`hasMoreMatches` flag means additional records matched beyond the row limit.
Pass a `cacheable(search)` predicate to reuse encoded results for up to two
searches for 60 seconds. Include all criteria that affect results in the search
key. The service retains up to 256 continuation sessions for 15 minutes in the
issuing process. Supply the errors your transport expects for an expired
cursor and for a chunk whose size changes on retry.

## Rank locations by a measure

Databricks SQL datasets can use `h3Cells` from `@dsiem/analytics/spark` to
group coordinate pairs into H3 cells. Choose the resolution (0 through 15),
measures, sort direction and maximum cells. Supply the dataset filters and a
predicate that selects usable coordinates.

```ts
const hottest = h3Cells(sql, readings, {
  filters: { network: "city" },
  longitude: sql("sensor_lon"),
  latitude: sql("sensor_lat"),
  where: sql`coordinates_valid AND calibrated`,
  resolution: 8,
  measures: { mean_celsius: sql`AVG(temperature)` },
  rankBy: { measure: "mean_celsius", direction: "desc" },
  limit: 100,
});
```

Each row carries its measure values, string H3 ID, center coordinates, GeoJSON
boundary string and the number of matching cells before the limit. Ties sort
by H3 index. Pass the statement to `sql.arrowStream` for columnar results or
execute it directly for inline JSON.

## Store findings and record comments

Use an Effect PostgreSQL client for these features. Give each application its own tables.
Run the initializers during database setup. Create the stores in the service
that handles requests.

```ts
import { Schema } from "effect";
import {
  initializeSavedViewTable,
  makeSavedViewStore,
} from "@dsiem/analytics/saved-views";
import {
  initializeRecordCommentTable,
  makeRecordComments,
} from "@dsiem/analytics/record-comments";

const filters = Schema.Struct({ depot: Schema.String });
const viewTable = { schema: "operations", name: "saved_views" };
const views = makeSavedViewStore(sql, {
  table: viewTable,
  filters,
  searchFields: ["depot"],
});

const order = Schema.Struct({
  reference: Schema.String,
  remaining: Schema.Natural,
});
const noteTable = {
  schema: "operations",
  name: "order_notes",
  keyColumn: "order_id",
  snapshotColumn: "snapshot",
};
const notes = makeRecordComments(sql, {
  table: noteTable,
  snapshot: order,
  recordId: (row) => row.reference,
});
```

Use `yield* initializeSavedViewTable(sql, viewTable)` and
`yield* initializeRecordCommentTable(sql, noteTable)` before the first write.
A saved view has an application-assigned UUID and a version. Pass `null` to
create it and the returned version to edit, pin or remove it. Search uses
the encoded filter field names. Comment retries preserve the originally stored
snapshot and author. [Saved views with required filters](../../server/test/custom-saved-views.test.ts) ·
[Order annotations](../../server/test/custom-record-comments.test.ts)

## Bind a Databricks job

Import `makeAnalysisJob` and `sqlJsonReport` from `@dsiem/analytics/jobs`.
Pass an authenticated request function and a definition containing the job ID,
a parameter codec, and a report reader. The codec maps application inputs to
Databricks string parameters and decodes history. The binding reserves
`requested_by` for viewer attribution.

The returned service exposes `submit`, `list`, `get`, and `result`. Reuse the
same request UUID when retrying a submission. A report reader returns an
Effect containing an Option. Use `sqlJsonReport(sql, table, schema)` for a
table with a BIGINT `run_id` and a JSON string `report_json`. Supply another
reader for reports stored elsewhere. [Taxi job binding](../../server/src/analysis-runs.ts)

Import the boundary schemas from `@dsiem/analytics/contracts` to build an
HTTP API. Import the tagged errors from `@dsiem/analytics/errors` when mapping
store and job failures to HTTP responses. Node servers that ship a built Vite
client can use `staticPages` from `@dsiem/analytics/static-pages` to serve
its assets and declared page routes.

## Use the package outside this workspace

Run `pnpm --filter @dsiem/analytics pack --pack-destination /tmp` from the
workspace root. Install the resulting tarball and a compatible Effect peer in
the consuming application. The report UI has its own package and stylesheet.
[Report UI package](../workbench-ui/README.md)

## Submit a local SQL analysis

Use `initializeLocalRunTable` and `makeLocalRuns` from `@dsiem/analytics/local-runs`
for calculations that fit within one PostgreSQL transaction. Provide an input
codec, a report codec and a calculation that returns an Effect. It can query the
same SQL client inside that transaction. A successful submission commits the
input and report together. Resubmitting the same UUID and input returns the
stored ID. A failed calculation rolls the transaction back.

The store exposes `submit`, `list`, `get`, and `result`. The list returns the
ten most recently completed runs. Each run link can reopen its stored result
after it leaves the list. [Transaction and retry test](../../server/test/local-report-runs.test.ts)

Use `savedViewsGroup`, `savedViewHandlers`, and `recordCommentsGroup` from
`@dsiem/analytics/collaboration-http` to attach versioned findings and record
comments to an Effect HTTP API. The group factories accept your public paths,
filters and record schema. [Taxi API](../shared/src/api.ts) · [Handlers](../../server/src/routes.ts)
