/** Define the navigable features once for deep links, server routes and client entry points. */
export function defineWorkspace<
  const Pages extends Record<string, { path: `/${string}`; label: string }>,
>(pages: Pages) {
  type Page = keyof Pages & string;
  const ids = Object.keys(pages) as Page[];
  const byPath = new Map<string, Page>(ids.map((id) => [pages[id]!.path, id]));
  if (byPath.size !== ids.length)
    throw new Error("Each workspace page needs a distinct path.");
  return {
    pages,
    ids,
    paths: ids.map((id) => pages[id]!.path),
    resolve: (path: string) => byPath.get(path),
    href: (id: Page, query = new URLSearchParams()) =>
      pages[id]!.path + (query.size ? `?${query}` : ""),
    links(current: Page, href: (page: Page) => string) {
      return ids.map((id) => ({
        ...pages[id]!,
        id,
        href: href(id),
        current: id === current,
      }));
    },
    mount<Container>(
      path: string,
      container: Container,
      mounts: Record<Page, (container: Container) => void>,
    ) {
      const id = byPath.get(path);
      if (id === undefined) throw new Error("Unknown workspace page.");
      mounts[id](container);
    },
  };
}
