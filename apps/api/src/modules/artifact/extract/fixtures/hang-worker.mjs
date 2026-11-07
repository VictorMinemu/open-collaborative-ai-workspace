// 07.15-05 test fixture (E12): a hostile PDF worker, chosen by the bytes the parent sends.
//   "malformed" → posts a message that is not a worker answer, then exits
//   anything else → never answers: spins synchronously, like a parser stuck in a loop, until the parent terminates it
import { parentPort, workerData } from "node:worker_threads";

const mode = new TextDecoder().decode(workerData.data);

if (mode === "malformed") {
  parentPort.postMessage({ ok: true, pages: "x" });
} else {
  for (;;) {
    // never yields: only terminate() ends this thread
  }
}
