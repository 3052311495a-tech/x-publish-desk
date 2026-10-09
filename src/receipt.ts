import * as fs from 'fs';
import * as path from 'path';
import { type UploadResult } from './backend';
import { stateDir } from './config';

/** Read an explicit, verified article receipt; never infer a screenshot path. */
export function resolveEvidence(result: UploadResult): string | null {
  if (typeof result.evidence === 'string' && result.evidence.trim()) return result.evidence;
  if (result.kind !== 'article' || typeof result.draft_url !== 'string' || !result.draft_url) return null;
  const records = stateDir();
  const matches: string[] = [];
  try {
    for (const name of fs.readdirSync(records)) {
      if (!/^article-[a-f0-9]{64}$/.test(name)) continue;
      const directory = path.join(records, name);
      try {
        // Do not follow symbolic links outside the fixed receipt directory.
        if (!fs.lstatSync(directory).isDirectory()) continue;
        const receipt = path.join(directory, 'result.json');
        const evidence = path.join(directory, 'final.png');
        if (!fs.lstatSync(receipt).isFile() || !fs.lstatSync(evidence).isFile()) continue;
        const saved = JSON.parse(fs.readFileSync(receipt, 'utf8')) as Record<string, unknown>;
        if (saved.draft_url === result.draft_url
          && saved.verification_contract === 'x-article-persistence-v1'
          && saved.persistence_verified === true) matches.push(evidence);
      } catch { /* An incomplete or unreadable receipt is not evidence. */ }
    }
  } catch { return null; }
  return matches.length === 1 ? matches[0] : null;
}
