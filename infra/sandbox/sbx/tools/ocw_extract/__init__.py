"""`ocw-extract`: bounded UTF-8 text from any supported file in a bot's sandbox (phase 07.17.1.1.1, D-04, D-11;
ADR-0043). Installed root-owned at /opt/ocw-tools/lib/ocw_extract and run only through the isolated launcher
/usr/local/bin/ocw-extract (`python3 -I`, fixed `sys.path`), so neither PYTHONPATH nor the working directory reaches
it (PD-06). Every child is an argv list in ocw-extract's process group (the one ocw-run kills), with a step timeout,
a process-tree kill and a fresh environment."""
