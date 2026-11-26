// Types of unzip.mjs (07.13 D-04, PD-02): safe zip extraction (zip-slip, symlink and duplicate refusals).

/**
 * Extracts `archive` into `dest`, stripping its single top-level directory. Rejects with an Error naming the entry and
 * the reason on an absolute path, a `..` segment, a non-regular entry (symlink), a duplicate name or a loose file.
 */
export function extractZip(archive: string, dest: string): Promise<{ files: number }>;
