import { Readable } from 'node:stream';
import FC from '@alicloud/fc20230330';
import OpenApi from '@alicloud/openapi-client';
import { createGateway } from '../server/vercel-gateway.mjs';

let client;
async function invoke(event) {
  client ||= new FC.default(new OpenApi.Config({
    accessKeyId: process.env.FC_ACCESS_KEY_ID,
    accessKeySecret: process.env.FC_ACCESS_KEY_SECRET,
    regionId: 'cn-beijing', endpoint: 'fcv3.cn-beijing.aliyuncs.com',
    connectTimeout: 5000, readTimeout: 22000
  }));
  const result = await client.invokeFunction('peaceful-life', new FC.InvokeFunctionRequest({
    qualifier: 'LATEST', body: Readable.from([Buffer.from(JSON.stringify(event))])
  }));
  const chunks = []; let length = 0;
  for await (const chunk of result.body) {
    length += chunk.length;
    if (length > 65536) throw new Error('Oversized bridge response');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export default createGateway({ env: process.env, invoke });
