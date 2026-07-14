@echo off
set ROOT=C:\dafe-career-os
cd /d %ROOT%

echo Testing pipeline with 1 job...
node -e "
const { execFileSync } = require('child_process');
const { join, dirname } = require('path');
const { fileURLToPath } = require('url');
const { mkdirSync, writeFileSync, unlinkSync } = require('fs');

const ROOT = dirname(fileURLToPath(import.meta.url));
const jdPath = join(ROOT, 'jds', 'temp-test.txt');
mkdirSync(dirname(jdPath), { recursive: true });
writeFileSync(jdPath, 'Customer Support Specialist at Test Corp. Requirements: High school diploma, 1+ years customer service, remote.');

try {
  const result = execFileSync('node', ['cloud-eval.mjs', '--file', jdPath], { 
    cwd: ROOT, 
    timeout: 120000,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 10
  });
  console.log('=== OUTPUT ===');
  console.log(result);
  console.log('=== END ===');
} catch (err) {
  console.error('ERROR:', err.message);
  if (err.stdout) console.log('STDOUT:', err.stdout);
  if (err.stderr) console.log('STDERR:', err.stderr);
} finally {
  try { unlinkSync(jdPath); } catch {}
}
" 2>&1