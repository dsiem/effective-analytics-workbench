import { Effect, Schema } from "effect";
import { Calendar, Command, Dom } from "foldkit";
import { request } from "../lib/api-client";
import { result } from "../lib/command-result";
import { Message as M } from "./message";
import { readThemePreference } from "./theme";
export const RestoreWorkspace = Command.define("RestoreWorkspace", {
  messages: [M.Booted],
  execute: Effect.sync(() => {
    return M.Booted({
      sidebar: !document.cookie.split("; ").includes("sidebar_state=false"),
      mobile: matchMedia("(max-width: 767px)").matches,
      themePreference: readThemePreference(),
    });
  }),
});
export const Focus = Command.define("Focus", {
  args: { selector: Schema.String },
  messages: [M.CompletedFocus],
  execute: ({ selector }) =>
    Effect.sleep("20 millis").pipe(
      Effect.andThen(
        Effect.sync(() =>
          document.querySelector<HTMLElement>(selector)?.focus(),
        ),
      ),
      Effect.as(M.CompletedFocus()),
    ),
});
export const FocusAnalysisHeading = Command.define("FocusAnalysisHeading", {
  messages: [M.CompletedFocusAnalysisHeading],
  execute: Dom.focus("#analysis-heading").pipe(
    Effect.ignore,
    Effect.as(M.CompletedFocusAnalysisHeading()),
  ),
});
export const LoadMetadata = Command.define("LoadMetadata", {
  messages: [M.LoadedMetadata],
  execute: Effect.all({
    result: result(request((client) => client.analytics.metadata())),
    today: Calendar.today.local,
  }).pipe(
    Effect.map(({ result, today }) => M.LoadedMetadata({ result, today })),
  ),
});
export const LoadUser = Command.define("LoadUser", {
  messages: [M.LoadedUser],
  execute: result(request((client) => client.viewer.current())).pipe(
    Effect.map((result) => M.LoadedUser({ result })),
  ),
});
