import { Clock, Effect, Option, Schema } from "effect";
import { Command, Navigation } from "foldkit";
import {
  AnalysisInput,
  AnalysisRunId,
} from "@dsiem/analytics-shared/analysis-runs";
import { Id } from "@dsiem/analytics-shared/schema";
import { runHref } from "../../app/route";
import { request } from "../../lib/api-client";
import { failure, result } from "../../lib/command-result";
import { Message as M } from "./messages";
import { Selection } from "./model";

export const SubmitAnalysisRun = Command.define("SubmitAnalysisRun", {
  args: {
    input: AnalysisInput,
    retryId: Schema.Option(Id),
    generation: Schema.Int,
  },
  messages: [M.AnalysisSubmitted],
  execute: ({ input, retryId, generation }) =>
    Effect.gen(function* () {
      const requestId = Option.isSome(retryId)
        ? retryId.value
        : yield* Effect.sync(() => crypto.randomUUID());
      const submitted = yield* result(
        request((client) =>
          client.analysisRuns.submit({ payload: { input, requestId } }),
        ),
      );
      return M.AnalysisSubmitted({ ...submitted, requestId, generation });
    }),
});

export const LoadAnalysisHistory = Command.define("LoadAnalysisHistory", {
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

export const LoadAnalysisReport = Command.define("LoadAnalysisReport", {
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

export const OpenAnalysisRun = Command.define("OpenAnalysisRun", {
  args: { id: AnalysisRunId, query: Schema.String },
  messages: [M.CompletedOpenAnalysisRun],
  execute: ({ id, query }) =>
    Navigation.pushUrl(runHref(id, query)).pipe(
      Effect.as(M.CompletedOpenAnalysisRun()),
    ),
});
