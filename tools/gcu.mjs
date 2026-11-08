/**
 * GCU 总线客户端：连上机械革命官方服务 GCUBridge 的本地 MQTT(127.0.0.1:13688)，
 * 订阅回包并发送控制命令。
 *
 * 用法:
 *   node tools/gcu.mjs sub [过滤器] [--secs 10]
 *   node tools/gcu.mjs pub <主题> <JSON载荷> [--wait 3]
 *   node tools/gcu.mjs seq <步骤JSON文件>
 *
 * 凭据已从 GoodixTest/GCUBridge.exe 的字符串表确认：
 *   clientId=MyControlCenter  user=MyControlCenterUser  pass=MyControlCenterPwd888881772688
 */
import net from 'node:net';

export const HOST = process.env.GCU_HOST || '127.0.0.1';
export const PORT = Number(process.env.GCU_PORT || 13688);
export const CLIENT_ID = process.env.GCU_CLIENT || 'MyControlCenter';
export const USER = process.env.GCU_USER || 'MyControlCenterUser';
export const PASS = process.env.GCU_PASS || 'MyControlCenterPwd888881772688';

/* ---------- 编码 ---------- */
function encLen(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return Buffer.from(out);
}
function encStr(s) {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
}
function pkt(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(body.length), body]);
}
function buildConnect(id = CLIENT_ID, user = USER, pass = PASS) {
  let flags = 0x02; // clean session
  const tail = [];
  if (user) {
    flags |= 0x80;
    tail.push(encStr(user));
    if (pass != null) { flags |= 0x40; tail.push(encStr(pass)); }
  }
  const vh = Buffer.concat([encStr('MQTT'), Buffer.from([4, flags]), Buffer.from([0, 60])]);
  return pkt(1, 0, Buffer.concat([vh, encStr(id), ...tail]));
}
function buildSubscribe(pid, filter, qos = 0) {
  return pkt(8, 0x02, Buffer.concat([Buffer.from([pid >> 8, pid & 0xff]), encStr(filter), Buffer.from([qos])]));
}
function buildPublish(topic, payload, { retain = false, qos = 0 } = {}) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const parts = [encStr(topic)];
  if (qos > 0) parts.push(Buffer.from([0, 1])); // 固定包标识 1，实验用足够
  parts.push(p);
  return pkt(3, (qos << 1) | (retain ? 1 : 0), Buffer.concat(parts));
}
function decodeLen(buf, i) {
  let mult = 1, val = 0, b;
  do { b = buf[i++]; val += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
  return [val, i];
}

/**
 * 建立一条订阅 '#" 的连接。
 * @returns {Promise<{publish:(t:string,p:any)=>void, onMessage:Function, close:Function, rc:number}>}
 */
export function connectGcu({ filter = '#', keepalive = 60 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    let buf = Buffer.alloc(0);
    let connected = false;
    const listeners = new Set();

    const emit = (msg) => { for (const fn of listeners) { try { fn(msg); } catch { /* 忽略单个回调异常 */ } } };

    sock.on('connect', () => sock.write(buildConnect()));
    sock.on('error', (e) => { if (!connected) reject(e); });
    sock.on('close', () => { if (!connected) reject(new Error('连接被关闭')); });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const [len, hlen] = decodeLen(buf, 1);
        if (buf.length < hlen + len) return;
        const head = buf[0];
        const body = buf.subarray(hlen, hlen + len);
        buf = buf.subarray(hlen + len);
        const type = head >> 4;
        const flags = head & 0x0f;
        if (type === 2) {
          const rc = body[1];
          if (rc !== 0) { sock.destroy(); return reject(new Error('CONNACK 拒绝 rc=' + rc)); }
          connected = true;
          sock.write(buildSubscribe(1, filter, 0));
          resolve({
            rc,
            publish(topic, payload, opts) { sock.write(buildPublish(topic, payload, opts)); },
            onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            close() { try { sock.end(); } catch { /* noop */ } },
            get closed() { return sock.destroyed; },
          });
        } else if (type === 3) {
          const qos = (flags >> 1) & 3;
          const tlen = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + tlen).toString('utf8');
          let i = 2 + tlen + (qos > 0 ? 2 : 0);
          const payload = body.subarray(i);
          emit({ topic, payload, text: payload.toString('utf8'), t: Date.now() });
        } else if (type === 13) { /* PINGRESP */
        } else if (type === 14) {
          sock.destroy();
        }
      }
    });

    const ka = setInterval(() => {
      if (sock.destroyed) return clearInterval(ka);
      sock.write(pkt(12, 0, Buffer.alloc(0)));
    }, Math.floor(keepalive * 1000 / 2));
    sock.on('close', () => clearInterval(ka));
  });
}

/* ---------------- CLI ---------------- */
const isCli = process.argv[1] && /gcu\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isCli) {
  const [, , cmd, a1, a2] = process.argv;
  const num = (name, def) => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? Number(process.argv[i + 1]) : def;
  };
  const ts = () => new Date().toISOString().slice(11, 23);
  const short = (s) => (s.length > 600 ? s.slice(0, 600) + '…(' + s.length + 'B)' : s);

  const c = await connectGcu();
  if (cmd === 'sub') {
    const secs = num('secs', 10);
    c.onMessage((m) => console.log(`${ts()} ${m.topic} ${short(m.text)}`));
    setTimeout(() => { c.close(); process.exit(0); }, secs * 1000);
  } else if (cmd === 'pub') {
    const wait = num('wait', 3);
    c.onMessage((m) => console.log(`${ts()} ${m.topic} ${short(m.text)}`));
    setTimeout(() => { console.log(`>>> ${a1} ${a2}`); c.publish(a1, a2 ?? ''); }, 300);
    setTimeout(() => { c.close(); process.exit(0); }, wait * 1000);
  } else if (cmd === 'seq') {
    const steps = JSON.parse((await import('node:fs')).readFileSync(a1, 'utf8'));
    c.onMessage((m) => console.log(`${ts()} ${m.topic} ${short(m.text)}`));
    let t = 300;
    for (const s of steps) {
      setTimeout(() => { console.log(`>>> ${s[0]} ${s[1]}`); c.publish(s[0], s[1]); }, t);
      t += (s[2] || 1500);
    }
    setTimeout(() => { c.close(); process.exit(0); }, t + 500);
  } else {
    console.log('用法: sub [过滤器] [--secs 10] | pub <主题> <载荷> [--wait 3] | seq <步骤文件>');
    c.close();
    process.exit(1);
  }
}
