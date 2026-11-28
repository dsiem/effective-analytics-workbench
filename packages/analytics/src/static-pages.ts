import { resolve } from "node:path";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";

/** Serve a built client at its declared page URLs and Vite asset paths. */
export function staticPages(
  root: string,
  paths: readonly `/${string}`[],
  publicFiles: readonly string[] = [],
) {
  const serveFile = (name: string) =>
    HttpServerResponse.file(resolve(root, name)).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    );

  const pages = HttpRouter.use((router) =>
    Effect.gen(function* () {
      const index = serveFile("index.html");
      for (const path of paths) yield* router.add("GET", path, index);
      for (const name of publicFiles)
        yield* router.add("GET", `/${name}`, serveFile(name));
    }),
  );
  return Layer.merge(
    pages,
    HttpStaticServer.layer({
      root: resolve(root, "assets"),
      prefix: "/assets",
      index: undefined,
    }),
  );
}
