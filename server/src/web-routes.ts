import { resolve } from "node:path";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";
import { pagePaths } from "../../shared/page-paths.js";

const webRoot = resolve("client/dist");

const serveFile = (file: string) =>
  HttpServerResponse.file(resolve(webRoot, file)).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
    ),
  );

const Pages = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const index = serveFile("index.html");
    for (const path of Object.values(pagePaths)) {
      yield* router.add("GET", path, index);
    }
    yield* router.add("GET", "/theme-init.js", serveFile("theme-init.js"));
  }),
);

export const WebRoutes = Layer.merge(
  Pages,
  HttpStaticServer.layer({
    root: resolve(webRoot, "assets"),
    prefix: "/assets",
    index: undefined,
  }),
);
