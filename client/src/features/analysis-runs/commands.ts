import { Clock, Effect, Schema } from "effect";
import { Command, Navigation } from "foldkit";
import {
  AnalysisInput,
  AnalysisRunId,
} from "@dsiem/analytics-shared/analysis-runs";
import { Id } from "@dsiem/analytics-shared/schema";
import { request } from "../../lib/api-client";
import { done, failure, result } from "../../lib/command-result";
import { Message as M } from "./messages";
import { runHref } from "../../app/route";
import { Selection } from "./model";

export const Submit = Command.define("SubmitAnalysisRun", {
  args: {
    input: AnalysisInput,
    retryId: Schema.NullOr(Id),
    generation: Schema.Int,
  },
  messages: [M.AnalysisSubmitted],
  execute: ({ input, retryId, generation }) =>
    Effect.gen(function* () {
      const requestId =
        retryId ?? (yield* Effect.sync(() => crypto.randomUUID()));
      const submitted = yield* result(
        request((client) =>
          client.analysisRuns.submit({ payload: { input, requestId } }),
        ),
      );
      return M.AnalysisSubmitted({ ...submitted, requestId, generation });
    }),
});

export const LoadHistory = Command.define("LoadAnalysisHistory", {
  args: { generation: Schema.Int },
  messages: [M.LoadedAnalysisHistory],
  execute: ({ generation }) =>
    request((client) => client.analysisRuns.list()).pipe(
      Effect.scoped,
      Effect.mapError(failure),
      Effect.result,
      Effect.map((result) => M.LoadedAnalysisHistory({ generation, result })),
    ),
});

export const loadStatus = (selection: typeof Selection.Type) =>
  Effect.gen(function* () {
    const status = yield* request((client) =>
      client.analysisRuns.get({ params: { id: selection.id } }),
    ).pipe(Effect.scoped, Effect.mapError(failure), Effect.result);
    const observedAt = yield* Clock.currentTimeMillis;
    return M.LoadedAnalysisStatus({
      ...selection,
      observedAt,
      result: status,
    });
  });

export const LoadReport = Command.define("LoadAnalysisReport", {
  args: Selection.fields,
  messages: [M.LoadedAnalysisReport],
  execute: (selection) =>
    result(
      request((client) =>
        client.analysisRuns.result({ params: { id: selection.id } }),
      ),
    ).pipe(
      Effect.map((loaded) =>
        M.LoadedAnalysisReport({ ...selection, ...loaded }),
      ),
    ),
});

export const OpenRun = Command.define("OpenAnalysisRun", {
  args: { id: AnalysisRunId, query: Schema.String },
  messages: [M.Idle],
  execute: ({ id, query }) => done(Navigation.pushUrl(runHref(id, query))),
});
