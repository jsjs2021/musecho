// choreo-xray-proxy: Express + Xray + cloudflared, for Choreo (Service, REST, port 8080)
// 部署前在 Choreo 里设置环境变量: UUID / ARGO_AUTH / ARGO_DOMAIN (见 README.md)
// Xray 的 web 二进制因为超过 GitHub 网页上传 25MB 限制,拆成了 web.part00 + web.part01,
// 启动时由下面这段代码拼回 ./web, 所以 package.json 里不要 chmod web。

const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');

// ---------- 环境变量 ----------
const UUID = process.env.UUID || '11111111-2222-4333-8444-555555555555';
const ARGO_AUTH = process.env.ARGO_AUTH || ''; // Cloudflare Tunnel token, 必填
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || ''; // 例如 cho.example.com, 必填
const CFIP = process.env.CFIP || 'www.visa.com.tw'; // 节点入口地址, 默认 www.visa.com.tw:8443
const NAME = process.env.NAME || 'Choreo';
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const XRAY_PORT = 8081; // Xray 监听端口, Tunnel 转发到这里; 不要和 Express 的 8080 冲突

if (!ARGO_AUTH) console.error('[warn] ARGO_AUTH is empty: cloudflared will not start. Set it in Choreo Configs.');
if (!ARGO_DOMAIN) console.error('[warn] ARGO_DOMAIN is empty: /sub nodes will have empty SNI. Set it in Choreo Configs.');

// ---------- 1. 把 web.part00 + web.part01 拼回 x86-64 版 Xray ----------
try {
  const p0 = './web.part00', p1 = './web.part01';
  if (fs.existsSync(p0) && fs.existsSync(p1)) {
    const s0 = fs.statSync(p0).size, s1 = fs.statSync(p1).size;
    const need = !fs.existsSync('./web') || fs.statSync('./web').size !== s0 + s1;
    if (need) {
      console.log(`reassembling web: part00=${s0} bytes part01=${s1} bytes`);
      fs.writeFileSync('./web', Buffer.concat([fs.readFileSync(p0), fs.readFileSync(p1)]));
      fs.chmodSync('./web', 0o755);
      console.log(`web reassembled: ${fs.statSync('./web').size} bytes`);
    } else {
      fs.chmodSync('./web', 0o755);
      console.log(`web already exists: ${fs.statSync('./web').size} bytes`);
    }
  } else {
    console.log(`web parts missing: part00 exists=${fs.existsSync(p0)} part01 exists=${fs.existsSync(p1)}`);
  }
} catch (e) {
  console.error(`reassemble web failed: ${e}`);
}

// ---------- 2. 用环境变量里的 UUID 生成 config.json ----------
// 模板在 config.template.json, 里面的 __UUID__ 会被替换成上面的 UUID。
try {
  const tpl = fs.readFileSync('./config.template.json', 'utf-8');
  const cfg = tpl.split('__UUID__').join(UUID).replace('__XRAY_PORT__', String(XRAY_PORT));
  fs.writeFileSync('./config.json', cfg);
  console.log(`config.json generated: xray port=${XRAY_PORT} uuid=${UUID}`);
} catch (e) {
  console.error(`generate config.json failed: ${e}`);
}

// ---------- 3. Express: / 和 /sub ----------
const app = express();
app.get('/', (req, res) => res.send('Hello world!'));

app.get('/sub', (req, res) => {
  const VMESS = { v: '2', ps: `${NAME}`, add: CFIP, port: '8443', id: UUID, aid: '0', scy: 'none', net: 'ws', type: 'none', host: ARGO_DOMAIN, path: '/vmess?ed=2048', tls: 'tls', sni: ARGO_DOMAIN, alpn: '' };
  const vlessURL = `vless://${UUID}@${CFIP}:8443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Fvless?ed=2048#${NAME}`;
  const vmessURL = `vmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}`;
  const trojanURL = `trojan://${UUID}@${CFIP}:8443?security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Ftrojan?ed=2048#${NAME}`;
  const base64Content = Buffer.from(`${vlessURL}\n\n${vmessURL}\n\n${trojanURL}`).toString('base64');
  res.type('text/plain; charset=utf-8').send(base64Content);
});

app.listen(PORT, () => console.log(`App is listening on port ${PORT}!`));

// ---------- 4. 启动进程: 死了 5 秒后自动重启, 日志直接打到 Choreo ----------
function startProcess(name, cmd, args, onReady) {
  console.log(`starting ${name}: ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('error', (err) => console.error(`${name} start error: ${err}`));
  child.on('exit', (code, signal) => {
    console.error(`${name} exited code=${code} signal=${signal}, restarting in 5s`);
    setTimeout(() => startProcess(name, cmd, args, null), 5000);
  });
  if (onReady) setTimeout(onReady, 2000);
  return child;
}

function runWeb() {
  startProcess('web', './web', ['-c', './config.json'], runServer);
}

function runServer() {
  if (!ARGO_AUTH) { console.error('server skipped: ARGO_AUTH is empty'); return; }
  let args;
  if (/^[A-Z0-9a-z=]{120,250}$/.test(ARGO_AUTH)) {
    args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--region', 'us', '--protocol', 'http2', 'run', '--token', ARGO_AUTH];
  } else {
    args = ['tunnel', '--edge-ip-version', 'auto', '--config', 'tunnel.yml', 'run'];
  }
  startProcess('server', './server', args, null);
}

// 先启动 Xray, 2 秒后再启动 cloudflared
runWeb();
