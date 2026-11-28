import { Effect, Schema } from "effect";
import { Command, Mount, Runtime, Subscription, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { H, Child } from "../primitives.js";
import { frameEvents, readFramePreferences } from "./browser.js";
import * as Layout from "./layout.js";
import * as Theme from "./theme.js";
import { workspaceFrame, type FrameNavigation } from "./view.js";

const Model = Schema.Struct({ layout: Layout.Model, theme: Theme.Model });
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  Layout: { message: Layout.Message },
  Theme: { message: Theme.Message },
  MountedPage: {},
});
type Message = typeof Message.Type;
const toLayout = (message: Layout.Message) => Message.Layout({ message });
const toTheme = (message: Theme.Message) => Message.Theme({ message });

function withLayout(
  parent: Model,
  result: Update.Return<Layout.Model, Layout.Message>,
): Update.Return<Model, Message> {
  return {
    model: { ...parent, layout: result.model },
    commands:
      result.commands?.map((command) =>
        Command.mapMessage(command, toLayout),
      ) ?? [],
  };
}
function withTheme(
  parent: Model,
  result: Update.Return<Theme.Model, Theme.Message>,
): Update.Return<Model, Message> {
  return {
    model: { ...parent, theme: result.model },
    commands:
      result.commands?.map((command) => Command.mapMessage(command, toTheme)) ??
      [],
  };
}
const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  frame: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () => frameEvents<Message>(toLayout, toTheme),
    },
  ),
}));
const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Update.combine(model, [
    (parent) =>
      Message.match<Update.Return<Model, Message>>(message, {
        Layout: ({ message }) =>
          withLayout(parent, Layout.update(parent.layout, message)),
        Theme: ({ message }) =>
          withTheme(parent, Theme.update(parent.theme, message)),
        MountedPage: () => ({ model: parent }),
      }),
    (parent) =>
      parent.layout.mobile &&
      !parent.layout.mobileNavigation &&
      parent.theme.menu.isOpen
        ? withTheme(parent, Theme.closeMenu(parent.theme))
        : { model: parent },
    (parent) => withLayout(parent, Layout.syncNavigationDialog(parent.layout)),
  ]);

export function mountWorkspaceFrame(
  options: FrameNavigation & {
    readonly container: HTMLElement | null;
    readonly contentId?: string;
    readonly toolbar?: <M>(h: H<M>) => readonly Child[];
    readonly controls?: <M>(h: H<M>) => readonly Child[];
    readonly headerActions?: <M>(h: H<M>) => readonly Child[];
    readonly mount: (element: HTMLElement) => void;
  },
) {
  const pageMount = Mount.define("WorkspacePage", {
    messages: [Message.MountedPage],
    execute: ({ element }) =>
      Effect.sync(() => {
        // Foldkit replaces a page program's root element. Its host stays in the frame's tree.
        const page = document.createElement("div");
        page.id = options.contentId ?? "workspace-page";
        element.append(page);
        options.mount(page);
        return Message.MountedPage();
      }),
  });
  return Runtime.run(
    Runtime.makeElement<Model, Message>({
      container: options.container,
      Model,
      subscriptions,
      update,
      init: () => {
        const preferences = readFramePreferences();
        const parent = {
          layout: Layout.restore(Layout.init(), preferences),
          theme: Theme.init(),
        };
        return withTheme(
          parent,
          Theme.restore(parent.theme, preferences.themePreference),
        );
      },
      view: (model, h) =>
        workspaceFrame(h, {
          ...options,
          ...model,
          onLayout: toLayout,
          onTheme: toTheme,
          headerActions: options.headerActions?.(h) ?? [],
          toolbar: options.toolbar?.(h) ?? [],
          controls: options.controls?.(h) ?? [],
          contentLandmark: "div",
          content: [h.div([h.Key("page"), h.OnMount(pageMount())], [])],
        }),
    }),
  );
}
