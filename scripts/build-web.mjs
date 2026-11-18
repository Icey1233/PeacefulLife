import { mkdir, rm, copyFile } from 'node:fs/promises';
const output = new URL('../public/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'style.css', 'game.js', 'account.js']) await copyFile(new URL('../' + file, import.meta.url), new URL(file, output));
console.log('Public output contains only the four game assets.');
