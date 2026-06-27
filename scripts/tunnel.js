import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

try {
    execSync('cloudflared --version', { stdio: 'ignore' });
} catch (e) {
    console.error(`
✖ cloudflared is not installed.

  Windows: Scoop:  scoop install cloudflared
           Choco:  choco install cloudflared
  macOS:   brew install cloudflared
  Arch:    sudo pacman -S cloudflared
  Other:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

No account or login is needed for quick tunnels.
`);
    process.exit(1);
}

const port = process.argv[2] || '3001';
console.log(`\nStarting Cloudflare tunnel → http://localhost:${port} ...`);

const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);

let tunnelUrl = '';
const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const cleanup = () => {
    if (cf) {
        cf.kill();
    }
    process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

cf.stderr.on('data', (data) => {
    const output = data.toString();
    const match = output.match(urlRegex);

    if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        console.log(`\n  \x1b[32m✓ Tunnel ready:\x1b[0m \x1b[4m${tunnelUrl}\x1b[0m\n`);
        console.log(`  → Starting dev servers with BACKEND_URL=${tunnelUrl}...`);

        const shell = process.platform === 'win32';
        const devProcess = spawn('npm', ['run', 'dev'], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
            shell,
            env: {
                ...process.env,
                BACKEND_URL: tunnelUrl,
            }
        });

        devProcess.on('exit', (code) => {
            cf.kill();
            process.exit(code || 0);
        });
    }
});

cf.on('close', (code) => {
    if (!tunnelUrl) {
        console.error('✖ cloudflared tunnel closed unexpectedly with code', code);
        process.exit(1);
    }
});