import { Filters } from "@dsiem/analytics-shared/filters";
import {
  createFindingSearch,
  createFindingWrites,
  findingsClient,
} from "@dsiem/workbench-ui/findings";
import { Effect } from "effect";
import { ApiClient } from "../../lib/api-client";
import { failure } from "../../lib/command-result";
import { Notice } from "../../lib/request-state";

const operations = findingsClient(
  Effect.map(ApiClient, (client) => client.savedViews),
  { onError: failure, timeout: "2 minutes" },
);
export const search = createFindingSearch({
  filters: Filters,
  error: Notice,
  list: operations.list,
});
export const writes = createFindingWrites({
  ...operations,
  filters: Filters,
  error: Notice,
  newFinding: { input: Filters, filters: Effect.succeed },
});
