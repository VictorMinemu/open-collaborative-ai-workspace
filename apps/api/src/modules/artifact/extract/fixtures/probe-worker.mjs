// CR-01, WR-07 test fixture (07.15 review): reports what a PDF extractor process could reach, as the text of a
// well-formed answer, so the test can check the isolation the parent sets up.
let input = 0;
for await (const chunk of process.stdin) input += chunk.length;

const allowed = (scope, reference) => {
  try {
    return process.permission ? process.permission.has(scope, reference) : true;
  } catch {
    return true;
  }
};
let codeGeneration = false;
try {
  codeGeneration = new Function("return true")();
} catch {
  codeGeneration = false;
}

const facts = {
  input,
  argv: process.argv.slice(2),
  env: Object.keys(process.env),
  execArgv: process.execArgv,
  cwd: process.cwd(),
  permission: process.permission !== undefined,
  readEtc: allowed("fs.read", "/etc/hosts"),
  readCwd: allowed("fs.read", process.cwd()),
  write: allowed("fs.write"),
  child: allowed("child"),
  worker: allowed("worker"),
  addon: allowed("addon"),
  codeGeneration,
};
process.send({ ok: true, totalPages: 1, pages: 1, text: JSON.stringify(facts), truncated: false });
