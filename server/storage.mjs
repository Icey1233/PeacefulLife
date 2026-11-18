import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import OSS from 'ali-oss';

export class OssStore {
  constructor(client) { this.client = client; this.kind = 'oss'; }
  async read(key) {
    try {
      const result = await this.client.get(key);
      return JSON.parse(result.content.toString('utf8'));
    } catch (error) {
      if (error.code === 'NoSuchKey') return null;
      throw error;
    }
  }
  async write(key, value, { createOnly = false } = {}) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'x-oss-object-acl': 'private'
    };
    if (createOnly) headers['x-oss-forbid-overwrite'] = 'true';
    try {
      await this.client.put(key, Buffer.from(JSON.stringify(value)), { headers });
    } catch (error) {
      if (error.code === 'FileAlreadyExists') error.code = 'ALREADY_EXISTS';
      throw error;
    }
  }
  async delete(key) { await this.client.delete(key); }
}

// Explicit development/test storage. It is never selected on OSS errors.
export class LocalStore {
  constructor(root) { this.root = resolve(root); this.kind = 'local'; }
  path(key) {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }
  async read(key) {
    try { return JSON.parse(await readFile(this.path(key), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(key, value, { createOnly = false } = {}) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (createOnly) {
      try { await writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') error.code = 'ALREADY_EXISTS'; throw error; }
    } else {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
  }
  async delete(key) { await unlink(this.path(key)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function configuredStore(env, root, local = false) {
  if (local) {
    if (env.NODE_ENV === 'production') throw new Error('Production cannot use local account storage.');
    return new LocalStore(resolve(root, '.local-data'));
  }
  if (!env.OSS_REGION || !env.OSS_ACCESS_KEY_ID || !env.OSS_ACCESS_KEY_SECRET) return null;
  return new OssStore(new OSS({
    bucket: env.OSS_BUCKET || 'peaceful-life-data',
    region: env.OSS_REGION,
    ...(env.OSS_ENDPOINT ? { endpoint: env.OSS_ENDPOINT } : {}),
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    ...(env.OSS_STS_TOKEN ? { stsToken: env.OSS_STS_TOKEN } : {}),
    authorizationV4: true,
    secure: true,
    timeout: 15000
  }));
}
