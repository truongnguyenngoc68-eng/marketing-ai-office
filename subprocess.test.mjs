import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, access, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {runProcess} from './subprocess.mjs';

test('passes literal arguments and stdin without invoking a shell', async () => {
  const literal = '$(echo unsafe); & | < > `literal`';
  const result = await runProcess(process.execPath, ['-e',
    "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({arg:process.argv[1],input:s})))",
    literal], {input: 'Nội dung thật\nsecond line', timeout: 5000});
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {arg: literal, input: 'Nội dung thật\nsecond line'});
});

test('retains bounded output tails and exposes truncation', async () => {
  const result = await runProcess(process.execPath, ['-e',
    "process.stdout.write('x'.repeat(20000)+'TAIL');process.stderr.write('y'.repeat(12000)+'ERR')"],
  {timeout: 5000, maxOutput: 1000});
  assert.ok(Buffer.byteLength(result.stdout) <= 1000);
  assert.ok(Buffer.byteLength(result.stderr) <= 1000);
  assert.ok(result.stdout.endsWith('TAIL'));
  assert.ok(result.stderr.endsWith('ERR'));
  assert.equal(result.outputTruncated, true);
});

test('reports a missing executable without hanging or an unhandled stdin error', async () => {
  await assert.rejects(runProcess('tram-command-that-does-not-exist-83723', [],
    {input: 'x'.repeat(500000), timeout: 5000}), error => error.code === 'ENOENT');
});

test('handles a child that closes stdin before consuming input', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.exit(0)'],
    {input: 'x'.repeat(2000000), timeout: 5000});
  assert.equal(result.code, 0);
});

test('timeout terminates descendants before rejecting and prevents delayed side effects', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tram-subprocess-'));
  const marker = path.join(temp, 'descendant-side-effect.txt');
  const pidPath = path.join(temp, 'descendant-pid.txt');
  const grandchild = "const fs=require('fs');setTimeout(()=>fs.writeFileSync(process.argv[1],'should not exist'),1700);setInterval(()=>{},1000)";
  const parent = "const {spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{windowsHide:true,stdio:'inherit'});fs.writeFileSync(process.argv[3],String(c.pid));setInterval(()=>{},1000)";
  try {
    await assert.rejects(runProcess(process.execPath, ['-e', parent, grandchild, marker, pidPath],
      {timeout: 650}), error => {
      assert.equal(error.code, 'PROCESS_TIMEOUT');
      assert.equal(error.treeTerminated, true);
      return true;
    });
    assert.ok(Number(await readFile(pidPath, 'utf8')) > 0);
    await sleep(1900);
    await assert.rejects(access(marker), error => error.code === 'ENOENT');
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temp, {recursive: true, force: true});
  }
});
