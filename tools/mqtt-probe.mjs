/**
 * 极简 MQTT 3.1.1 客户端（零依赖），用于探测机械革命 GCUBridge 的本地总线。
 *
 * 用法:
 *   node mqtt-probe.mjs sub '#'                 订阅并打印（默认 8 秒后退出）
 *   node mqtt-probe.mjs sub 'gcu/#' --secs 20
 *   node mqtt-probe.mjs pub <topic> <payload>   发一条 QoS0 消息
 *   node mqtt-probe.mjs pubraw <topic> <hex>    发二进制载荷
 */
import net from 'node:net';

const HOST = process.env.GCU_HOST || '127.0.0.1';
const PORT = Number(process.env.GCU_PORT || 13688);

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
function buildConnect(id, user, pass) {
  let flags = 0x02; // clean session
  const tail = [];
  if (user) {
    flags |= 0x80;
    tail.push(encStr(user));
    if (pass != null) { flags |= 0x40; tail.push(encStr(pass)); }
  }
  const vh = Buffer.concat([
    encStr('MQTT'),
    Buffer.from([4, flags]),
    Buffer.from([0, 60]),   // keepalive 60s
  ]);
  return pkt(1, 0, Buffer.concat([vh, encStr(id), ...tail]));
}
function buildSubscribe(id, pid, filter, qos = 0) {
  const body = Buffer.concat([
    Buffer.from([pid >> 8, pid & 0xff]),
    encStr(filter),
    Buffer.from([qos]),
  ]);
  return pkt(8, 0x02, body);
}
function buildPublish(topic, payload) {
  return pkt(3, 0, Buffer.concat([encStr(topic), Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')]));
}

/* ---------- 解包 ---------- */
function decodeLen(buf, i) {
  let mult = 1, val = 0, b;
  do {
    b = buf[i++];
    val += (b & 0x7f) * mult;
    mult *= 128;
  } while (b & 0x80);
  return [val, i];
}

let buf = Buffer.alloc(0);
const handlers = [];
function onPacket(fn) { handlers.push(fn); }
function feed(chunk) {
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
    for (const h of handlers) h(type, flags, body);
  }
}

function fmtPayload(b) {
  const text = b.toString('utf8');
  // 能完整还原成可打印文本就当文本，否则给十六进制
  const printable = /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(text);
  if (printable) return text;
  return '0x' + b.toString('hex');
}

const [, , cmd, a1, a2] = process.argv;
const secs = Number(process.env.GCU_SECS || (process.argv.includes('--secs') ? process.argv[process.argv.indexOf('--secs') + 1] : 0) || 8);

const sock = net.connect(PORT, HOST, () => {
  const cid = process.env.GCU_CLIENT || 'mcprobe' + Math.floor(Math.random() * 1e6);
  const user = process.env.GCU_USER || '';
  const pass = process.env.GCU_PASS || '';
  sock.write(buildConnect(cid, user, pass));
});

let connected = false;

onPacket((type, flags, body) => {
  switch (type) {
    case 2: { // CONNACK
      const rc = body[1];
      console.log(`[CONNACK] returnCode=${rc}`);
      if (rc !== 0) { console.log('连接被拒绝'); sock.end(); return; }
      connected = true;
      if (cmd === 'sub') {
        const filt = a1 || '#';
        console.log(`[SUBSCRIBE] ${filt} qos0`);
        sock.write(buildSubscribe(1, 1, filt, 0));
      } else if (cmd === 'pub' || cmd === 'pubraw') {
        const payload = cmd === 'pubraw' ? Buffer.from(a2 || '', 'hex') : (a2 ?? '');
        console.log(`[PUBLISH] ${a1} <- ${cmd === 'pubraw' ? '0x' + payload.toString('hex') : payload}`);
        sock.write(buildPublish(a1, payload));
        setTimeout(() => { sock.end(); process.exit(0); }, 400);
      }
      break;
    }
    case 3: { // PUBLISH
      const qos = (flags >> 1) & 3;
      let i = 0;
      const tlen = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + tlen).toString('utf8');
      i = 2 + tlen;
      if (qos > 0) i += 2;
      const payload = body.subarray(i);
      const ts = new Date().toISOString().slice(11, 23);
      console.log(`${ts} ${topic} ${fmtPayload(payload)}`);
      break;
    }
    case 9: { // SUBACK
      console.log(`[SUBACK] ${body.toString('hex')}`);
      break;
    }
    case 0:
    case 4:
    case 6:
    case 8:
    case 12:
    case 13:
      break;
    default:
      console.log(`[type=${type}] ${body.toString('hex').slice(0, 200)}`);
  }
});

sock.on('data', feed);
sock.on('error', (e) => { console.error('socket error:', e.message); process.exit(2); });
sock.on('close', () => { console.log('[closed]'); process.exit(0); });

if (cmd === 'sub') {
  setTimeout(() => {
    console.log(connected ? '[done]' : '[done] 未完成 MQTT 握手');
    sock.end();
  }, secs * 1000);
}
