// 07.15-05 test fixture (E12): a hostile PDF extractor process, chosen by the bytes the parent sends on stdin.
//   "malformed" → sends a message that is not an extractor answer, then stays alive until the parent kills it
//   anything else → never answers: spins synchronously, like a parser stuck in a loop, until the parent kills it
let mode = "";
for await (const chunk of process.stdin) mode += chunk;

if (mode === "malformed") {
  process.send({ ok: true, pages: "x" });
} else {
  for (;;) {
    // never yields: only the parent's SIGKILL ends this process
  }
}
