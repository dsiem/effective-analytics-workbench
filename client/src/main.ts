import { Layer, Option } from "effect";
import { Runtime, Url } from "foldkit";
import { subscriptions } from "./app/browser";
import * as Features from "./app/features";
import { Message as NavigationMessage } from "./app/navigation";
import { Model } from "./app/model";
import { init, update } from "./app/update";
import { view } from "./app/view";
import { GeniePolling } from "./features/genie/subscription";
import { ApiClient } from "./lib/api-client";
import "./styles.css";

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    subscriptions,
    resources: Layer.merge(ApiClient.layer, GeniePolling.layer),
    container: document.getElementById("root"),
    routing: {
      onUrlRequest: (request) =>
        Features.navigation.toParentMessage(
          NavigationMessage.Navigate({
            href:
              request._tag === "Internal"
                ? Url.toString(request.url)
                : request.href,
            external: request._tag === "External",
          }),
        ),
      onUrlChange: (url) =>
        Features.navigation.toParentMessage(
          NavigationMessage.Navigated({
            path: url.pathname,
            query: Option.getOrElse(url.search, () => "").replace(/^\?/, ""),
          }),
        ),
    },
  }),
);
