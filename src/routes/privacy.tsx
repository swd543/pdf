/**
 * Privacy page — also the "how it works" trust page and the contact
 * surface (AdSense applications require a reachable contact point).
 */
import { Meta, Title } from '@solidjs/meta';
import { Canonical } from '~/components/Canonical';
import { site, siteUrl } from '~/site/config';
import { jsonLdFor, routeMeta } from '~/site/seo';

export default function PrivacyPage() {
  const meta = routeMeta['/privacy']!;
  return (
    <>
      <Title>{meta.title}</Title>
      <Canonical path="/privacy" />
      <Meta name="description" content={meta.description} />
      <Meta property="og:title" content={meta.title} />
      <Meta property="og:description" content={meta.description} />
      <Meta property="og:url" content={`${siteUrl}/privacy/`} />
      <script type="application/ld+json" innerHTML={JSON.stringify(jsonLdFor('/privacy'))} />

      <div class="prose">
        <h1>Privacy: your files stay yours</h1>
        <p>
          {site.name} is a static website with no backend. Every operation (compressing, converting,
          signing and filling) runs in your browser, on your device. This is a design constraint,
          not a policy promise:{' '}
          <strong>
            there is no server that could receive your documents, because there is no server.
          </strong>
        </p>

        <h2>What happens to your files</h2>
        <ul>
          <li>
            <strong>They are read locally.</strong> Your browser reads the file from disk via the
            File API, the same way it would for any local file picker.
          </li>
          <li>
            <strong>They are processed locally.</strong> PDF rendering (Mozilla PDF.js), structural
            optimization (a small Rust/WASM core), form filling and PDF creation (pdf-lib) all run
            in-process or in a same-origin web worker.
          </li>
          <li>
            <strong>They leave only as your download.</strong> The result is written to your
            downloads folder by the browser. Closing the tab frees the memory; nothing is stored,
            cached or indexed.
          </li>
        </ul>

        <h2>What we do NOT do</h2>
        <ul>
          <li>Upload, store or log your documents. We physically cannot.</li>
          <li>
            Collect analytics on you. There are no trackers, no cookies and no fingerprinting.
          </li>
          <li>Require an account, email address or payment to use any tool.</li>
        </ul>

        <h2>Donations</h2>
        <p>
          Every tool is free and unlimited. The processing happens on your device, but the site
          still needs hosting and maintenance. If you use {site.name} a lot, you can send a
          voluntary donation directly to one of these wallets, straight from you to the maintainer,
          with no middleman, no tracking and no impact on the tools. It is entirely optional.
        </p>
        <ul>
          {site.donation.map((d) => (
            <li>
              <strong>{d.label}</strong>: <code>{d.address}</code>
              {d.memo ? (
                <span>
                  {' '}
                  (include memo/destination tag <code>{d.memo}</code>)
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        <h2>Third-party scripts</h2>
        <p>
          By default this site loads <strong>zero external scripts</strong>: the HTML, CSS and
          JavaScript are all served from this origin under a strict Content-Security-Policy. If the
          site is later monetized with Google AdSense, ad scripts are loaded only when a publisher
          key is configured, and they never receive your documents.
        </p>

        <h2>Contact</h2>
        <p>
          Questions, bug reports or feature ideas:{' '}
          <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>. We aim to reply within a
          few days.
        </p>
      </div>
    </>
  );
}
