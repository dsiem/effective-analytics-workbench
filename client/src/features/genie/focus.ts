import { Effect } from "effect";
import { Mount } from "foldkit";
import { Message } from "./messages";

// The desktop assistant restores focus when its panel is removed.
export const PanelReturnFocus = Mount.define("PanelReturnFocus", {
  messages: [Message.MountedPanelReturnFocus],
  execute: ({ element }) => {
    const document = element.ownerDocument;
    return Effect.acquireRelease(
      Effect.sync(() =>
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      ),
      (opener) =>
        Effect.sync(() => {
          if (opener?.isConnected) opener.focus();
          else document.querySelector<HTMLElement>("#genie-trigger")?.focus();
        }),
    ).pipe(Effect.as(Message.MountedPanelReturnFocus()));
  },
});
