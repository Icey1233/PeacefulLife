import { mkdir, rm, cp, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = resolve(root, '.deployment/fc');
const downloads = resolve(root, '.deployment/downloads');
const output = resolve(root, 'dist/peaceful-life-fc.zip');
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const releases = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString('utf8'));
const release = releases.find(item => item.version.startsWith('v22.') && item.lts && item.files.includes('linux-x64'));
if (!release) throw new Error('No supported Node.js 22 LTS Linux release found.');
const name = `node-${release.version}-linux-x64`;
const archiveName = name + '.tar.gz';
const base = `https://nodejs.org/dist/${release.version}`;
console.log(`Packaging ${release.version} for Alibaba Cloud FC custom.debian12 (Linux x64).`);
const archivePath = resolve(downloads, archiveName);
let cachedArchive;
try { cachedArchive = await readFile(archivePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const [archive, checksums] = await Promise.all([cachedArchive || download(`${base}/${archiveName}`), download(`${base}/SHASUMS256.txt`)]);
const checksum = checksums.toString('utf8').split('\n').find(line => line.endsWith('  ' + archiveName))?.split(' ')[0];
const actual = createHash('sha256').update(archive).digest('hex');
if (!checksum || checksum !== actual) throw new Error('Node.js runtime checksum mismatch.');
await rm(stage, { recursive: true, force: true });
await mkdir(resolve(stage, 'runtime/bin'), { recursive: true });
await mkdir(downloads, { recursive: true });
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(archivePath, archive);
await exec('tar', ['-xzf', archivePath, '--strip-components=2', '-C', resolve(stage, 'runtime/bin'), `${name}/bin/node`]);
await chmod(resolve(stage, 'runtime/bin/node'), 0o755);
// Explicit allowlist: no .env, local accounts, screenshots, tests, or deployment credentials.
for (const file of ['index.html', 'style.css', 'game.js', 'account.js', 'package.json', 'package-lock.json', 'server', 'node_modules']) await cp(resolve(root, file), resolve(stage, file), { recursive: true });
await writeFile(resolve(stage, 'runtime-manifest.json'), JSON.stringify({ version: release.version, platform: 'linux-x64', archive: `${base}/${archiveName}`, sha256: checksum }, null, 2));
await rm(output, { force: true });
await exec('zip', ['-q', '-r', output, '.'], { cwd: stage, maxBuffer: 1024 * 1024 });
console.log(`Ready: ${output}`);
console.log('No cloud resources were created. Upload this ZIP using deploy/README.md.');
