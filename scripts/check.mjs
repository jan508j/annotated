import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}
let count = 0;
for (const directory of ['api','server','shared','extension','web','scripts','test']) {
  for (const file of await files(directory)) {
    if (!/\.(m?js)$/.test(file)) continue;
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) { console.error(check.stderr); process.exit(1); }
    count++;
  }
}
console.log(`Syntax checked ${count} JavaScript modules.`);
