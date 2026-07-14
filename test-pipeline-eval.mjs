import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync } from 'fs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const jdPath = join(ROOT, 'jds', `temp-${Date.now()}.txt`);
mkdirSync(dirname(jdPath), { recursive: true });
writeFileSync(jdPath, 'Customer Support Specialist at Test Corp. Requirements: High school diploma, 1+ years customer service, remote.', 'utf-8');

try {
  const result = execFileSync('node', ['cloud-eval.mjs', '--file', jdPath], { 
    cwd: ROOT, 
    timeout: 120000,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 10
  });
  console.log('RESULT:', result);
} catch (err) {
  console.error('ERROR:', err.message);
  if (err.stdout) console.log('STDOUT:', err.stdout);
  if (err.stderr) console.log('STDERR:', err.stderr);
} finally {
  try { require('fs').unlinkSync(jdPath); } catch {}
}