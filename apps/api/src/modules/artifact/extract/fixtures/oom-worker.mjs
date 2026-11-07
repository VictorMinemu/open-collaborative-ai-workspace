// 07.15-05 test fixture (E12): a hostile PDF worker that allocates until its heap limit (the parent's
// resourceLimits) kills it with ERR_WORKER_OUT_OF_MEMORY. It never answers.
const kept = [];
for (;;) {
  kept.push(Array.from({ length: 10_000 }, (_, i) => ({ i, s: `chunk-${kept.length}-${i}` })));
}
