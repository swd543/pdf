/**
 * Catch-all route: friendly 404 for unknown paths (client-side navigation).
 * For unknown paths on a static host, GitHub Pages serves the generated
 * `404.html` fallback (see scripts/postbuild.mjs).
 */
import { Meta, Title } from '@solidjs/meta';
import { tools } from '~/site/config';

export default function NotFoundPage() {
  return (
    <>
      <Title>Page not found | PDFBoogie</Title>
      <Meta
        name="description"
        content="This page does not exist. Head back to the PDF tools home."
      />
      <div class="hero" style="text-align: center; margin-top: 3rem">
        <h1>404: that page skipped out</h1>
        <p class="lede" style="margin: 0.75rem auto 1.5rem; max-width: 30rem">
          The page you're looking for doesn't exist. The tools, however, are very much here.
        </p>
        <a href="/" class="btn btn-primary">
          Back to the tools
        </a>
      </div>
      <div class="tool-grid" style="margin-top: 3rem">
        {tools.map((t) => (
          <a class="tool-card" href={t.path}>
            <h3>{t.label}</h3>
            <p>{t.blurb}</p>
            <span class="tool-go">Open tool →</span>
          </a>
        ))}
      </div>
    </>
  );
}
