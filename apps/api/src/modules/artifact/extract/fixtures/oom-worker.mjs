// 07.15-05 test fixture (E12): a hostile PDF extractor process that allocates JavaScript objects until its heap limit
// (the parent's --max-old-space-size) makes V8 abort the process. It never answers.
const kept = [];
for (;;) {
  kept.push(Array.from({ length: 10_000 }, (_, i) => ({ i, s: `chunk-${kept.length}-${i}` })));
}
