import { Filters } from "./filters.js";
import { savedViewSchemas } from "@dsiem/analytics/contracts";
export {
  SavedViewCursor,
  SavedViewPin,
  SavedViewSearch,
  SavedViewVersion,
} from "@dsiem/analytics/contracts";

export const { SavedViewInput, SavedView, SavedViewsPage } =
  savedViewSchemas(Filters);
export type SavedViewInput = typeof SavedViewInput.Type;
export type SavedView = typeof SavedView.Type;
export type SavedViewsPage = typeof SavedViewsPage.Type;
