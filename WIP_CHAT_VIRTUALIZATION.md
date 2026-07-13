# Chat Virtualization WIP

Branch: `wip/chat-virtualization-window`

## Goal

- Keep process-collapse turns atomic during pagination.
- Reduce page size from 20/25 items to 10 render units.
- Keep streaming growth from moving the viewport after the user scrolls up.
- Load older history before the user reaches the top without scroll jumps.
- Bound mounted message DOM with a reliable sliding window.

## Included commits

This branch contains all local commits that were ahead of `origin/dev`:

- `ad42dcc` rebuild process collapse from page rows
- `4b7966a` keep same-turn rows together
- `73b30fb` page process collapse by row count
- `40511ee` initial prefetch/premeasure sliding window
- `e520060` restore native scroll anchoring during streaming growth

The latest WIP commit also contains the subsequent review fixes and unfinished window rewrite.

## Current state

- Pagination and session-loading model changes were implemented and tested before the final rewrite.
- Related tests reached 63 passing; production build passed.
- Full suite reached 485 passing and 2 pre-existing `ToolPartView` duration failures.
- The current final edit is intentionally incomplete and must be type-checked before merging.

## Confirmed problems

1. The fixed page-count window caused height feedback: expanding a page updated measured offsets, which then changed the selected window again.
2. Synchronous scroll-position state updates caused ChatArea React renders during scrolling.
3. The long-lived load-more anchor repeatedly applied `scrollTop += delta` while pages mounted and while the user kept scrolling.
4. Directly expanding unmeasured pages changes a slot from estimated to real height and can turn a small wheel event into a large visual jump.

## Rewrite in progress

- Every page now keeps a stable lightweight DOM slot.
- `IntersectionObserver` identifies pages near the viewport by pixel distance.
- Aggregate collapsed segments and the long-lived manual load-more anchor were removed.
- Native browser scroll anchoring remains enabled on the root; loading/sentinel elements are excluded as anchors.
- Per-scroll React position state was removed.
- A nearest-page premeasurement queue has been started, but the hidden single-page measurement probe is not wired into the render tree yet.

## Next steps

1. Render `premeasurePage` in an invisible, out-of-flow probe with the same content width.
2. Commit one measured page per animation frame via `pendingPremeasureRef`/`premeasureCommitRafRef`.
3. Only add observed pages to `expandedPageKeys` after a real measured height exists.
4. Confirm the stable visible slot keeps exactly the measured height when its content mounts.
5. Remove now-unused range/segment helpers and their obsolete tests from `chatPageModel.ts`.
6. Run typecheck, focused tests, full tests, lint, and build.
7. Browser-test fast wheel scrolling, load-more while moving, process collapse on/off, and streaming while scrolled up.
