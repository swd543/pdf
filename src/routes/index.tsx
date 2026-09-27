/**
 * Home page: hero, tool grid, how-it-works.
 */
import { Meta, Title } from '@solidjs/meta';
import { AdSlot } from '~/components/AdSlot';
import { Canonical } from '~/components/Canonical';
import {
  CompressIcon,
  DocumentIcon,
  GridIcon,
  ImageIcon,
  MergeIcon,
  PdfIcon,
  SignIcon,
} from '~/components/Icons';
import { siteUrl, tools } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

const iconFor = {
  compress: CompressIcon,
  image: ImageIcon,
  pdf: PdfIcon,
  sign: SignIcon,
  merge: MergeIcon,
  grid: GridIcon,
  doc: DocumentIcon,
} as const;

export default function HomePage() {
  const meta = routeMeta['/']!;
  return (
    <>
      <Title>{meta.title}</Title>
      <Canonical path="/" />
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/`} />
      {meta.image && <Meta property="og:image" content={meta.image} />}
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/'))} />

      <div class="hero">
        <h1>Free, secure, private PDF tools that never touch a server.</h1>
        <p class="lede">
          Compress, convert and sign PDFs. Everything runs right here in your browser: your file is
          processed securely and never leaves your device. No uploads, no accounts, no watermarks —
          you can verify it in the network tab.
        </p>
        <div class="badge-row">
          <span class="badge">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
            </svg>
            100% client-side
          </span>
          <span class="badge">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
            </svg>
            Free &amp; open source
          </span>
          <span class="badge">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 9h10M7 13h6" />
            </svg>
            Works on any device
          </span>
        </div>
      </div>

      <div class="tool-grid">
        {tools.map((t) => {
          const Ico = iconFor[t.icon];
          return (
            <a class="tool-card" href={t.path}>
              <div class="tool-icon">
                <Ico />
              </div>
              <h3>{t.label}</h3>
              <p>{t.blurb}</p>
              <span class="tool-go">Open tool →</span>
            </a>
          );
        })}
      </div>

      <AdSlot slot="home-bottom" className="home-ad" />

      <section class="panel how" aria-labelledby="how-title">
        <div class="panel-body">
          <h2 id="how-title">How it works</h2>
          <ol class="how-steps">
            <li>
              <strong>Pick a tool and drop your file.</strong> Nothing is uploaded — the file is
              read straight from disk by your browser.
            </li>
            <li>
              <strong>It processes on your device.</strong> PDF rendering runs on PDF.js, structural
              optimization on a small Rust/WASM core, and image codecs are your browser's native
              (SIMD-accelerated) ones.
            </li>
            <li>
              <strong>Download the result.</strong> When you close the tab, no trace of your
              document remains anywhere — not on this site, not on a server, because there is no
              server.
            </li>
          </ol>
          <p>
            <a href="/privacy">Read the privacy page →</a>
          </p>
        </div>
      </section>
    </>
  );
}
