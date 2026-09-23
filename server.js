const express = require('express');
const webpush  = require('web-push');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Node 18+ tem fetch nativo; node-fetch fica só como fallback
const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// ── VAPID Keys ───────────────────────────────────────────────
// Defina VAPID_PUBLIC / VAPID_PRIVATE nas env vars do Render (e troque o par, pois a
// privada vazou). Se trocar, atualize VAPID_PUBLIC no index.html — o app recria a subscription.
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BJrxmGfucm9YOfhnAsz43tRvqHDOwQ4Af5enWXnVWUkeoMzxFeMcGlSnvuEJAvdLPYo89N3I9roWqxXHXG3xh6U';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '225c30n3XeteBxW2RvguVhF8gc8ubJoD70A5XcGvOaA';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:monitor@eth.app';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// ── Persistência ─────────────────────────────────────────────
// O disco do Render free é apagado a cada restart/deploy → subscribers somem e o push
// para de funcionar até você abrir o app. Com UPSTASH_REDIS_REST_URL/TOKEN definidos
// (Upstash free), os dados sobrevivem. Sem eles, usa arquivo local como antes.
const DB_FILE     = path.join(__dirname, 'subscribers.json');
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY   = 'eth_subscribers';

const subscribers = {};

async function loadSubscribers() {
  try {
    if (REDIS_URL) {
      const r = await fetch(`${REDIS_URL}/get/${REDIS_KEY}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const j = await r.json();
      const data = j.result ? JSON.parse(j.result) : {};
      console.log(`[DB] Carregados ${Object.keys(data).length} subscribers do Redis`);
      return data;
    }
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      console.log(`[DB] Carregados ${Object.keys(data).length} subscribers do disco`);
      return data;
    }
  } catch (e) {
    console.error('[DB] Erro ao carregar:', e.message);
  }
  return {};
}

function saveSubscribers() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(subscribers, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Erro ao salvar em disco:', e.message);
  }
  if (REDIS_URL) {
    fetch(`${REDIS_URL}/set/${REDIS_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      body: JSON.stringify(subscribers)
    }).catch(e => console.error('[DB] Erro ao salvar no Redis:', e.message));
  }
}

// Mantém triggered=true de itens que o servidor já disparou, mesmo que o app
// (que estava fechado) ainda envie triggered=false → evita alerta duplicado
function mergeTriggered(incoming = [], previous = []) {
  return incoming.map(item => {
    const old = previous.find(p => p.id === item.id);
    if (old && old.triggered && !item.triggered) {
      return { ...item, triggered: true, triggeredDir: old.triggeredDir ?? item.triggeredDir, triggeredPrice: old.triggeredPrice ?? item.triggeredPrice };
    }
    return item;
  });
}

// ── Routes ───────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'ok',
  subscribers: Object.keys(subscribers).length,
  storage: REDIS_URL ? 'redis' : 'file',
  lastPrice,
  uptime: Math.floor(process.uptime()) + 's'
}));

app.get('/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post('/subscribe', (req, res) => {
  const { subscription, clientId, alerts, variations } = req.body;
  if (!subscription || !clientId) return res.status(400).json({ error: 'Missing fields' });
  const prev = subscribers[clientId] || {};
  subscribers[clientId] = {
    subscription,
    alerts:     mergeTriggered(alerts,     prev.alerts),
    variations: mergeTriggered(variations, prev.variations)
  };
  console.log(`[+] Subscribed: ${clientId} | Alerts: ${alerts?.length || 0} | Variations: ${variations?.length || 0}`);
  saveSubscribers();
  // Devolve o estado mesclado para o app atualizar o que já foi disparado
  res.json({ ok: true, alerts: subscribers[clientId].alerts, variations: subscribers[clientId].variations });
});

app.post('/update-alerts', (req, res) => {
  const { clientId, alerts, variations } = req.body;
  const cur = subscribers[clientId];
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (alerts)     cur.alerts     = mergeTriggered(alerts,     cur.alerts);
  if (variations) cur.variations = mergeTriggered(variations, cur.variations);
  saveSubscribers();
  res.json({ ok: true, alerts: cur.alerts, variations: cur.variations });
});

app.post('/unsubscribe', (req, res) => {
  const { clientId } = req.body;
  delete subscribers[clientId];
  saveSubscribers();
  res.json({ ok: true });
});

// ── Price Monitor ────────────────────────────────────────────
let lastPrice = null;

async function fetchETHPrice() {
  try {
    const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=brl');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data?.ethereum?.brl ?? null;
  } catch (e) {
    console.error('Price fetch error:', e.message);
    return null;
  }
}

async function sendPush(subscription, payload) {
  // urgency high ajuda o Android a entregar com o aparelho em repouso
  await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
}

// Marca como disparado no objeto atual do cliente (o array pode ter sido
// substituído por um /subscribe enquanto o push era enviado)
function markTriggered(clientId, listName, id, extra = {}) {
  const item = subscribers[clientId]?.[listName]?.find(x => x.id === id);
  if (item) Object.assign(item, { triggered: true }, extra);
}

const isGone = e => e.statusCode === 404 || e.statusCode === 410;

let checking = false;
async function checkAndNotify() {
  if (checking) return;
  checking = true;
  try {
    const price = await fetchETHPrice();
    if (!price) return;

    const prev = lastPrice;
    lastPrice  = price;
    console.log(`[ETH] R$ ${price.toLocaleString('pt-BR')} ${prev ? `(antes: R$ ${prev.toLocaleString('pt-BR')})` : '(primeiro fetch)'}`);

    for (const [clientId, data] of Object.entries(subscribers)) {

      // ── Alertas simples ──────────────────────────────────────
      for (const alert of (data.alerts || [])) {
        if (alert.triggered) continue;

        const hit =
          (alert.direction === 'above' && price >= alert.price) ||
          (alert.direction === 'below' && price <= alert.price);

        if (!hit) continue;

        const dirLabel = alert.direction === 'above' ? 'acima de' : 'abaixo de';
        const payload  = {
          title: `🚨 ETH ${alert.direction === 'above' ? '📈' : '📉'} Alerta atingido!`,
          body:  `Ethereum R$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — ${dirLabel} R$ ${alert.price.toLocaleString('pt-BR')}`,
          kind: 'alert', id: alert.id, tag: 'alert-' + alert.id,
          price, alertPrice: alert.price, direction: alert.direction, timestamp: Date.now()
        };

        try {
          await sendPush(data.subscription, payload);
          alert.triggered = true;
          markTriggered(clientId, 'alerts', alert.id);
          console.log(`[PUSH] Alerta simples → ${clientId}: ETH R$ ${price}`);
          saveSubscribers();
        } catch (e) {
          console.error(`[PUSH] Falhou (alerta) para ${clientId}:`, e.statusCode, e.body || e.message);
          if (isGone(e)) { delete subscribers[clientId]; saveSubscribers(); break; }
        }
      }

      if (!subscribers[clientId]) continue; // foi removido acima

      // ── Variações ────────────────────────────────────────────
      for (const v of (data.variations || [])) {
        if (v.triggered) continue;

        const low     = v.basePrice - v.amount;
        const high    = v.basePrice + v.amount;
        const hitUp   = price >= high;
        const hitDown = price <= low;

        if (!hitUp && !hitDown) continue;

        const dir     = hitUp ? 'acima' : 'abaixo';
        const dirIcon = hitUp ? '📈' : '📉';
        const limit   = hitUp ? high : low;
        const payload = {
          title: `🚨 ETH ${dirIcon} Faixa rompida!`,
          body:  `Ethereum R$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — saiu ${dir} da faixa (limite: R$ ${limit.toLocaleString('pt-BR')})`,
          kind: 'variation', id: v.id, tag: 'var-' + v.id,
          price, basePrice: v.basePrice, amount: v.amount, direction: hitUp ? 'above' : 'below', timestamp: Date.now()
        };

        try {
          await sendPush(data.subscription, payload);
          const extra = { triggeredDir: hitUp ? 'above' : 'below', triggeredPrice: price };
          Object.assign(v, { triggered: true }, extra);
          markTriggered(clientId, 'variations', v.id, extra);
          console.log(`[PUSH] Variação → ${clientId}: ETH R$ ${price} rompeu faixa ±${v.amount}`);
          saveSubscribers();
        } catch (e) {
          console.error(`[PUSH] Falhou (variação) para ${clientId}:`, e.statusCode, e.body || e.message);
          if (isGone(e)) { delete subscribers[clientId]; saveSubscribers(); break; }
        }
      }
    }
  } finally {
    checking = false;
  }
}

// ── Teste manual: GET /test-push/<clientId> ──────────────────
app.get('/test-push/:clientId', async (req, res) => {
  const data = subscribers[req.params.clientId];
  if (!data) return res.status(404).json({ error: 'clientId não encontrado', known: Object.keys(subscribers).length });
  try {
    await sendPush(data.subscription, { title: '✅ Teste ETH Monitor', body: 'Push funcionando!', tag: 'test' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message, statusCode: e.statusCode, body: e.body });
  }
});

// ── Self-ping para não dormir no Render free ─────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(RENDER_URL);
      console.log('[PING] Self-ping OK — servidor acordado');
    } catch (e) {
      console.warn('[PING] Self-ping falhou:', e.message);
    }
  }, 14 * 60 * 1000);
  console.log(`[PING] Self-ping ativado para ${RENDER_URL}`);
} else {
  console.log('[PING] RENDER_EXTERNAL_URL não definida — self-ping desativado');
}

// ── Start ────────────────────────────────────────────────────
(async () => {
  Object.assign(subscribers, await loadSubscribers());
  // Verifica preço a cada 2 minutos
  setInterval(checkAndNotify, 2 * 60 * 1000);
  checkAndNotify();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`ETH Monitor backend rodando na porta ${PORT}`));
})();
