import fs from 'node:fs';
import { readJson, save, execute, killTree, settings } from './lib.mjs';

const [file, id] = process.argv.slice(2);
let job = readJson(file);
if (job.id !== id || job.status !== 'starting') process.exit(2);
let childPid;
let stopping = false;
let terminationFailed = false;
const stop = async () => { stopping = true; try { await killTree(childPid); } catch { terminationFailed = true; } };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
const timer = setInterval(() => {
  try { if (fs.readFileSync(`${file}.stop`, 'utf8') === id) void stop(); } catch (e) { if (e.code !== 'ENOENT') void stop(); }
}, 100);
try {
  const result = await execute(job.command, job.cwd, {
    shell: job.shell === true, line: job.line,
    // A job's lifetime is the owner's setting (jobLimitSeconds; 0 = no limit). job_stop always ends it.
    deadlineMs: settings(job.home).jobSeconds * 1000,
    onStart(pid) { childPid = pid; job = { ...job, pid, supervisor_pid: process.pid, status: 'running' }; save(file, job); if (stopping) void stop(); },
  });
  if (terminationFailed) save(file, { ...job, status: 'stopping', exit_code: -1, termination_failed: true });
  else save(file, { ...job, status: stopping ? 'stopped' : 'done', exit_code: result.exit_code, result });
} catch {
  try { await killTree(childPid); } catch { terminationFailed = true; }
  save(file, { ...job, status: terminationFailed ? 'stopping' : 'failed', exit_code: -1, termination_failed: terminationFailed });
} finally { clearInterval(timer); try { fs.unlinkSync(`${file}.stop`); } catch {} }
