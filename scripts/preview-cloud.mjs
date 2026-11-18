import { createPreviewProxy } from '../server/preview-proxy.mjs';

const origin = 'http://localhost:5175';
const upstream = 'https://peaceful-life-nfimatrbbh.cn-beijing.fcapp.run';
const app = createPreviewProxy({ origin, upstream });
app.requestTimeout = 30000;
app.headersTimeout = 10000;
app.on('error', error => { console.error('无法启动云端预览：', error.code); process.exitCode = 1; });
app.listen(5175, '127.0.0.1', () => {
  console.log(`云端联调入口：${origin}`);
  console.log('账号和存档使用阿里云 OSS；此入口仅限本机测试。关闭进程即停止访问。');
});
