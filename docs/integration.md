# Effect and Foldkit patterns for Databricks Apps

Use **Trip overview** as the example for a query and **Analysis runs** as the
example for work that continues after an HTTP request ends. Both use the same
Effect HTTP contract to connect the server to Foldkit.

## How the workbench fits together

The browser and server import their feature schemas from `packages/shared/src/`.
`AppApi` describes the HTTP operations, and the server supplies their handlers
with Effect services at startup. [HTTP contract](../packages/shared/src/api.ts) ·
[Server layers](../server/src/main.ts)

- **Filters** select the records included in an exploration. **Trip explorer**
  and **Trip map** share pickup dates and ZIP, and saved views use the same
  filter comparison.
  [Filter schema](../packages/shared/src/filters.ts)
- **A cursor page** contains rows and an optional continuation cursor. Saved
  views and trip comments fetch one extra row to tell whether another page
  exists, and build the cursor from the last returned row.
  [Page schema and construction](../packages/shared/src/cursor-page.ts)
- **A browser feature** owns its model, messages, and update function. Its
  binding connects that model and those messages to the app shell. The shell
  handles actions that involve another feature, such as opening Genie from a
  chart. [Feature bindings](../client/src/app/features.ts) · [Shell update](../client/src/app/update.ts)
- **A Genie answer** contains ordered attachments and an optional warning.
  Chat and Agent both return this shape. The server turns it into the text and
  query tables the workbench displays. [Answer type](../packages/genie-client/src/answer.ts) · [Genie service](../server/src/genie/service.ts)

`GET /api/trips` returns a JSON page with `rows`, `nextCursor`, and
`hasMoreMatches`. Each row carries a trip summary with numeric distance, fare,
and duration. The server validates Databricks chunks and converts the rows
before sending them to the browser.

When `nextCursor` is present, pass it to `GET /api/trips/pages/:cursor` to read
the next page. Continue until `nextCursor` is `null`. The browser can render
each page as it arrives. Responses use gzip when the client accepts it and the
body is at least 1 KiB. [Trip page schema](../packages/shared/src/trips.ts)

The optional positive integer `limit` defaults to 10,000. For example,
`/api/trips?limit=500` requests at most 500 rows in the selected sort order.
`hasMoreMatches` reports whether more trips matched beyond that limit.
`nextCursor` points to rows within the requested limit.

The server can reuse encoded pages for the two most recent previews with
limits up to 10,000 for 60 seconds. Continuation cursors are temporary and
specific to the app process that issued them. If a cursor expires, restart
the preview at `/api/trips`.

Larger limits are allowed up to 2,147,483,646. Databricks aborts the statement
if the entire inline result exceeds 25 MiB, even when it spans multiple pages.
Request fewer rows or narrow the filters to retry. [Databricks Statement Execution API](https://docs.databricks.com/api/statement-execution/v1/execute-statement)

Open a row to load the full record through `/api/trip-details`. Comments
from a listed row can use its summary while details load.
[Trip ordering and limit](../server/src/taxi/trips.ts) ·
[Trip records view](../client/src/features/trips/view.ts)

## Carry a query through one HTTP contract

1. Define the endpoint's input, response, and error schemas in `AppApi`. The
   `overview` endpoint takes `Filters` and returns `Overview`. `HttpApiBuilder`
   decodes the input and passes it to the handler, which calls `Analytics.overview`.
   [HTTP contract](../packages/shared/src/api.ts) · [Server handlers](../server/src/routes.ts)
2. Bind user values as SQL parameters and quote table identifiers through the
   adapter. Ordinary warehouse queries return inline JSON. Overview uses
   `SqlSchema.findAll` to decode numeric text into numbers for the browser.
   The map requests Arrow explicitly for its query of up to 100,000 cell
   polygons. [Overview queries](../server/src/taxi/overview.ts) · [Map queries](../server/src/taxi/trip-map.ts) ·
   [Snapshot table and filters](../server/src/taxi/snapshot.ts) ·
   [Warehouse service](../server/src/warehouse.ts) · [SQL adapter](../packages/sql-warehouse/README.md)
3. Provide `ApiClient.layer` once in Foldkit's `Runtime.makeApplication`.
   The Overview subscription calls the generated client and emits a
   `LoadedOverview` message. Its scope covers response decoding, so leaving
   Overview or changing filters interrupts the request. Keep the
   server deadline below the browser deadline when the UI needs to display the
   server's typed timeout. [Browser runtime](../client/src/main.ts) ·
   [API client](../client/src/lib/api-client.ts) · [Overview subscription](../client/src/features/overview/subscription.ts) ·
   [Deadline tests](../client/test/api-client.test.ts)
4. Derive the subscription input from the active filters and pending load's
   generation. Include that generation in the completion message. Apply the
   result only if its generation matches the current model. A slow reply can
   arrive after the user returns to the same filters.
   [Overview update](../client/src/features/overview/update.ts) · [Feature tests](../client/test/features.test.ts)

The API groups endpoints by feature. The HTTP boundary maps service failures to
stable codes. Use those codes in a command when the next action depends on the
failure. Overview only needs a display message. The Genie submit
command uses the code and upstream status to distinguish rejection from
uncertain acceptance.
[Server error mapping](../server/src/api-boundary.ts) · [Genie commands](../client/src/features/genie/commands.ts)

## Submit, poll, and retrieve long-running work

1. **Submit.** The Analysis Runs command keeps its request ID when the user
   retries the same submission. The server derives a Jobs idempotency token from
   the job ID, request ID, and parameters. Once Databricks accepts the run, the
   API returns `202` with its run ID. Foldkit puts that ID in `/analysis?run=<id>`
   so a reload or shared link can reopen the run.
   [Analysis commands](../client/src/features/analysis-runs/commands.ts) ·
   [Jobs service](../server/src/analysis-runs.ts)
2. **Poll.** Derive subscription dependencies from the model. Analysis Runs
   polls while the page is open and the selected run needs a status check.
   Status and report replies carry the run ID and selection generation, so
   switching runs protects the new selection from late replies.
   [Subscriptions](../client/src/app/browser.ts) · [Analysis update](../client/src/features/analysis-runs/update.ts)
3. **Retrieve.** The SQL job merges its report by `{{job.run_id}}`. Before
   reading the report, the API checks that the run belongs to the configured job
   and has succeeded. Fetch the report by run ID so the browser can retry that
   read independently of submission.
   [Job configuration](../resources/jobs.yml) · [Report SQL](../jobs/route-reliability.sql) ·
   [Jobs service](../server/src/analysis-runs.ts)

The Genie composer offers Chat and Agent mode. Both use `GENIE_SPACE_ID`
and keep their follow-up conversations separate. Agent mode needs workspace
access to the Databricks Agent mode API.

Genie keeps polling across navigation. Save the mode, conversation ID, and
message or response ID so the tab can resume after a reload. Agent mode reads the
response ID from the initial SSE event and retrieves the final report through
the conversation items API. If a submission response is lost before the IDs
arrive, show the uncertain state and let the user check Genie before submitting
again. Capture the question's filters and context when the user sends it.
[Genie update](../client/src/features/genie/update.ts) ·
[Genie commands](../client/src/features/genie/commands.ts) · [Recovery tests](../client/test/browser/genie-recovery.spec.ts)

The taxi app requires Genie. The server fails startup if `DATABRICKS_HOST` or
`GENIE_SPACE_ID` is missing. Each Databricks request checks access to the space.
[Genie service](../server/src/genie/service.ts) · [Startup smoke test](../server/test/built/smoke.test.mjs)

In Databricks Apps, Genie binds each conversation to the authenticated viewer
from the Databricks proxy. The browser keeps the signed grant with the
conversation IDs. Follow-ups, polling, result retrieval, Stop, and CSV export
require that viewer's grant. The viewer-bound Genie service verifies grants before
calling Databricks. CSV downloads wait for transfer capacity before sending
headers and hold it until the body closes. Databricks runs the queries with the
app service principal. Local development uses the configured workspace identity.
[Viewer authorization](../server/src/genie/access.ts) ·
[Forwarded Databricks headers](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers)

## Assign permissions to the identity that uses them

| Identity              | What it does in this app                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Setup identity        | Provisions the bundle resources, runs the seed and grant jobs, and initializes the Lakebase schema.                                   |
| Release identity      | Deploys the bundle and starts the app.                                                                                                |
| App service principal | Uses the warehouse, runs Genie requests, connects to Lakebase, and calls Jobs with `CAN_MANAGE_RUN`.                                  |
| Analysis job `run_as` | Reads the snapshot and writes the report. The principal needs access to the SQL file, the warehouse, and the input and output tables. |
| Viewer                | Supplies the identity shown by `/api/me` and recorded on comments and analysis runs.                                                  |

The bundle lists the app's workspace resource permissions and uses `value_from`
to supply resource IDs to the server. The grant job gives the app access to
the published taxi data and analysis results. Lakebase setup grants access to
the app's PostgreSQL tables.
[App resources](../resources/app.yml) · [Trip access grants](../jobs/grant-trip-access.sql) ·
[Lakebase schema setup](../server/src/lakebase-schema.ts)

For a production deployment, set `run_as.service_principal_name` on the job's
production resource definition. Use the execution principal's application ID
and grant it access to the job inputs and outputs. Databricks uses the job
creator by default. [Job definition](../resources/jobs.yml) ·
[Databricks Jobs permissions](https://docs.databricks.com/aws/en/jobs/privileges)

The sample uses shared app authorization. The viewer headers provide attribution
and analytics results are cached by query inputs. For a feature that needs
per-viewer Unity Catalog permissions, use Databricks user authorization and
provide the proxy's user token to the server-side query for that request. Require
that credential on the route. Disable shared caching there or key it by the
authorization context. Test identical filters for two viewers with different
grants. [Viewer lookup](../server/src/current-user.ts) · [Overview cache](../server/src/taxi/overview.ts) ·
[Databricks user authorization](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth)

Keep the Lakebase connection pool scoped to the server runtime. The sample
initializes it on first use and retries failed discovery on the next operation.
With Lakebase OAuth, each new connection uses a fresh database credential.
Initialize the schema during target setup. [Lakebase service](../server/src/lakebase.ts) ·
[Lakebase setup](../scripts/setup-lakebase.ts)

## Bound upstream work and verify real requests

Create one concurrency limiter per service instance. The warehouse limiter
shares permits across taxi snapshot queries and analysis report reads. Each
query in an Overview request takes a permit. Genie has its own limiter for
submissions. Apply the deadline to permit acquisition and execution so an
expired request cannot start work after waiting in the queue. Each app process
has its own limits.
[Admission control](../server/src/admission.ts) · [Warehouse service](../server/src/warehouse.ts) ·
[Genie service](../server/src/genie/service.ts)

Put cancellation in the Effect that owns the upstream statement. When its
scope closes, the SQL adapter attempts to cancel a known pending or running
statement. A submission timeout before the statement ID arrives leaves the
outcome uncertain. The adapter retries transient connection errors on metadata
reads and leaves submission recovery to the caller.
[Statement lifecycle](../packages/sql-warehouse/src/internal/execution.ts) ·
[Retry policy](../packages/sql-warehouse/src/internal/transport.ts)

Use the hosted smoke check to exercise the resources through the deployed app
and detect missing grants or setup. Playwright waits for the built app to serve
`/`. Databricks Apps also supports an optional deployment check on any HTTP
path you configure.
[Hosted verification](../DEPLOYMENT.md#verify-the-app) · [Playwright config](../playwright.config.ts) ·
[Databricks deployment health checks](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/app-runtime#configure-a-deployment-health-check)

## Run the examples locally

After `pnpm install --frozen-lockfile`, run the tests that exercise the contract,
request lifecycle, and identity handling with local fixtures. The HTTP contract
test runs the generated client through the real handlers with test Layers.

```sh
node --import tsx --test server/test/http-api.test.ts client/test/api-client.test.ts \
  client/test/features.test.ts server/test/analysis-runs.test.ts \
  server/test/current-user.test.ts server/test/lakebase.test.ts \
  server/test/admission.test.ts
```

For browser coverage, install the Playwright browsers, then build and run the
Analysis Runs and Genie tests. These exercise the built UI with fixture API
responses. [Browser setup](../DEPLOYMENT.md#verify-the-app)

```sh
pnpm run build
pnpm run test:browser analysis-runs.spec.ts genie-recovery.spec.ts
```
