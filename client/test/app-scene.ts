import { Option } from "effect";
import { Url } from "foldkit";
import { Command, Subscription } from "foldkit/scene";
import * as Features from "../src/app/features";
import { Message } from "../src/app/message";
import { Message as NavigationMessage, Navigate } from "../src/app/navigation";
import { init, update } from "../src/app/update";
import { view } from "../src/app/view";
import { calendarDay } from "../src/lib/format";
import { succeed } from "../src/lib/command-result";

export const app = { update, view };

const url = (href: string) => new URL(href, "http://localhost");

export function open(href: string) {
  const location = Option.getOrThrow(Url.fromString(url(href).href));
  return init(location).model;
}

export function withDataset(href: string) {
  return update(
    open(href),
    Message.LoadedMetadata({
      result: succeed({ from: "2016-01-03", to: "2016-02-25", trips: 21932 }),
      today: Option.getOrThrow(calendarDay("2016-02-01")),
    }),
  ).model;
}

export function followNavigation(href: string) {
  const { pathname, search } = url(href);
  return [
    Command.resolve(
      Navigate({ href, external: false }),
      NavigationMessage.CompletedNavigate(),
    ),
    Subscription.emit(
      Features.navigation.toParentMessage(
        NavigationMessage.Navigated({ path: pathname, query: search.slice(1) }),
      ),
    ),
  ] as const;
}
