import { once } from "node:events";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Cause, Effect, Exit, Layer, Runtime } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
import { AnalysisRuns } from "./analysis-runs.js";
import { Analytics } from "./taxi/analytics.js";
import { ServerConfig } from "./config.js";
import { Genie } from "./genie/service.js";
import { Lakebase } from "./lakebase.js";
import { Routes } from "./routes.js";
import { SavedViews } from "./saved-views.js";
import { Settings } from "./settings.js";
import { TripComments } from "./trip-comments.js";
import { Warehouse } from "./warehouse.js";
import { Workspace } from "./workspace.js";

const isDev = process.argv[2] === "--dev";
const sendToDev = isDev ? process.send?.bind(process) : undefined;
const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig;
    const selectedPort =
      sendToDev && port === 0
        ? yield* Effect.promise(async () => {
            const reply = once(process, "message");
            sendToDev({ type: "dev:api-port" });
            const [selected]: unknown[] = await reply;
            return typeof selected === "number" ? selected : 0;
          })
        : port;
    return NodeHttpServer.layer(createServer, {
      host: isDev ? "127.0.0.1" : host,
      port: selectedPort,
      gracefulShutdownTimeout: "5 seconds",
    });
  }),
);

const Services = Layer.mergeAll(
  Analytics.layer,
  AnalysisRuns.layer,
  Genie.layer,
  SavedViews.layer,
  TripComments.layer,
).pipe(
  Layer.provideMerge(Lakebase.layer),
  Layer.provideMerge(Warehouse.layer),
  Layer.provideMerge(Workspace.layer),
  Layer.provideMerge(Settings.layer),
);
const AppLive = HttpRouter.serve(Routes.pipe(Layer.provide(Services))).pipe(
  Layer.provideMerge(ServerLive),
);
const ReportDevPort = Layer.effectDiscard(
  HttpServer.HttpServer.use(({ address }) =>
    Effect.sync(() => {
      if (NetAddress.isInetAddress(address)) {
        sendToDev?.({ type: "dev:api-ready", port: address.port });
      }
    }),
  ),
);

NodeRuntime.runMain(
  Layer.launch(
    sendToDev ? ReportDevPort.pipe(Layer.provide(AppLive)) : AppLive,
  ),
  {
    teardown: (exit, finish) =>
      Runtime.defaultTeardown(exit, (code) => {
        if (
          sendToDev &&
          Exit.isFailure(exit) &&
          !Cause.hasInterruptsOnly(exit.cause)
        ) {
          sendToDev({ type: "dev:api-failed", code }, () => finish(code));
        } else {
          finish(code);
        }
      }),
  },
);
