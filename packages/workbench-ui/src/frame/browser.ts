import { Effect, Queue, Stream } from "effect";
import * as Layout from "./layout.js";
import * as Theme from "./theme.js";

const compactScreen = "(max-width: 767px)";

export const readFramePreferences = () => ({
  sidebar: !document.cookie.split("; ").includes("sidebar_state=false"),
  mobile: matchMedia(compactScreen).matches,
  themePreference: Theme.readThemePreference(),
});

export function frameEvents<M>(
  layout: (message: Layout.Message) => M,
  theme: (message: Theme.Message) => M,
) {
  return Stream.callback<M>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const media = matchMedia(compactScreen);
        const appearance = matchMedia(Theme.systemThemeQuery);
        const keydown = (event: KeyboardEvent) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "b"
          ) {
            event.preventDefault();
            Queue.offerUnsafe(queue, layout(Layout.Message.ToggleSidebar()));
          }
        };
        const resize = () =>
          Queue.offerUnsafe(
            queue,
            layout(Layout.Message.Resized({ mobile: media.matches })),
          );
        const themeChanged = () =>
          Queue.offerUnsafe(queue, theme(Theme.Message.SystemThemeChanged()));
        window.addEventListener("keydown", keydown);
        media.addEventListener("change", resize);
        appearance.addEventListener("change", themeChanged);
        return () => {
          window.removeEventListener("keydown", keydown);
          media.removeEventListener("change", resize);
          appearance.removeEventListener("change", themeChanged);
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ),
  );
}
