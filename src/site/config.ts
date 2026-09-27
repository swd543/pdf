/**
 * Central site configuration.
 *
 * Everything brand- or environment-related lives here so the rest of the
 * codebase stays free of magic strings. To rename the project, change
 * `name`/`tagline` below (and optionally the repo URL in .env).
 */

export interface Donation {
  id: string;
  label: string;
  address: string;
  /** URI scheme for a tap-to-pay link (e.g. `bitcoin:`); empty = plain text. */
  scheme: string;
  /** Optional payment memo / destination tag (XRP). */
  memo?: string;
}

export const site = {
  name: 'PDFBoogie',
  tagline: 'PDF tools that boogie, right in your browser.',
  description:
    'Free, secure and private PDF tools: compress, merge, combine pages, image to PDF, PDF to image, PDF to Word, and sign or fill PDF forms. ' +
    '100% client-side: your file is processed locally and never leaves your device.',
  /** Default origin used when VITE_SITE_URL is not set (dev). */
  fallbackUrl: 'http://localhost:3000',
  /** Contact shown on the privacy page (AdSense requires a contact path). */
  contactEmail: 'swd543@gmail.com',
  /** AdSense publisher id; empty string = ad-free build. */
  adsenseClient: (import.meta.env.VITE_ADSENSE_CLIENT as string | undefined) ?? '',
  /**
   * Direct donations (no third-party middleman). The site is free and the
   * processing happens in the visitor's browser, but hosting and
   * maintenance cost something — these are the only payment surfaces.
   */
  donation: [
    {
      id: 'btc',
      label: 'BTC',
      address: '1EEkZa2xwRDGfLSLBhLtU2MZKph2MYeHXb',
      scheme: 'bitcoin',
    },
    {
      id: 'eth',
      label: 'ETH',
      address: '0xb4ab64e921ad16de8aa703d824cb1f69c6d9cb8c',
      scheme: 'ethereum',
    },
    {
      id: 'xrp',
      label: 'XRP',
      address: 'r9nhTUa3gsa9LEd94adCzEjezWVxKCCRe4',
      /** XRP payments should include this destination tag/memo. */
      memo: '502538661',
      scheme: '',
    },
  ] as Donation[],
} as const;

export const siteUrl = (import.meta.env.VITE_SITE_URL as string | undefined) ?? site.fallbackUrl;

/** Tool registry — drives the home page, nav, footer and sitemap. */
export interface ToolDef {
  /** Route path, e.g. "/pdf-compress". */
  path: string;
  /** Short label for nav/footer. */
  label: string;
  /** One-line description shown on cards. */
  blurb: string;
  icon: 'image' | 'pdf' | 'compress' | 'sign' | 'merge' | 'grid' | 'doc';
}

export const tools: ToolDef[] = [
  {
    path: '/pdf-compress',
    label: 'Compress',
    blurb: 'Shrink PDF file size: lossless mode or strong re-encode.',
    icon: 'compress',
  },
  {
    path: '/pdf-merge',
    label: 'Merge PDF',
    blurb: 'Combine multiple PDFs (and JPGs) into one PDF, in the order you pick.',
    icon: 'merge',
  },
  {
    path: '/pdf-combine',
    label: 'Combine pages',
    blurb: 'Fit several pages onto one sheet: 2-up, 4-up, 9-up, 16-up.',
    icon: 'grid',
  },
  {
    path: '/image-to-pdf',
    label: 'Image → PDF',
    blurb: 'Turn JPG, PNG, WebP, GIF, BMP or AVIF images into one PDF.',
    icon: 'image',
  },
  {
    path: '/pdf-to-image',
    label: 'PDF → Image',
    blurb: 'Export PDF pages as PNG, JPEG or WebP: single file or ZIP.',
    icon: 'pdf',
  },
  {
    path: '/pdf-to-doc',
    label: 'PDF → Word',
    blurb: 'Turn a PDF into an editable .docx or .odt: text, headings and styles.',
    icon: 'doc',
  },
  {
    path: '/pdf-sign',
    label: 'Sign & Fill',
    blurb: 'Add your signature and fill PDF form fields, on any page.',
    icon: 'sign',
  },
];

/** Extra (non-tool) routes, in nav order. */
export const staticPages = [{ path: '/privacy', label: 'Privacy' }] as const;
