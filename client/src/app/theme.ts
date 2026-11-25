import { Menu } from "@foldkit/ui";
import { Effect, Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

export const ThemePreference = Schema.Literals(["Dark", "Light", "System"]);
export type ThemePreference = typeof ThemePreference.Type;
export const ThemeMenu = Menu.create<ThemePreference>();
export const Model = Schema.Struct({
  preference: ThemePreference,
  menu: Menu.Model,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  SystemThemeChanged: {},
  GotThemeMenuMessage: { message: Menu.Message },
  CompletedSetTheme: {},
});
export type Message = typeof Message.Type;

export const init = (): Model => ({
  preference: "System",
  menu: Menu.init({ id: "theme" }),
});

const SetTheme = Command.define("SetTheme", {
  args: { preference: ThemePreference, persist: Schema.Boolean },
  messages: [Message.CompletedSetTheme],
  execute: ({ preference, persist }) =>
    Effect.sync(() => {
      applyTheme(preference);
      if (persist) {
        try {
          localStorage.setItem(themeStorageKey, preference);
        } catch {
          // Keep the selected theme for this session even without storage.
        }
      }
      return Message.CompletedSetTheme();
    }),
});

export const restore = (
  model: Model,
  preference: ThemePreference,
): Update.Return<Model, Message> => ({
  model:
    model.preference === preference
      ? model
      : modifyFields(model, { preference: () => preference }),
  commands: [SetTheme({ preference, persist: false })],
});

const menuMessage = (message: Menu.Message) =>
  Message.GotThemeMenuMessage({ message });

const updateMenu = Update.foldChild({
  update: ThemeMenu.update,
  read: (model: Model) => Option.some(model.menu),
  write: (model, menu) => modifyFields(model, { menu: () => menu }),
  toParentMessage: menuMessage,
  foldOutMessage:
    ({ value }) =>
    (model) => ({
      model: modifyFields(model, { preference: () => value }),
      commands: [SetTheme({ preference: value, persist: true })],
    }),
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SystemThemeChanged: () =>
      model.preference === "System" ? restore(model, "System") : { model },
    GotThemeMenuMessage: ({ message }) => updateMenu(model, message),
    CompletedSetTheme: () => ({ model }),
  });

export function closeMenu(model: Model): Update.Return<Model, Message> {
  if (!model.menu.isOpen) return { model };
  const closed = ThemeMenu.close(model.menu);
  return {
    model: modifyFields(model, { menu: () => closed.model }),
    commands: (closed.commands ?? []).map((command) =>
      Command.mapMessage(command, menuMessage),
    ),
  };
}

export const themeStorageKey = "databricks-effect-app.theme.v1";
export const systemThemeQuery = "(prefers-color-scheme: dark)";

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    if (Schema.is(ThemePreference)(stored)) return stored;
  } catch {
    // The system preference still works when browser storage is unavailable.
  }
  return "System";
}

export function applyTheme(preference: ThemePreference) {
  const dark =
    preference === "Dark" ||
    (preference === "System" && matchMedia(systemThemeQuery).matches);
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim(),
    );
}
