import { Effect, Schema } from "effect";
import { Command, Navigation } from "foldkit";
import type { Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { type Location, parseLocation, routePath } from "./route";

export const Message = defineMessageUnion({
  Navigate: { href: Schema.String, external: Schema.Boolean },
  Navigated: { path: Schema.String, query: Schema.String },
  CompletedNavigate: {},
});
export type Message = typeof Message.Type;

export const Navigate = Command.define("Navigate", {
  args: { href: Schema.String, external: Schema.Boolean },
  messages: [Message.CompletedNavigate],
  execute: ({ href, external }) =>
    (external ? Navigation.load(href) : Navigation.pushUrl(href)).pipe(
      Effect.as(Message.CompletedNavigate()),
    ),
});

type Out = "LocationChanged" | "LocationRepeated";

export const update = (model: Location, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Location, Message, Out>>(message, {
    Navigate: (destination) => ({ model, commands: [Navigate(destination)] }),
    Navigated: ({ path, query }) =>
      routePath(model.route) === path && model.query === query
        ? { model, outMessage: "LocationRepeated" }
        : { model: parseLocation(path, query), outMessage: "LocationChanged" },
    CompletedNavigate: () => ({ model }),
  });
