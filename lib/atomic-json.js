import fs from 'node:fs';
import path from 'node:path';

// This extension's OWN crash-safe JSON persistence, mirroring the wrangler's
// server/atomic-json.js for the same reason lib/data-dir.js mirrors its data
// dir: nothing here may import from the server tree (see lib/data-dir.js).
//
// Temp file in the SAME directory then renameSync, because a rename is atomic
// only within one filesystem — a reader, or the next boot, sees either the old
// file whole or the new file whole and never a torn one. A bare
// truncate-in-place write that dies half way would lose every approval a human
// has granted and every message still waiting for one.
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Read + parse, distinguishing "first run" from "corruption" — the same
// three-way answer readJsonOrLoud gives, and for the same reason: silently
// discarding a file that failed to parse would throw away human approvals and
// unapproved message bodies with no trace that anything was there.
//
// A missing or empty file is a legitimate first run and returns null quietly. A
// non-empty file that will not parse is MOVED ASIDE to a `.corrupt` sibling
// (never clobbering an earlier one — a counter is appended) and reported through
// `log`, and null is returned so the extension still comes up. Rename rather
// than copy, or every boot re-reads the same bytes, re-reports, and mints
// another `.corrupt.N`.
export function readJsonOrLoud(file, { log = () => {} } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = backupCorrupt(file);
    log(
      `${file} is corrupt and could not be parsed (${err.message}). Backed it up to ${backup} `
      + 'and starting from empty state — any approvals and pending messages it held are in the backup.',
    );
    return null;
  }
}

function backupCorrupt(file) {
  let target = `${file}.corrupt`;
  for (let n = 1; fs.existsSync(target); n++) target = `${file}.corrupt.${n}`;
  try {
    fs.renameSync(file, target);
  } catch {
    // Best-effort: a failed backup must not stop the extension coming up.
  }
  return target;
}
