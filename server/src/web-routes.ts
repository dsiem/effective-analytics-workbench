import { pagePaths } from "@dsiem/analytics-shared/page-paths";
import { staticPages } from "@dsiem/analytics/static-pages";

export const WebRoutes = staticPages("client/dist", Object.values(pagePaths), [
  "theme-init.js",
]);
