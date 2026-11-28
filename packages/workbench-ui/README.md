# Analytics workspaces for Foldkit

Use `@dsiem/workbench-ui` to render typed rows as a chart, a table, or a set
of metric cards in a Foldkit view. Install the package alongside compatible
versions of Foldkit, `@foldkit/ui` and Effect. From this checkout you can build a local
distribution with `pnpm --filter @dsiem/workbench-ui pack`.

Import the stylesheet once from the browser entry point. Its CSS includes
default colors, responsive metric layout, chart axes and scrollable tables.
An app can set CSS custom properties such as `--chart-color`, `--surface`,
`--border` and `--muted` on a report's ancestor.

```ts
import "@dsiem/workbench-ui/styles.css";
import {
  metricGrid,
  recordTable,
  seriesChart,
  type H,
  type TableColumn,
} from "@dsiem/workbench-ui";

type Bin = { name: string; available: number; target: number };

const binColumns = [
  { header: "Bin", cell: (bin) => bin.name },
  { header: "In stock", cell: (bin) => String(bin.available) },
] satisfies readonly TableColumn<Bin>[];

export function replenishmentReport<Message>(
  h: H<Message>,
  bins: readonly Bin[],
) {
  const shortage = (row: Bin) => Math.max(0, row.target - row.available);
  return h.section(
    [],
    [
      metricGrid(h, bins, [
        {
          label: "Bins below target",
          value: (rows) =>
            String(rows.filter((row) => shortage(row) > 0).length),
          detail: "Current inventory",
        },
      ]),
      seriesChart(h, bins, {
        title: "Restock quantity by bin",
        kind: "bar",
        label: (row) => row.name,
        value: shortage,
      }),
      recordTable(h, bins, {
        caption: "Bin stock levels",
        key: (row) => row.name,
        columns: binColumns,
      }),
    ],
  );
}
```

For formatted charts, pass `formatValue` for point tooltips and `formatTick`
for axis labels. Supply `"area"` to plot a time series. The table preserves
row order and uses the supplied key to identify each rendered row. Cell
callbacks can return Foldkit HTML, including links or buttons with your
application's messages. A metric's optional `icon` accepts a rendered child.

`card`, `title` and `panelHeader` arrange these report components.

Pass `binColumns` to the `columns` option of `createRecordExplorer` to use
the same cells in a sortable list with an inspector.

## Compose filters with a report

Import `@dsiem/workbench-ui/workspace.css` after the report stylesheet for
form and button styles. The filter panel renders your fields and submits a
message to your page. An inventory report can use one text field:

```ts
import { field, filterPanel } from "@dsiem/workbench-ui/filters";

filterPanel(h, {
  label: "Inventory filters",
  fields: [
    field(h, {
      id: "bin",
      label: "Storage bin",
      value: draft.bin,
      onInput: (bin) => ChangedBin({ bin }),
    }),
  ],
  hasChanges: draft.bin !== applied.bin,
  onApply: ApplyFilters(),
});
```

Add a reset message with `onReset`. Put a saved-view picker or export button
in the optional `toolbar` array. The app owns draft values, URL encoding,
validation and the Effect that loads matching rows. It can pass an `error`
to the panel and an `appliedSummary` to show alongside unapplied changes.

## Mount a report with loading and retry

`mountQueryPage` renders the page heading and runs the supplied Effect when
the page opens. On failure, the user can retry the same request. The result
schema describes the rows supplied to `content`.

```ts
import { Effect, Schema } from "effect";
import { title } from "@dsiem/workbench-ui";
import { mountQueryPage } from "@dsiem/workbench-ui/query-page";

const Bins = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    available: Schema.Finite,
    target: Schema.Finite,
  }),
);

mountQueryPage({
  container: document.getElementById("root"),
  result: Bins,
  load: Effect.succeed([{ name: "A1", available: 3, target: 7 }]),
  heading: (h) => [title(h, "Replenishment", "Current stock against target")],
  content: (h, bins) => [replenishmentReport(h, bins)],
});
```

Replace `load` with a typed HTTP client request and map request failures to
messages for the reader.

To embed a report in an existing Foldkit runtime, call
`createQueryPage({ result, load })` from the same module. Add the returned
`Model` schema as a field in the parent and give that field its own message
wrapper. Fold the child's `init()` and `update(model, message)` results with
`Update.foldChildInit` to route command completions back to that field. The
parent can provide services needed by the load Effect.

Spread `report.view(model.report, h, { onMessage, content })` into the parent
view. Pass the same wrapper as `onMessage` for the retry button. The content
callback receives the parent's HTML builder, so a report row can open another
feature through a parent message. Each mounted child tracks its own request
generation. [Parent command and retry test](test/query-page.test.ts)

## Compose a workspace

Use `defineWorkspace` from `@dsiem/workbench-ui/workspace` to declare page identifiers, paths and labels. Serve `workspace.paths` from the HTTP server and pass a mount function for every page to `workspace.mount`. Include an icon in each page definition and call `workspace.links(activePage, href)` to build the sidebar. The supplied href function carries the current selection. Use `workspace.href` to encode those query parameters.

To use the taxi workbench's responsive sidebar, breadcrumb and appearance
menu, import `tailwindcss`, `@dsiem/workbench-ui/styles.css` and
`@dsiem/workbench-ui/workspace.css` in that order in your Tailwind CSS 4
entry. Install `@foldkit/ui` alongside Foldkit. Call `mountWorkspaceFrame`
once from your page entry and mount your report into the supplied element.

```ts
import { mountWorkspaceFrame } from "@dsiem/workbench-ui/workspace-frame";

mountWorkspaceFrame({
  container: document.getElementById("root"),
  brand: {
    name: "Inventory",
    description: "Operations",
    href: "/",
    icon: "route",
  },
  current: "Stock",
  links: [
    { id: "stock", label: "Stock", href: "/", icon: "table-2", current: true },
  ],
  mount: (element) => mountStockReport(element),
});
```

Use `toolbar` for report filters and `headerActions` for contextual actions.
Each callback receives a Foldkit HTML builder and returns children. The frame
manages the mobile navigation dialog, sidebar keyboard shortcut and appearance
preference. To use these controls inside an existing Foldkit program, call
`workspaceFrame(h, options)` from its view and delegate messages to the layout
and theme modules. [Taxi integration](../../client/src/app/view.ts)

## Embed Genie chat in a Foldkit page

`createAssistant` takes the schema of the selection your page wants to discuss. Both callbacks receive that selection. Your API decides which evidence and instructions to send to Genie.

```ts
import { createAssistant } from "@dsiem/workbench-ui/assistant";

const chat = createAssistant({
  scope: StationSelection,
  connect: (scope) => connectionFor(scope),
  ask: (turn) => askAboutReadings(turn),
  suggestion: (scope) => `What changed at ${scope.station}?`,
  setup: "Connect a Genie space to ask about these readings.",
});
```

Here `connectionFor` returns an Effect with `{ configured, description? }`. The optional description can identify the actual dataset and filters used. `askAboutReadings` receives `{ scope, question, continuation }` and returns an Effect with the answer text, tables and next continuation. Both operations use a string error channel and can require services supplied by the parent runtime.

Add `chat.Model` to the parent model and wrap `chat.Message` in a parent message. Initialize it once with `chat.init(null)` for an empty selection or `chat.init(scope)` for an active one. In the parent's update, fold the results of `chat.update` and `chat.setScope` with Foldkit's `Update.foldChildInit`. Render `...chat.view(model.chat, h, { onMessage: toChat })` wherever the conversation belongs.

Use `setScope(model.chat, selection)` when the user selects a row or applies filters. Schema-equivalent selections preserve the draft and follow-up token. A different selection starts a fresh conversation. Use `setScope(model.chat, null)` to deselect while outstanding commands complete. Keeping the same child model in the parent lets it recognize and discard late responses across selection changes.

`mountAssistant` remains the standalone entry point for a page with a heading and a fixed context. It uses the same conversation component.

## Save and reopen findings

`makeFindingsFeature` from `@dsiem/workbench-ui/findings` provides a Foldkit
model, messages, update function and view. Mount them with
`Runtime.makeElement` or embed the feature in an existing page. Supply the
app's filter schema, an Effect that reads the active filters, and four
operations for listing, saving, pinning and deleting findings. `describe`
summarizes the stored filters and `href` opens the matching report.

The component owns search, cursor paging, a draft editor and confirmation
before deletion. Edits, pins and deletes use the version the user saw. If a
write fails, the component refreshes the list and keeps an editor's draft
available. The user can save a stale edit as a new finding or cancel and
open the current version.

For a custom picker, compose `createFindingSearch` and `createFindingWrites`.
The first owns typed search, cursor paging, and cancellation. The second owns
the draft, confirmed deletion, and version sent with each change. The taxi
picker uses both and handles its own recent views, shortcuts, focus and
navigation. [Picker integration](../../client/src/features/saved-views/workflow.ts)

Pass a generated saved-views HTTP group to `findingsClient` to bind all four
operations. It closes each request scope and preserves server conflict
messages. An app can supply `{ onError, timeout }` to map failures to its
own permission notices and set its request deadline.

For existing embeddings, user actions such as `Message.Search({ value })`,
`Message.Edit({ row })` and `Message.Save()` keep their signatures. A custom
view reads `model.search.query`, `model.search.data` and `model.writes.panel`.
Feed command completions back into `update` to settle pending operations.

## Browse and annotate individual records

Import `mountRecordExplorer` from `@dsiem/workbench-ui/record-explorer` to
mount a sorted list and inspector into a container. Supply the row and detail
schemas, a nonempty list of sort keys, column formatters, a stable row key,
and two Effects. `load(sort)`
returns the selected records in the requested order. `inspect(row)` fetches the
full record on demand. Capture the current filters when creating these Effects.
Render domain-specific details with `inspector`. Add a `heading`, a
`sortLabel` or an `inspectLabel` when the defaults need more context.

```ts
const stock = createRecordExplorer({
  row: BinSummary,
  detail: BinDetail,
  sorts: ["name", "available"],
  key: (bin) => bin.name,
  caption: "Stock levels",
  columns: binColumns,
  load: (sort) => inventory.list(sort),
  inspect: (bin) => inventory.lookup(bin.name),
  inspector: (h, bin) => [h.p([], [bin.location])],
});
```

For a discussion thread, supply `comments.list(row, cursor)` and
`comments.post(row, id, body)`. Return a cursor with each page that has older
comments. Persist the supplied posting ID to support retries after an uncertain
response. The explorer retains drafts by row while the page is mounted.

Use `createRecordExplorer(options)` to embed the explorer in a larger Foldkit
program. Its initial load, sort changes and inspection requests use ordinary
Foldkit commands. The list and inspection track their requests independently.
The default grid renders every returned row and accepts cells of different
heights. For large lists, set `fixedRowHeight` in CSS pixels to render only
the visible window and a few nearby rows. Cells clip content to that height.

For a custom record screen, the same module exports `recordList` and
`recordInspector`. Supply `pages(query)` for progressive results and install
the list subscriptions in the parent. A single-response list supplies
`load(query)` as an Effect. In either case, call `list.load(model, query)`
and fold its result into the parent. The inspector owns detail requests, comment paging,
per-row drafts and post retry IDs. Its optional comment source defines the
note and cursor schemas. It emits read commands by default. A host that
sets `reads: "subscriptions"` installs the inspector subscriptions so closing
a selection interrupts its detail and comment reads. The taxi screen uses these two components, adds
comment counts and renders a window of uniform-height rows.
[Taxi record integration](../../client/src/features/trips/records.ts)

Embedded callers that previously read `model.rows` can read `model.preview`
for loading, partial rows, failure and completion. Selection and detail now
live under `model.inspector`. Per-row drafts live in `model.commentDrafts`.

## Submit an analysis and open its history

`mountRunPage` from `@dsiem/workbench-ui/run-page` mounts a typed form, recent
run links and a selected report. Supply the draft, history row and report
schemas, plus functions for loading the list, opening the selected run and
submitting a draft. A submission returns the URL of its report. Retrying an
unchanged draft after a failed response uses the same request ID. On success,
the form clears that ID before opening the report URL. A fragment URL keeps
the form on screen, ready to submit another run. Field labels and report
contents belong to the consuming application.
