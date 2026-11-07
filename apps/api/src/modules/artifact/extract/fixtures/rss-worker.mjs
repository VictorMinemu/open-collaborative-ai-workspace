// CR-01 test fixture (07.15 review): a hostile PDF extractor process that allocates ArrayBuffer memory outside the
// JavaScript heap (what PDF.js does when it inflates a stream), in a synchronous loop that never yields. The heap
// limit cannot stop it; only the parent's resident-memory watchdog (or the kernel's address-space limit) can.
const kept = [];
for (;;) {
  kept.push(new Uint8Array(16 * 1024 * 1024).fill(1));
}
