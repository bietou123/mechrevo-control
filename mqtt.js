'use strict';
// GCUBridge (官方控制中心) MQTT 3.1.1 客户端
// 只连本机 127.0.0.1:13688，只发官方控制台自己在用的主题；不碰网络配置
const net = require('node:net');
const { EventEmitter } = require('node:events');

const HOST = '127.0.0.1';
const PORT = 13688;

// 官方 SystrayComponent 长期占用的不是 7 号槽，实测 UWPClient_7 共存无冲突
const CLIENT_ID = process.env.MECHREVO_MQTT_CLIENT || 'UWPClient_7';
const USER = 'UWPClient_User_7';
const PASS = 'UWPClient_Pwd888881772688_7';

const encLen = (n) => {
  const o = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; o.push(d); } while (n > 0);
  return Buffer.from(o);
};
const encStr = (s) => {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};
const pkt = (t, f, body) => Buffer.concat([Buffer.from([(t << 4) | f]), encLen(body.length), body]);
const decLen = (b, i) => {
  let m = 1, v = 0, x;
  do { x = b[i++]; v += (x & 0x7f) * m; m *= 128; } while (x & 0x80);
  return [v, i];
};

class GcuClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.latest = new Map();   // topic -> raw string
    this.retry = null;
    this.closed = false;
  }

  connect() {
    if (this.closed || this.sock) return;
    const sock = net.connect(PORT, HOST);
    this.sock = sock;
    this.buf = Buffer.alloc(0);

    sock.on('connect', () => {
      const vh = Buffer.concat([encStr('MQTT'), Buffer.from([4, 0x02 | 0x80 | 0x40, 0, 60])]);
      sock.write(pkt(1, 0, Buffer.concat([vh, encStr(CLIENT_ID), encStr(USER), encStr(PASS)])));
    });

    sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        if (this.buf.length < 2) return;
        const [len, hlen] = decLen(this.buf, 1);
        if (this.buf.length < hlen + len) return;
        const head = this.buf[0];
        const body = this.buf.subarray(hlen, hlen + len);
        this.buf = this.buf.subarray(hlen + len);
        const type = head >> 4;
        if (type === 2) {
          if (body[1] === 0) {
            sock.write(pkt(8, 0x02, Buffer.concat([Buffer.from([0, 1]), encStr('#'), Buffer.from([0])])));
            this.connected = true;
            this.emit('connect');
          }
        } else if (type === 3) {
          const tl = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + tl).toString('utf8');
          const payload = body.subarray(2 + tl).toString('utf8');
          this.latest.set(topic, payload);
          this.emit('status', topic, payload);
        }
      }
    });

    sock.on('error', () => {});  // 连不上就静默重试，不打断界面
    sock.on('close', () => {
      this.connected = false;
      this.sock = null;
      this.emit('disconnect');
      if (!this.closed) {
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.connect(), 4000);
        if (this.retry.unref) this.retry.unref();
      }
    });
  }

  publish(topic, obj) {
    if (!this.sock || !this.connected) return false;
    const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
    try {
      this.sock.write(pkt(3, 0, Buffer.concat([encStr(topic), Buffer.from(json)])));
      return true;
    } catch { return false; }
  }

  get(topic) {
    const raw = this.latest.get(topic);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    this.sock = null;
  }
}

module.exports = { GcuClient };
