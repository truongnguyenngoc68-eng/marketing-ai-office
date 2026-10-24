import {spawn} from 'node:child_process';
import path from 'node:path';

const MAX_BUFFER = 16 * 1024 * 1024;

function boundedTail(limit) {
  let chunks = [], length = 0, truncated = false;
  return {
    append(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      chunks.push(chunk);
      length += chunk.length;
      if (length > limit) truncated = true;
      while (length > limit && chunks.length) {
        const excess = length - limit;
        if (chunks[0].length <= excess) length -= chunks.shift().length;
        else { chunks[0] = chunks[0].subarray(excess); length -= excess; }
      }
    },
    value() { return Buffer.concat(chunks, length).toString('utf8'); },
    get truncated() { return truncated; },
  };
}

function processError(message, code, details = {}) {
  return Object.assign(new Error(message), {code, ...details});
}

/**
 * Execute an executable with literal arguments and no shell. Prompts belong on
 * stdin, not in shell command strings. Output is retained as a bounded tail.
 * On timeout, reject only after tree termination and the child's close event.
 */
export function runProcess(command, args, {cwd, input = '', timeout = 600000, maxOutput = 2000000} = {}) {
  if (typeof command !== 'string' || !command.trim() || !Array.isArray(args) || args.some(a => typeof a !== 'string'))
    return Promise.reject(new TypeError('command must be a non-empty string and args an array of strings'));
  if (typeof input !== 'string' && !Buffer.isBuffer(input))
    return Promise.reject(new TypeError('input must be a string or Buffer'));
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400000)
    return Promise.reject(new TypeError('timeout must be between 1 and 86400000 milliseconds'));
  if (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > MAX_BUFFER)
    return Promise.reject(new TypeError('maxOutput must be an integer between 1 and 16777216 bytes'));

  return new Promise((resolve, reject) => {
    const stdout = boundedTail(maxOutput), stderr = boundedTail(Math.min(maxOutput, 64000));
    let child, spawnError, stdinError, timedOut = false, closed = false;
    let settled = false, termination = Promise.resolve({confirmed: true});
    let timer;

    const finish = async (code, signal) => {
      if (settled) return;
      closed = true;
      clearTimeout(timer);
      const killed = await termination;
      if (settled) return;
      settled = true;
      const details = {
        stdout: stdout.value(), stderr: stderr.value(), exitCode: code, signal,
        outputTruncated: stdout.truncated || stderr.truncated,
      };
      if (spawnError) return reject(Object.assign(spawnError, details));
      if (timedOut) return reject(processError(
        killed.confirmed
          ? 'Tác vụ vượt giới hạn thời gian; cây tiến trình đã được dừng.'
          : 'Tác vụ vượt giới hạn thời gian; chưa xác nhận dừng toàn bộ tiến trình con. Không tự chạy lại.',
        killed.confirmed ? 'PROCESS_TIMEOUT' : 'PROCESS_TERMINATION_UNCONFIRMED',
        {...details, treeTerminated: killed.confirmed},
      ));
      if (stdinError) return reject(Object.assign(stdinError, details));
      resolve({code, signal, stdout: details.stdout, stderr: details.stderr, outputTruncated: details.outputTruncated});
    };

    try {
      child = spawn(command, args, {
        cwd, windowsHide: true, shell: false,
        // A private POSIX process group lets timeout cleanup include descendants.
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) { reject(error); return; }

    child.stdout.on('data', chunk => stdout.append(chunk));
    child.stderr.on('data', chunk => stderr.append(chunk));
    child.stdin.on('error', error => {
      // A child may intentionally exit without consuming all input. EPIPE must
      // never crash the host process or replace the child's real result.
      if (!['EPIPE', 'EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code)) stdinError = error;
    });
    child.on('error', error => { spawnError = error; });
    child.once('close', (code, signal) => { void finish(code, signal); });

    timer = setTimeout(() => {
      if (closed || settled) return;
      timedOut = true;
      termination = terminateTree(child).then(result => {
        if (!result.confirmed) {
          // Fail closed: stop the direct process as a fallback but explicitly
          // report that descendant cleanup could not be proved. Closing pipes
          // prevents an orphan holding inherited stdio open from hanging us.
          try { child.kill('SIGKILL'); } catch {}
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
        return result;
      });
    }, timeout);
    child.stdin.end(input);
  });
}

async function terminateTree(child) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return {confirmed: false};
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); return {confirmed: true}; }
    catch (error) { return {confirmed: error.code === 'ESRCH' && child.exitCode !== null}; }
  }

  // PID comes exclusively from spawn(), never from request data. No shell or
  // string-built command is involved. /T terminates children before /F kills.
  return new Promise(resolve => {
    let killer;
    try {
      const taskkill = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
      killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, shell: false, stdio: 'ignore',
      });
    } catch { resolve({confirmed: false}); return; }
    killer.once('error', () => resolve({confirmed: false}));
    killer.once('close', code => resolve({confirmed: code === 0}));
  });
}
