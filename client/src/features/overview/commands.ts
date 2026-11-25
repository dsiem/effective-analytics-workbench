import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { Filters } from "@dsiem/analytics-shared/filters";
import { request } from "../../lib/api-client";
import { result } from "../../lib/command-result";
import { Message as M } from "./messages";
export const LoadOverview = Command.define("LoadOverview", {
  args: { generation: Schema.Int, filters: Filters },
  messages: [M.LoadedOverview],
  execute: ({ generation, filters }) =>
    result(
      request((client) => client.analytics.overview({ query: filters })),
    ).pipe(Effect.map((value) => M.LoadedOverview({ generation, ...value }))),
});
