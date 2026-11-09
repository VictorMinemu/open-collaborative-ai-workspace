// CR-01 test fixture (07.15 review): a hostile PDF extractor process that answers with far more than any answer can
// be (a 64 MiB text, well-formed otherwise), so the parent must cut its answer channel instead of buffering it.
for await (const _ of process.stdin) {
  // drain the input
}
const answer = JSON.stringify({
  ok: true,
  totalPages: 1,
  pages: 1,
  text: "x".repeat(64 * 1024 * 1024),
  truncated: false,
  hasText: true,
});
process.stdout.write(answer, () => process.exit(0));
