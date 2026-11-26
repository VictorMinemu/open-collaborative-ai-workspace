---
quick_id: 261126-f6s
status: complete
---

# Summary

- `WorkLivePanel` keeps a `large` state: the Expand button (`work-live-expand`) toggles it; entering control on a
  non-touch screen opens it and handing back closes it when it opened by itself.
- The large view is a `Dialog` (`work-live-large`, no outside dismissal, Escape ignored while in control) holding the
  same `WorkLiveBody`; only one body is mounted at a time, so frames and input reach one frame element.
- The frame fits `min(dialog width, (100dvh − 18rem) × 1.6)`; the placeholder uses its large size.
- Tests: 3 new unit tests (31 pass); e2e `work-zone-browser.spec.ts` asserts the large view in control on desktop and
  its close after "Done, save my sign-in". Typecheck and Biome clean.
