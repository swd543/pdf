import { Link } from '@solidjs/meta';
import { siteUrl } from '~/site/config';

/**
 * `<link rel="canonical">` for a route.
 *
 * Emits the custom-domain, trailing-slash form — the exact URL the static
 * server serves (a no-slash request 301s to it). This keeps the search index
 * pinned to one host + path even though the site is also reachable via the
 * GitHub Pages alias (`swd543.github.io/pdfboogie/…`, which 301s here).
 * `path` is the route path, e.g. `/pdf-merge` or `/`.
 */
export function Canonical(props: { path: string }) {
  const href = () => {
    const p = props.path === '/' ? '' : props.path;
    return p ? `${siteUrl}${p}/` : `${siteUrl}/`;
  };
  return <Link rel="canonical" href={href()} />;
}
