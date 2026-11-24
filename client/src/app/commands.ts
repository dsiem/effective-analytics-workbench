import { Effect, Schema } from "effect";
import { Calendar, Command, Dom, Navigation } from "foldkit";
import { request } from "../lib/api-client";
import { done, result } from "../lib/command-result";
import { Message as M } from "./message";
import {
  applyTheme,
  readThemePreference,
  ThemePreference,
  themeStorageKey,
} from "./theme";
export const Navigate = Command.define("Navigate", {
  args: { href: Schema.String, external: Schema.Boolean },
  messages: [M.Idle],
  execute: ({ href, external }) =>
    done(external ? Navigation.load(href) : Navigation.pushUrl(href)),
});
export const Boot = Command.define("RestoreWorkspace", {
  messages: [M.Booted],
  execute: Effect.sync(() => {
    return M.Booted({
      sidebar: !document.cookie.split("; ").includes("sidebar_state=false"),
      mobile: matchMedia("(max-width: 767px)").matches,
      themePreference: readThemePreference(),
    });
  }),
});
export const SetTheme = Command.define("SetTheme", {
  args: { preference: ThemePreference, persist: Schema.Boolean },
  messages: [M.Idle],
  execute: ({ preference, persist }) =>
    done(
      Effect.sync(() => {
        applyTheme(preference);
        if (persist) {
          try {
            localStorage.setItem(themeStorageKey, preference);
          } catch {
            // Keep the selected theme for this session even without storage.
          }
        }
      }),
    ),
});
export const PersistSidebar = Command.define("PersistSidebar", {
  args: { open: Schema.Boolean },
  messages: [M.Idle],
  execute: ({ open }) =>
    done(
      Effect.sync(() => {
        document.cookie = `sidebar_state=${open}; path=/; max-age=604800; SameSite=Lax`;
      }),
    ),
});
export const Focus = Command.define("Focus", {
  args: { selector: Schema.String },
  messages: [M.Idle],
  execute: ({ selector }) =>
    done(
      Effect.sleep("20 millis").pipe(
        Effect.andThen(
          Effect.sync(() =>
            document.querySelector<HTMLElement>(selector)?.focus(),
          ),
        ),
      ),
    ),
});
export const FocusAnalysisHeading = Command.define("FocusAnalysisHeading", {
  messages: [M.Idle],
  execute: done(Dom.focus("#analysis-heading").pipe(Effect.ignore)),
});
export const LoadMetadata = Command.define("LoadMetadata", {
  messages: [M.LoadedMetadata],
  execute: Effect.all({
    result: result(request((client) => client.analytics.metadata())),
    today: Calendar.today.local,
  }).pipe(
    Effect.map(({ result, today }) => M.LoadedMetadata({ ...result, today })),
  ),
});
export const LoadUser = Command.define("LoadUser", {
  messages: [M.LoadedUser],
  execute: result(request((client) => client.viewer.current())).pipe(
    Effect.map(({ data }) => M.LoadedUser({ user: data })),
  ),
});
