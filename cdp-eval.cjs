// 屏外 CDP 取值：node cdp-eval.cjs "<表达式>"
const PORT = process.env.MECHREVO_TEST_PORT || '9411';

(async () => {
  const expr = process.argv.slice(2).join(' ');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === 'page');
  if (!page) { console.error('no page'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true },
  }));
  const msg = await new Promise((r) => {
    ws.addEventListener('message', (e) => { const d = JSON.parse(e.data); if (d.id === 1) r(d); });
  });
  const out = msg.result;
  if (out.exceptionDetails) console.log('EXCEPTION:', JSON.stringify(out.exceptionDetails.exception, null, 2));
  else console.log(JSON.stringify(out.result.value, null, 2));
  ws.close();
  process.exit(0);
})();
