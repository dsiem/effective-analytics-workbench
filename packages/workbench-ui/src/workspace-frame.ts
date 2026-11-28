export {
  workspaceFrame,
  type FrameBrand,
  type FrameLink,
  type FrameNavigation,
  type FrameOptions,
} from "./frame/view.js";
export { mountWorkspaceFrame } from "./frame/mount.js";
export { frameEvents, readFramePreferences } from "./frame/browser.js";
export { icon, type IconName } from "./frame/icons.js";
export { dialog } from "./frame/dialog.js";
export { syncDialog } from "./frame/sync-dialog.js";
export { button, type ButtonOptions } from "./frame/button.js";
