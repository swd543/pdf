# Architecture and Performance Refactor Handoff

Baseline reviewed: commit `3bcac8b` on `main`.

> **Status: implemented.** All P0/P1 findings and the P2 decomposition
> (shared `SinglePdfInput`, pure `sequence.ts` transforms, Sign/Combine/Merge
> component extraction) are in `main`. Rollout steps 1–9 of §8 are done;
> live-check step 10 passes 14/14 against the previous production build and
> the local gates are green (91 unit, 72 Playwright). See the
> “Performance & resource-safety layer” section of `ARCHITECTURE.md` for the
> resulting architecture. Step 11 (profile before virtualization/worker)
> remains a future decision, not a requirement.

This document is a specification only. It intentionally does not prescribe a wholesale rewrite. Preserve current behavior, privacy guarantees, output fidelity, explicit-download flows, tool chaining, SEO, and the passing test suite.

## 1. Current strengths to preserve

- Route-level code splitting already works. Emitted route chunks are small (roughly 8–22 KB raw in the reviewed build).
- `pdf-lib`, PDF.js, its worker, and the Rust/WASM core are loaded lazily.
- Expensive page loops are generally sequential and call `yieldToBrowser()` rather than running concurrently.
- PDF.js documents are normally destroyed through `disposePdf()`.
- Most temporary page canvases are explicitly reset to `0 × 0` after use.
- Image conversion already caps re-encoded image sides at 4096 px.
- Combine caps final sheet width and uses low-resolution live previews.
- Existing dependencies are focused and appropriate. Do not add a broad state-management, drag-and-drop, or utility framework.
- Current local baseline is green: 56 unit tests and 72 Playwright tests were reported passing before this audit.

## 2. Priority findings

### P0 — prevent freezes, runaway memory, and leaked browser resources

#### P0.1 Sign & Fill eagerly renders and retains every page canvas

Observed in:

- `src/routes/pdf-sign.tsx::openDocument()`
- `src/routes/pdf-sign.tsx::renderAllPages()`
- the `<For>` page-stage block in `pdf-sign.tsx`

Current behavior:

- Every PDF page creates a DOM stage and a canvas.
- Every canvas is rendered immediately and retains its backing store.
- A 100–500 page PDF can allocate hundreds of MB and make mobile browsers unresponsive.
- Page proxies are not explicitly cleaned after rendering.
- A route unmount does not explicitly dispose the current PDF document or reset canvases.

Required change:

1. Introduce a Sign page-rendering session that owns:
   - the `PDFDocumentProxy`;
   - an `IntersectionObserver`;
   - active `RenderTask`s;
   - rendered-page state;
   - canvas registration and disposal.
2. Render only pages within a bounded viewport window (`rootMargin` is acceptable).
3. Give off-screen pages an aspect-ratio placeholder from page metadata.
4. Keep non-visible canvas backing stores at `0 × 0` or release them after a bounded cache (recommended: current page ±2 pages).
5. Cancel active render tasks and dispose the PDF on file replacement, Clear, and route unmount.
6. After form-fill changes, invalidate all page render versions but immediately repaint only the visible window.
7. Call `PDFPageProxy.cleanup()` after completed/cancelled renders.

Acceptance criteria:

- Opening a 200-page fixture creates at most five non-zero canvas backing stores before scrolling.
- Scrolling causes the next page to render without a blank interaction surface.
- Changing/clearing the file leaves no active render task or PDF.js document.
- Existing signature placement coordinates remain correct at every rendered scale.

#### P0.2 Interactive page lists are unbounded

Observed in:

- `src/routes/pdf-merge.tsx`: one sequence tile per true PDF page
- `src/routes/pdf-combine.tsx`: `Array.from({ length: pageCount() })`
- `src/routes/pdf-sign.tsx`: one stage per page
- `src/lib/thumbs.ts`: cap is per call/per file, not global

Current behavior:

- Merge allows 30 files; each can contribute an arbitrary page count.
- A 10,000-page input creates 10,000 sequence records and DOM tiles even though thumbnails are capped.
- Combine creates one selectable DOM node per page without a document-page limit.
- Merge can render up to 200 thumbnails for each of 30 files (6,000 base64 data URLs).

Required change:

1. Add centralized browser-safety constants in `src/lib/limits.ts`:
   - initial interactive-page ceiling: 500 pages;
   - global thumbnail ceiling per tool session: 200;
   - maximum canvas pixels: 12,000,000;
   - maximum canvas side: 8,192 px.
2. Reject an input before rendering thumbnails if adding it would exceed the interactive page ceiling. Show the real page count and limit in the error.
3. Count the Merge thumbnail budget globally, not per PDF.
4. Do not silently truncate output pages. Either accept the entire file or reject it.
5. Keep page limits configurable and documented so benchmarks can justify later changes.
6. Longer-term, page grids may be windowed, but do not combine virtualization and drag-reorder changes in the same first patch.

Acceptance criteria:

- A synthetic 501-page PDF is rejected by Merge/Combine before thumbnail work starts.
- No accepted operation silently omits a page.
- The UI remains responsive while the limit error is produced.
- A Merge session never stores more than 200 rendered thumbnails.

#### P0.3 PDF-to-image and thumbnail canvases have no pathological-page pixel guard

Observed in:

- `src/features/pdf-to-image/logic.ts::renderOnePage()`
- `src/lib/thumbs.ts::renderPageThumbs()`
- Sign page canvas sizing

Current behavior:

- Requested DPI/target width is applied without checking total pixel count or the other dimension.
- An extremely tall, wide, or malformed PDF page can request a canvas beyond browser/GPU limits.
- Strong compression inherits the same risk because it calls PDF-to-image rendering.

Required change:

1. Add a shared `boundedCanvasScale()` helper.
2. Bound both maximum side and total pixels while preserving aspect ratio.
3. Apply it to PDF-to-image, strong compression, thumbnails, Sign, and any future page renderer.
4. Surface the effective DPI when it is reduced; do not claim the requested DPI was used.

Acceptance criteria:

- No page canvas exceeds 12 MP or 8,192 px on either side.
- Normal A4/Letter pages at advertised 300 DPI remain unchanged.
- Unit tests cover very tall, very wide, zero/invalid, and normal pages.

#### P0.4 Object URL and ImageBitmap lifecycle leaks

Observed in:

- `src/routes/image-to-pdf.tsx`
- `src/routes/pdf-sign.tsx::adoptSignature()`
- `src/routes/pdf-sign.tsx::useUploadedSignature()`
- `src/features/image-to-pdf/logic.ts::prepareImage()`

Current behavior:

- Image-to-PDF revokes URLs when an item is individually removed, but not on route unmount.
- Image-to-PDF `startOver()` does not clear items or revoke their object URLs.
- Replacing/clearing a Sign signature does not revoke the previous `dataUrl` object URL.
- Uploaded signature `ImageBitmap`s are not closed.
- `prepareImage()` does not close the original or downscaled bitmap after generic decode/re-encode.

Required change:

1. Add a small owned-object-URL registry (`create`, `revoke`, `clear`) with `onCleanup(clear)`.
2. Use it in Image-to-PDF and Sign.
3. Make Start over genuinely clear Image-to-PDF items and URLs.
4. Close all caller-owned `ImageBitmap`s in `finally` blocks.
5. Reset temporary canvas backing stores after export.

Acceptance criteria:

- Instrumented E2E verifies every created object URL is revoked after item removal, Start over, Clear, and route navigation.
- Instrumented tests verify `ImageBitmap.close()` executes on success and failure paths.
- Start over shows a genuinely empty Image-to-PDF state.

#### P0.5 PDF-to-image builds all page images, then synchronously zips them

Observed in:

- `src/features/pdf-to-image/logic.ts::pdfToImages()`
- `src/routes/pdf-to-image.tsx::process()`
- `src/lib/zip.ts::makeZip()` (`zipSync`)

Current behavior:

- Every encoded page is retained in `ExportedImage[]`.
- `makeZip()` builds a second files record and performs synchronous compression.
- Large PNG ranges can hold the source PDF, all images, ZIP output, and intermediate allocations simultaneously.
- `zipSync` can block the main thread.

Required change:

1. Expose a per-page image consumer/async iterator from PDF-to-image logic.
2. For multi-page exports, feed pages directly to fflate's streaming ZIP API.
3. Use pass-through/store mode for JPEG/PNG/WebP, which are already compressed.
4. Retain only current page bytes plus accumulated ZIP chunks/output.
5. Keep the existing one-page direct-download path.
6. Add cancellation checkpoints between pages.

Acceptance criteria:

- Multi-page conversion no longer creates an array containing every exported page.
- No synchronous ZIP call is used for generated images.
- ZIP entry names/order match current behavior.
- A 100-page fixture permits a recurring 100 ms UI heartbeat throughout conversion.

### P1 — eliminate repeated work and race-prone async flows

#### P1.1 Combine preview repeatedly reads and reparses the PDF

Observed in:

- `src/routes/pdf-combine.tsx::refreshPreview()`
- the Combine `createEffect()`
- `src/features/pdf-combine/logic.ts::previewSheets()`

Current behavior:

- Every selection, grid, size, or orientation change rereads the entire `File`.
- Every change opens and destroys a PDF.js document.
- Rapid changes start overlapping work; a generation number prevents stale display but does not cancel CPU work.
- `drawSheet()` does not clean page proxies after each tile.

Required change:

1. Open one reusable PDF preview session when the file is selected.
2. Use that same PDF document for initial thumbnails and live sheet previews.
3. Debounce reactive preview requests by approximately 150 ms.
4. Abort/cancel the prior preview's active PDF.js render task on a newer request.
5. Clean page proxies after each rendered tile.
6. Dispose the session on Clear/file replacement/unmount.
7. Read the original `File` once for the final Combine operation; do not retain an extra full raw byte copy merely to avoid file reads.

Acceptance criteria:

- Rapidly toggling 20 page/options changes produces at most two completed preview generations.
- The file is not reread for each preview.
- Only one PDF.js preview document is opened per selected file.
- Stale preview work is cancelled, not merely ignored at completion.

#### P1.2 Merge image previews re-decode every image after each layout change

Observed in:

- `src/routes/pdf-merge.tsx` image-preview `createEffect()`
- `src/lib/thumbs.ts::renderImagePagePreview()`

Current behavior:

- Every page-size or margin change calls `createImageBitmap()` for every image.
- New base64 JPEG data URLs are generated repeatedly.
- A generation guard ignores stale results but does not stop ongoing decodes/renders.

Required change:

1. Decode image dimensions once when an image is added.
2. Keep one route-owned object URL for the source preview.
3. Export the real output geometry helper from Image-to-PDF logic and use it for both PDF writing and preview layout.
4. Render the preview as a CSS page frame (`aspect-ratio`, scaled padding, contained image), not a new canvas.
5. Revoke source URLs on remove/reset/unmount.
6. Apply EXIF orientation consistently.

Acceptance criteria:

- Changing Fit/A4/Letter/Legal or margin performs no new image decode.
- Preview page ratio and margin match output geometry tests.
- Existing visual E2E coverage is updated to assert frame geometry rather than a changing data URL.

#### P1.3 Merge source-document cache does not match its contract

Observed in `src/features/pdf-merge/logic.ts::mergePages()`.

Current behavior:

- The comment promises documents are loaded once per distinct buffer.
- Implementation caches only the immediately previous `curBytes`/`curSrc`.
- Interleaving A1, B1, A2, B2 reparses A and B repeatedly.

Required change:

1. Replace the single current-source cache with a `Map<Uint8Array, PDFDocument>` keyed by the stable byte-array identity supplied by the route.
2. Validate page numbers after retrieving the cached document.
3. Keep parsing errors friendly and file-specific.

Acceptance criteria:

- Unit test A1, B1, A2, B2 loads exactly two source documents.
- Output order remains exact.

#### P1.4 Merge retains eager byte copies for every PDF while idle

Observed in `src/routes/pdf-merge.tsx::Item.pdfBytes` and `addFiles()`.

Current behavior:

- The browser already owns each `File`; Merge additionally retains a full `Uint8Array` for every accepted PDF.
- The extra bytes stay alive while the user reorders pages.

Required change:

- Separate preview metadata from operation inputs.
- Prefer retaining `File` plus page metadata while idle, then read each distinct PDF once when processing starts.
- If keeping bytes is measurably faster and chosen intentionally, enforce total-input-byte limits and document the memory tradeoff.
- Do not regress the "load each distinct PDF once" requirement during final merge.

Acceptance criteria:

- The chosen policy is covered by a memory benchmark and documented.
- No unreadable/rejected PDF retains an eager byte copy.

#### P1.5 Strong compression buffers all full-page JPEGs before assembly

Observed in `src/features/pdf-compress/logic.ts::strong()`.

Current behavior:

- `pdfToImages()` returns every page image before PDF assembly begins.
- Strong compression then embeds those bytes into a second PDF representation.

Required change:

1. Reuse the per-page image consumer introduced for P0.5.
2. Render and embed one page at a time.
3. Materialize/embed the image before releasing the page byte reference.
4. Preserve original page point dimensions and progress semantics.

Acceptance criteria:

- No `ExportedImage[]` exists in the strong-compression path.
- Exact page count and sizes remain covered by integration tests.

#### P1.6 Long-running operations lack a shared cancellation contract

Observed across all feature functions and routes.

Current behavior:

- Navigating away or replacing input does not consistently stop ongoing work.
- Generation counters prevent stale UI in a few previews but still waste CPU.
- PDF.js render tasks are not generally cancelled.
- WASM/pdf-lib final serialization is not cancellable, but page loops are.

Required change:

1. Define a lightweight `OperationContext` with `signal`, `progress`, and an async `checkpoint()`.
2. Pass it through page/image loops.
3. Abort on Clear, file replacement, Start over, and route unmount.
4. Attach the signal to PDF.js render tasks and call `RenderTask.cancel()`.
5. Treat `AbortError`/PDF.js cancellation as silent cancellation, not a user-facing failure.
6. Do not introduce a state-management library for this.

Acceptance criteria:

- Navigation during a 100-page operation stops progress and render work promptly.
- A cancelled old input cannot overwrite state for a newer input.

#### P1.7 Merge drag listeners need unmount cleanup

Observed in `src/routes/pdf-merge.tsx::startGripDrag()`.

Current behavior:

- Window pointer listeners are removed on normal pointer end/cancel.
- Route unmount during an active drag has no explicit cleanup path.

Required change:

- Keep one active-drag cleanup function and invoke it from `onCleanup()`.
- Remove pointer listeners, body classes, pointer capture state, and pending animation-frame work.

Acceptance criteria:

- Navigating away mid-drag leaves no `body.seq-dragging` class and no active handlers.

### P2 — maintainability and reusable architecture

#### P2.1 Extract the repeated single-PDF input presentation

Repeated in Compress, Combine, PDF-to-image, and Sign:

- `ChainNote`
- PDF `DropZone`
- file name/size/page count row
- remove button and busy state

Required component:

`src/components/SinglePdfInput.tsx`

It should be a dumb presentational component receiving:

- `file`
- optional `pageCount`
- `showDrop`, `busy`, and `disableRemove`
- drop title/subtitle
- chain note accessor/dismiss callback
- `onFiles` and `onClear`

Do not move tool-specific file validation, PDF opening, phases, or processing into this component.

#### P2.2 Do not create a universal tool-state hook

The repeated `file`, `phase`, `progress`, `result`, `clear`, and `download` names are visually similar but behavior differs materially across tools.

Allowed common code:

- `ToolPhase` and `ProgressState` types
- `ResultFile` type
- owned-resource helpers
- operation cancellation helper
- presentational input/result controls

Avoid a large `usePdfTool()` hook with callbacks for every route; it would hide lifecycle differences and increase coupling.

#### P2.3 Split oversized routes along behavior boundaries

Current sizes:

- `pdf-merge.tsx`: 832 lines
- `pdf-sign.tsx`: 773 lines
- `pdf-combine.tsx`: 490 lines
- global `components.css`: 1,656 lines

Target decomposition:

**Merge**

- `features/pdf-merge/sequence.ts`: pure selection/range/block-move transforms, unit tested
- `features/pdf-merge/MergePageStrip.tsx`: grip dragging, tile refs, pointer lifecycle, accessibility
- `features/pdf-merge/MergeFileList.tsx`: file rows and file-level movement
- route: validation, process orchestration, options, result UI

**Sign**

- `features/pdf-sign/page-renderer.ts`: PDF session, lazy canvas rendering, cancellation/disposal
- `features/pdf-sign/SignatureChooser.tsx`
- `features/pdf-sign/FormPanel.tsx`
- `features/pdf-sign/PdfStage.tsx`
- route: working PDF bytes, form/sign operation orchestration, result UI

**Combine**

- `features/pdf-combine/PagePicker.tsx`
- `features/pdf-combine/SheetPreview.tsx`
- reusable preview-session logic

Keep one writer/owner for each PDF.js document and each object-URL registry.

#### P2.4 Split route-specific CSS

- Keep tokens and shared components global.
- Move Merge sequence/drag styles and Sign stage/signature styles into feature CSS imported by those routes/components.
- Confirm Vite emits route CSS lazily; if it merges everything anyway, treat this as maintainability-only and do not force additional tooling.

#### P2.5 Standardize PDF.js cleanup

- Every PDF open must have one clear owner.
- Use `try/finally` and `await disposePdf(pdf)` in async feature functions.
- Clean page proxies after rendering.
- Reset temporary canvases after encoding.
- Do not destroy a reusable preview document after every reactive update.

## 3. Recommended target layering

```text
routes/
  orchestration, route metadata, tool options, result/download state

features/<tool>/
  logic.ts                 browser-independent or task-oriented logic
  components/*.tsx         feature-specific UI
  sequence/page-renderer   focused stateful controllers with explicit cleanup

components/
  shared presentational UI only

lib/browser/
  operation.ts             AbortSignal/checkpoint/progress contract
  object-urls.ts           owned URL lifecycle
  canvas.ts                pixel/side bounds and canvas release helpers
  pdf-preview.ts           explicit PDF preview-session ownership
  limits.ts                documented browser-safety limits

lib/
  pdfjs.ts, pdflib.ts, wasm.ts, files.ts, zip.ts
```

Dependency direction must remain `routes -> features/components -> lib`; feature logic must not import route components.

## 4. External-library decision

Do not add a dependency in the first refactor pass.

Use existing/platform capabilities:

- `IntersectionObserver` for lazy page rendering
- `AbortController` for cancellation
- PDF.js `RenderTask.cancel()`
- fflate's streaming ZIP API
- Solid's existing signals/effects/cleanup
- CSS layout for image-page previews

Libraries considered but not recommended initially:

- Sortable/drag libraries: current grip-specific mouse/touch behavior is specialized and already tested.
- General state stores: route state is local and does not need global synchronization.
- Debounce/p-limit packages: the required behavior is small and intentionally sequential.
- Comlink: only consider if a later dedicated processing-worker project is approved.
- Virtualization libraries: consider `@tanstack/solid-virtual` only after the initial hard bounds/lazy rendering, and benchmark interaction with horizontal drag reorder first.

## 5. Optional Phase 3: dedicated processing worker

After P0/P1 work is stable, profile remaining long main-thread tasks:

- `pdf-lib` page copying and `save()`
- Rust/WASM lossless compression

If these still cause multi-second input stalls, introduce one typed same-origin Web Worker for processing tasks. The current CSP already permits same-origin workers. Do not workerize before lifecycle, bounds, and streaming are fixed; otherwise the same excessive work merely moves threads.

Worker requirements:

- transferable `ArrayBuffer`s where ownership can be surrendered;
- progress and cancellation messages;
- no document data persistence/network access;
- capability fallback for unsupported tasks;
- route chunks remain lazy.

## 6. Performance and bundle budgets

Add a build-time asset-budget script rather than a new plugin.

Initial budgets (raw emitted size; adjust only with a documented reason):

- initial client JS excluding lazy tool/PDF chunks: no regression over current build by >10%;
- individual route chunk: <30 KB;
- shared global CSS: reduce or remain <= current ~43 KB;
- PDF.js/PDF worker remain lazy and must not be fetched on the home page;
- AdSense remains unloaded and layout-collapsed until first operation.

Runtime budgets for benchmark fixtures:

- no individual JavaScript task >100 ms during page-by-page work, excluding unavoidable final serializer calls;
- at most five non-zero Sign canvases before scrolling;
- at most 200 live rendered thumbnail assets per tool session;
- no canvas over 12 MP or 8,192 px per side;
- rapid option changes do not create an unbounded work queue.

Do not add production analytics to measure these budgets. Use Playwright/CDP and development-only marks.

## 7. Test additions

### Unit tests

- bounded canvas scale math
- Merge global page/thumbnail limits
- Merge interleaved source cache loads each source once
- pure Merge selection/range/block-move transforms after extraction
- image-page geometry shared by preview and writer
- cancellation checkpoint behavior
- resource registry idempotent cleanup

### Browser/E2E tests

- 501-page Merge/Combine rejection occurs before thumbnails
- 200-page Sign retains <=5 non-zero canvases and renders after scrolling
- rapid Combine changes cancel/debounce stale previews
- Clear/navigation revokes object URLs and closes/disposes resources
- route navigation during an operation prevents stale state updates
- pathological page dimensions stay under canvas limits
- streaming multi-page ZIP contains exact names/order/content
- existing Android grip drag and Ctrl/Shift selection regressions remain green

### Responsiveness test pattern

During heavy fixtures, run a 100 ms browser heartbeat (`setInterval`) and assert it continues advancing. Avoid strict wall-clock assertions in CI; assert bounded task behavior, render counts, and resource counts instead.

## 8. Rollout order

1. Add safety limits/canvas bounds and tests.
2. Fix object URL, bitmap, PDF document, page proxy, listener, and canvas cleanup.
3. Make Sign rendering lazy and bounded.
4. Stream PDF-to-image ZIP output and strong compression page consumption.
5. Reuse/debounce/cancel Combine preview sessions.
6. Replace Merge image canvas previews with shared geometry + CSS.
7. Fix Merge source cache and decide/document idle-byte retention policy.
8. Extract shared presentational input UI.
9. Split Merge/Sign/Combine route components without behavior changes.
10. Rebuild, run all gates, and perform production smoke tests.
11. Profile again before deciding on virtualization or a processing worker.

Each rollout step should be independently reviewable and keep all existing tests passing. Do not combine drag behavior rewrites, virtualization, and resource-lifecycle changes in one patch.

## 9. Required validation gates

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build && node scripts/postbuild.mjs
pnpm exec playwright test --config e2e/playwright.config.ts
node scripts/live-check.mjs
```

Before production deployment, repeat the Merge visual checks for output-aware image previews, Android touch drag, and Ctrl/Cmd/Shift selection.
