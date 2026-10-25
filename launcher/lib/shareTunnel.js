'use strict';
/**
 * "Let friends join over the internet": exposes the lobby server running on this PC through a
 * free Cloudflare quick tunnel (no account, no router setup). Cloudflare gives a random
 * https://<words>.trycloudflare.com address that lasts until the tunnel stops.
 *
 * The cloudflared program (~40 MB) is downloaded from Cloudflare's GitHub releases on first use.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function assetName() {
  const arm = process.arch === 'arm64';
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
  if (process.platform === 'darwin') return arm ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  return arm ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'netcade' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed (HTTP ${res.statusCode})`));
        return;
      }
      const total = +res.headers['content-length'] || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; onProgress(got, total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('Timed out downloading the tunnel program')));
    req.on('error', reject);
  });
}

class ShareTunnel extends EventEmitter {
  constructor({ binDir, log = () => {} }) {
    super();
    this.binDir = binDir;
    this.log = log;
    this.child = null;
    this.status = { state: 'off', url: '', error: '' };
    this.wantPort = 0;
    this.restarts = 0;
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  binaryPath() {
    if (process.env.NETCADE_CLOUDFLARED) return process.env.NETCADE_CLOUDFLARED;
    return path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  async ensureBinary() {
    const bin = this.binaryPath();
    if (fs.existsSync(bin)) return bin;
    fs.mkdirSync(this.binDir, { recursive: true });
    const asset = assetName();
    const tmp = path.join(this.binDir, `${asset}.part`);
    this.set({ state: 'downloading', progress: 0, error: '' });
    await download(RELEASE + asset, tmp, (got, total) => {
      if (total) this.set({ progress: Math.round((got / total) * 100) });
    });
    if (asset.endsWith('.tgz')) {
      await new Promise((resolve, reject) => execFile('tar', ['-xzf', tmp, '-C', this.binDir], (e) => (e ? reject(e) : resolve())));
      fs.unlinkSync(tmp);
    } else {
      fs.renameSync(tmp, bin);
    }
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
    if (process.platform === 'darwin') execFile('/usr/bin/xattr', ['-d', 'com.apple.quarantine', bin], () => {});
    return bin;
  }

  /** Start sharing http://127.0.0.1:<port>. Resolves with the public URL. */
  async start(port) {
    this.wantPort = port;
    if (this.child) return this.status.url;
    try {
      const bin = await this.ensureBinary();
      if (!this.wantPort) return '';
      this.set({ state: 'starting', url: '', error: '' });
      return await this.spawn(bin, port);
    } catch (err) {
      this.log('share tunnel failed:', err.message);
      const net = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Timed out/i.test(err.message);
      this.set({ state: 'error', url: '', error: net ? 'Couldn\'t reach Cloudflare. Check your internet connection.' : err.message });
      return '';
    }
  }

  /** A tunnel left running by a previous Netcade that crashed: stop it. */
  killStale() {
    const pidFile = path.join(this.binDir, 'tunnel.pid');
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      if (pid > 0) process.kill(pid);
    } catch { /* none, or already gone */ }
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
  }

  spawn(bin, port) {
    return new Promise((resolve, reject) => {
      this.killStale();
      const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
      const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      try {
        fs.mkdirSync(this.binDir, { recursive: true });
        fs.writeFileSync(path.join(this.binDir, 'tunnel.pid'), String(child.pid));
      } catch { /* not critical */ }
      let url = '';
      let buf = '';
      const timer = setTimeout(() => {
        if (!url) {
          child.kill();
          reject(new Error('Cloudflare didn\'t hand out an address in time. Try again in a minute.'));
        }
      }, 60000);
      const onData = (d) => {
        buf = (buf + d.toString()).slice(-8000);
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(buf);
        if (m && !url) {
          url = m[0];
          clearTimeout(timer);
          this.restarts = 0;
          this.set({ state: 'on', url, error: '' });
          this.log('share tunnel up:', url);
          resolve(url);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { clearTimeout(timer); this.child = null; reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (!url) {
          const why = /failed to request quick tunnel[^\n]*/i.exec(buf);
          reject(new Error(why ? why[0] : `The tunnel program stopped (code ${code}).`));
          return;
        }
        // it was running and died: restart a couple of times (new address), unless we stopped it
        if (this.wantPort && this.restarts < 3) {
          this.restarts++;
          this.log('share tunnel exited, restarting');
          this.set({ state: 'starting', url: '' });
          this.spawn(bin, this.wantPort).catch((e) => this.set({ state: 'error', url: '', error: e.message }));
        } else if (this.wantPort) {
          this.set({ state: 'error', url: '', error: 'The internet tunnel keeps stopping. Toggle sharing off and on.' });
        }
      });
    });
  }

  stop() {
    this.wantPort = 0;
    if (this.child) {
      const c = this.child;
      this.child = null;
      try { c.kill(); } catch { /* already gone */ }
      try { fs.unlinkSync(path.join(this.binDir, 'tunnel.pid')); } catch { /* ignore */ }
    }
    this.set({ state: 'off', url: '', error: '' });
  }
}

module.exports = { ShareTunnel, assetName };
