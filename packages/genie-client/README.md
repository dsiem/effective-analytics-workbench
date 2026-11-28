# Genie Client for Effect

Use Databricks Genie in Chat and Agent mode from Node.js 22.19+ with Effect
`~4.1.4`. `@dsiem/genie-client` is a private workspace package.
[Databricks Genie API](https://docs.databricks.com/api/genie/v1/conversation)

This project is independently maintained and is not affiliated with or endorsed by Databricks, Inc.

## Build from this workspace

Run `pnpm --filter @dsiem/genie-client run build` at the repository root.

Use `GenieAnswer` as the parameter type for code that displays results from
both modes. It contains the attachments in response order and an optional
warning with the number of unsupported attachments.

## Chat mode

Pass a Genie space ID and a `request` function that sends authenticated
requests and returns the parsed JSON body in an Effect.
[App transport](../../server/src/genie/service.ts)

```ts
import { Effect } from "effect";
import { makeGenieClient } from "@dsiem/genie-client";

const client = makeGenieClient({ spaceId, request });
const operation = await Effect.runPromise(
  client.submit({ content: "What data is available?" }),
);
```

- Save the operation from `submit` to resume the turn later. Pass its
  `conversationId` to `submit` for follow-up questions.
- Call `poll(operation)` to check status once. Set the polling interval and
  deadline in your application.
- Call `result(operation)` when the turn completes to get the message
  attachments. Inline query results can be partial. A pending or unavailable
  SQL result fails with `GenieQueryUnavailable`.
- If Genie returns unfamiliar attachment types, `result` returns the supported
  attachments and a `warning` with the unsupported attachment count.

A lost submission response can leave an accepted turn. Check Genie before
resubmitting.

## Ask about a report

Pass the dataset's table and filter semantics to `analysisQuestion`. Each
question carries its own filter values and can include a snapshot of the
visible report. Both modes accept the resulting string as `content`.

```ts
import { analysisQuestion, recentRowsSnapshot } from "@dsiem/genie-client";

const data = recentRowsSnapshot({
  fields: { stationCount: 2, unit: "°C" },
  rowsKey: "readings",
  rows: [
    { station: "Ridge", temperature: -2.5 },
    { station: "Valley", temperature: 3.1 },
  ],
  maxLength: 2000,
});

const content = analysisQuestion(
  {
    table: "weather.daily",
    filterInstructions: "Apply region to station_region.",
  },
  {
    content: "Which stations recorded frost?",
    filters: { region: "North" },
    context: { title: "Daily temperatures", ...(data ? { data } : {}) },
  },
);
```

Supply rows in chronological order to retain the newest rows within the
JSON character limit. When the fixed fields alone exceed the limit,
`recentRowsSnapshot` returns `undefined` so the caller can supply a smaller
summary. The table and filter instructions come from server configuration.
Filter values and snapshots come from the current view.

## Serve a report conversation

For a local single-user server, `makeReportAssistant` from `@dsiem/genie-client/report-assistant` accepts HTTPS workspace settings and dataset instructions. Call the returned function with the question, filters, report snapshot and previous continuation. It submits once, polls for completion, and returns text plus up to 100 rows per inline table. A signed continuation identifies the next turn within that server process. For a recoverable workflow, call `assistant.submit(input)` and store the returned signed receipt before waiting. Call `assistant.resume(receipt)` to fetch the answer, including after a page reload. Resuming only reads the accepted operation. The receipt is valid for the lifetime of the assistant instance. Treat it as a bearer credential. The existing callable interface still submits and waits in one step. Its `AnswerUnavailable` error includes the receipt in `accepted`. An invalid follow-up token returns `ExpiredContinuation`, and an unconfirmed submission has no receipt. The taxi workspace uses the same underlying operation IDs with its own viewer-bound authorization.

## Agent mode

Agent mode requires workspace access to the Databricks Agent mode API. Pass the
Genie space ID as `agentId` to
`makeGenieAgentClient({ agentId, requestJson, requestEvents })`.
`requestJson` returns the parsed body for item and cancel requests.
`requestEvents` sends the submission body with `Accept: text/event-stream`
and runs the supplied reader on the response byte stream within the HTTP
response scope. The reader returns the operation IDs from `response.created`.
[App transport](../../server/src/genie/service.ts)

Use `submit`, `poll`, and `result` as in Chat mode. Agent operations carry a
response ID, and `result` returns the final report. Use each conversation ID
with the mode that created it. Call `cancel(operation)` to stop an Agent
response in Databricks.

If `poll` returns `unresolved`, Genie has yet to show that response in its
conversation history. Retry within your polling deadline using the same IDs.
