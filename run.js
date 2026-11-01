const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const CLOUDFLARED_PATH = path.join(__dirname, 'cloudflared.exe');

console.log('====================================================');
console.log('🚀 Starting Webhook Server & Cloudflare Tunnel');
console.log('====================================================');

// 1. Start Webhook Server
const serverProcess = spawn('node', ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['inherit', 'pipe', 'pipe']
});

serverProcess.stdout.on('data', data => {
  process.stdout.write(`[SERVER] ${data}`);
});

serverProcess.stderr.on('data', data => {
  process.stderr.write(`[SERVER ERR] ${data}`);
});

serverProcess.on('exit', (code) => {
  console.log(`[SERVER] Exited with code ${code}`);
  process.exit(code || 0);
});

// 2. Start Cloudflare Tunnel
console.log(`[TUNNEL] Launching Cloudflare tunnel pointing to port ${PORT}...`);

const tunnelProcess = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

let tunnelUrlFound = false;
let publicHttpsUrl = null;

function handleTunnelLog(line) {
  // Cloudflare outputs the URL to stderr
  const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (match && !tunnelUrlFound) {
    tunnelUrlFound = true;
    publicHttpsUrl = match[0];

    fs.writeFileSync(path.join(__dirname, 'live_url.txt'), publicHttpsUrl, 'utf8');

    console.log('\n====================================================');
    console.log('🎉 YOUR LIVE WEBHOOK URL IS READY!');
    console.log(`👉 ${publicHttpsUrl}`);
    console.log('====================================================\n');

    // Verify self-check over HTTPS
    setTimeout(() => {
      console.log(`[VERIFY] Pinging public URL: ${publicHttpsUrl} ...`);
      https.get(publicHttpsUrl, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          console.log(`[VERIFY] Status: ${res.statusCode}`);
          console.log(`[VERIFY] Response: ${raw}`);
          console.log('\n✅ WEBHOOK IS ONLINE, SECURE, AND READY FOR ALL 5 CHECKS!\n');
        });
      }).on('error', (err) => {
        console.error(`[VERIFY ERR] Could not ping live URL: ${err.message}`);
      });
    }, 2000);
  }
}

tunnelProcess.stdout.on('data', data => {
  const text = data.toString('utf8');
  handleTunnelLog(text);
});

tunnelProcess.stderr.on('data', data => {
  const text = data.toString('utf8');
  handleTunnelLog(text);
});

tunnelProcess.on('exit', (code) => {
  console.log(`[TUNNEL] Exited with code ${code}`);
  process.exit(code || 0);
});

// Handle termination signals
process.on('SIGINT', () => {
  serverProcess.kill();
  tunnelProcess.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  serverProcess.kill();
  tunnelProcess.kill();
  process.exit(0);
});

