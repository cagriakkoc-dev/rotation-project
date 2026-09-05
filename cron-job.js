// Günlük Otomasyon Görevi
// - Her gün 18:30 (Türkiye saati): Google Sheets üzerinden 6 hissenin fiyatını çeker,
//   "Günlük Takip" kaydı gibi state.dailyLog'a ekler.
// - Cuma günleri 18:30: aynı fiyatlarla TAM ROTASYONU (satış/alım, T+2 takas kaydı,
//   PPF stopajı, maliyet bazı güncellemesi) otomatik uygular.
//
// Bu script, arayüzdeki (public/index.html) mantıkla BİREBİR AYNI formülleri kullanır —
// tutarlılık için formül değişikliği yaparsanız iki yerde de güncelleyin.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const GOOGLE_SHEET_CSV_URL = process.env.GOOGLE_SHEET_CSV_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Telegram bildirimi gönderir. Token/chat_id tanımlı değilse sessizce atlar
// (bildirim opsiyonel bir özellik, olmadan da görev normal çalışmaya devam eder).
// Bildirim gönderimi başarısız olursa görevin kendisini DURDURMAZ, sadece loglar.
async function sendTelegramNotification(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram bildirimi ATLANDI: TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID tanımlı değil.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.warn('Telegram bildirimi gönderilemedi:', res.status, await res.text());
    } else {
      console.log('✓ Telegram bildirimi gönderildi.');
    }
  } catch (e) {
    console.warn('Telegram bildirimi gönderilemedi:', e.message);
  }
}

function fmtTL(n) {
  return (n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
}

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tanımlı değil.');
  process.exit(1);
}
if (!GOOGLE_SHEET_CSV_URL) {
  console.error('GOOGLE_SHEET_CSV_URL tanımlı değil (Google Sheets "Web\'de Yayınla" CSV bağlantısı).');
  process.exit(1);
}

const TICKERS = ['ASELS', 'THYAO', 'EREGL', 'GARAN', 'BIMAS', 'CRDFA'];
const STOPAJ_ORANI = 0.175;
const STORAGE_KEY = 'rotasyon:state';

// ---------- Upstash yardımcıları ----------
async function upstashGet(key) {
  const url = UPSTASH_URL + '/get/' + encodeURIComponent(key);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN } });
  if (!res.ok) throw new Error('Upstash GET hatası: ' + res.status);
  const data = await res.json();
  return data.result;
}
async function upstashSet(key, value) {
  const url = UPSTASH_URL + '/set/' + encodeURIComponent(key) + '/' + encodeURIComponent(value);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN } });
  if (!res.ok) throw new Error('Upstash SET hatası: ' + res.status);
}

// ---------- Google Sheets CSV'den fiyat çekme ----------
async function fetchPricesFromGoogleSheet() {
  const res = await fetch(GOOGLE_SHEET_CSV_URL);
  if (!res.ok) throw new Error('Google Sheet CSV çekilemedi: ' + res.status);
  const csv = await res.text();
  const prices = {};
  csv.split('\n').forEach(line => {
    const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const ticker = parts[0];
    const price = parseFloat(parts[1]);
    if (TICKERS.includes(ticker) && !isNaN(price) && price > 0) {
      prices[ticker] = price;
    }
  });
  const missing = TICKERS.filter(t => !prices[t]);
  if (missing.length > 0) {
    throw new Error('Şu hisselerin fiyatı Google Sheet\'ten alınamadı: ' + missing.join(', '));
  }
  return prices;
}

// ---------- Arayüzle BİREBİR AYNI finansal mantık ----------
function addBusinessDays(dateStr, n) {
  let d = new Date(dateStr + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function pendingSettlementAmount(dStr, settlements) {
  return (settlements || []).reduce((sum, s) => (dStr <= s.availableFrom ? sum + s.amount : sum), 0);
}

function accrueCashInterest(state) {
  if (!state.cashAnnualYieldPct || state.cashAnnualYieldPct <= 0) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const last = state.lastInterestDate || today;
  const daysElapsed = Math.round((new Date(today) - new Date(last)) / 86400000);
  if (daysElapsed <= 0) return 0;
  const dailyRate = Math.pow(1 + state.cashAnnualYieldPct / 100, 1 / 30) - 1;
  const before = state.cash;
  if (!state.dailyCashSnapshots) state.dailyCashSnapshots = {};
  if (!state.dailyInterestOnly) state.dailyInterestOnly = {};
  if (!state.cashSettlements) state.cashSettlements = [];
  let cursor = new Date(last + 'T00:00:00Z');
  for (let i = 0; i < daysElapsed; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dStr = cursor.toISOString().slice(0, 10);
    const pending = pendingSettlementAmount(dStr, state.cashSettlements);
    const eligible = Math.max(0, state.cash - pending);
    const interestPortion = eligible * dailyRate;
    state.cash += interestPortion;
    state.dailyCashSnapshots[dStr] = state.cash;
    state.dailyInterestOnly[dStr] = interestPortion;
  }
  state.cashInterestEarned = (state.cashInterestEarned || 0) + (state.cash - before);
  state.lastInterestDate = today;
  return state.cash - before;
}

function applyDailySave(state, prices, dateStr) {
  const stockValNow = TICKERS.reduce((s, t) => s + state.positions[t] * prices[t], 0);
  const totalNow = state.cash + stockValNow;
  state.dailyPrices = Object.assign({}, prices);
  if (!state.dailyLog) state.dailyLog = [];
  const now = new Date();
  const trHours = String((now.getUTCHours() + 3) % 24).padStart(2, '0');
  const trMinutes = String(now.getUTCMinutes()).padStart(2, '0');
  const label = dateStr + ' ' + trHours + ':' + trMinutes;
  state.dailyLog.push({
    date: label,
    totalValue: totalNow,
    cash: state.cash,
    stockValue: stockValNow,
    prices: Object.assign({}, prices),
  });
  return totalNow;
}

function applyRotation(state, prices, dateStr) {
  let cash = state.cash;
  const positions = Object.assign({}, state.positions);
  const txByTicker = {};
  const sellList = [], buyList = [];
  let costBasis = state.cashCostBasis !== undefined ? state.cashCostBasis : state.cash;
  let totalStopajPaid = 0;
  const posCostBasis = Object.assign({}, state.positionCostBasis);
  let realizedPnL = state.realizedPnL || 0;

  TICKERS.forEach(t => {
    const price = prices[t];
    const qty = positions[t];
    const targetQty = Math.floor(state.targetPerStock / price);
    if (targetQty < qty) sellList.push({ t, targetQty, price });
    else if (targetQty > qty) buyList.push({ t, targetQty, price });
    else txByTicker[t] = { ticker: t, action: 'YOK', qty: 0, price, amount: 0, note: 'Zaten hedefte' };
  });

  // 1) Tüm satışlar
  sellList.forEach(({ t, targetQty, price }) => {
    const qty = positions[t];
    const sellQty = qty - targetQty;
    const proceeds = sellQty * price;
    cash += proceeds;
    costBasis += proceeds;
    const avgCost = posCostBasis[t] !== undefined ? posCostBasis[t] : price;
    realizedPnL += (price - avgCost) * sellQty;
    positions[t] = targetQty;
    txByTicker[t] = { ticker: t, action: 'SAT', qty: sellQty, price, amount: proceeds, realized: (price - avgCost) * sellQty };
  });

  // 2) Tüm alımlar (stopaj dahil)
  buyList.forEach(({ t, targetQty, price }) => {
    const qty = positions[t];
    const needQty = targetQty - qty;
    const cost = needQty * price;
    const gainRatio = cash > 0 ? Math.max(0, (cash - costBasis) / cash) : 0;
    const stopaj = cost * gainRatio * STOPAJ_ORANI;
    if (cash >= cost + stopaj) {
      cash -= (cost + stopaj);
      costBasis -= cost * (1 - gainRatio);
      totalStopajPaid += stopaj;
      const oldQty = qty, newQty = targetQty;
      const oldAvg = posCostBasis[t] !== undefined ? posCostBasis[t] : price;
      posCostBasis[t] = newQty > 0 ? (oldQty * oldAvg + needQty * price) / newQty : price;
      positions[t] = targetQty;
      txByTicker[t] = { ticker: t, action: 'AL', qty: needQty, price, amount: cost, stopaj };
    } else {
      const affordable = Math.floor(cash / (price * (1 + gainRatio * STOPAJ_ORANI)));
      if (affordable > 0) {
        const affordableCost = affordable * price;
        const affordableStopaj = affordableCost * gainRatio * STOPAJ_ORANI;
        cash -= (affordableCost + affordableStopaj);
        costBasis -= affordableCost * (1 - gainRatio);
        totalStopajPaid += affordableStopaj;
        const oldQty = qty, newQty = qty + affordable;
        const oldAvg = posCostBasis[t] !== undefined ? posCostBasis[t] : price;
        posCostBasis[t] = newQty > 0 ? (oldQty * oldAvg + affordable * price) / newQty : price;
        positions[t] = qty + affordable;
        txByTicker[t] = { ticker: t, action: 'AL', qty: affordable, price, amount: affordableCost, stopaj: affordableStopaj, note: 'Nakit yetersiz, kısmi alım (stopaj dahil)' };
      } else {
        txByTicker[t] = { ticker: t, action: 'YOK', qty: 0, price, amount: 0, note: 'Nakit yetersiz' };
      }
    }
  });

  const transactions = TICKERS.map(t => txByTicker[t]);

  // T+2 takas kaydı
  const totalSatProceeds = transactions.filter(tx => tx.action === 'SAT').reduce((s, tx) => s + tx.amount, 0);
  if (totalSatProceeds > 0) {
    if (!state.cashSettlements) state.cashSettlements = [];
    state.cashSettlements.push({ rotationDate: dateStr, amount: totalSatProceeds, availableFrom: addBusinessDays(dateStr, 2) });
  }

  const totalValue = cash + TICKERS.reduce((s, t) => s + positions[t] * prices[t], 0);

  state.cash = cash;
  state.cashCostBasis = costBasis;
  state.totalStopajPaid = (state.totalStopajPaid || 0) + totalStopajPaid;
  state.positionCostBasis = posCostBasis;
  state.realizedPnL = realizedPnL;
  state.positions = positions;
  state.lastPrices = prices;
  state.dailyPrices = Object.assign({}, prices);
  state.history.push({
    date: dateStr,
    totalValue,
    cash,
    positions: Object.fromEntries(TICKERS.map(t => [t, { price: prices[t], qty: positions[t], value: positions[t] * prices[t] }])),
    transactions,
  });

  return { totalValue, transactions, totalStopajPaid };
}

// ---------- Ana akış ----------
async function main() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dow = today.getUTCDay(); // 5 = Cuma (cron zaten 18:06 TR saatinde tetiklendiği için ek TZ dönüşümü gerekmiyor)
  const isFriday = dow === 5;

  console.log('Görev başladı:', todayStr, isFriday ? '(CUMA — rotasyon uygulanacak)' : '(hafta içi — günlük kayıt)');

  const raw = await upstashGet(STORAGE_KEY);
  if (!raw) {
    console.error('Upstash\'te kayıtlı portföy verisi bulunamadı, görev iptal edildi.');
    process.exit(1);
  }
  const state = JSON.parse(raw);
  if (!state.initialized) {
    console.error('Portföy henüz kurulmamış, görev iptal edildi.');
    process.exit(1);
  }

  const prices = await fetchPricesFromGoogleSheet();
  console.log('Çekilen fiyatlar:', prices);

  accrueCashInterest(state);

  if (isFriday) {
    // Rotasyon öncesi durumu kaydet — böylece web arayüzündeki "Rotasyonu Geri Al"
    // butonu, cron tarafından uygulanan bu rotasyonu da doğru şekilde geri alabilir.
    state.undoSnapshot = JSON.parse(JSON.stringify({
      cash: state.cash,
      cashCostBasis: state.cashCostBasis !== undefined ? state.cashCostBasis : state.cash,
      totalStopajPaid: state.totalStopajPaid || 0,
      positions: state.positions,
      positionCostBasis: state.positionCostBasis || {},
      realizedPnL: state.realizedPnL || 0,
      lastPrices: state.lastPrices,
      dailyPrices: state.dailyPrices,
      history: state.history,
      cashSettlements: state.cashSettlements || [],
    }));

    const result = applyRotation(state, prices, todayStr);
    console.log('Rotasyon uygulandı. Yeni toplam varlık:', result.totalValue.toFixed(2), '₺');
    console.log('İşlemler:', JSON.stringify(result.transactions, null, 2));
    if (result.totalStopajPaid > 0) {
      console.log('Kesilen stopaj:', result.totalStopajPaid.toFixed(2), '₺');
    }
    // Rotasyon sonrası "Bu Tarihi Kaydet" ile aynı dailyLog kaydını da ekle —
    // yoksa Pozisyonlar / Günlük Seyir grafikleri (sadece dailyLog okur) Cuma
    // günü için boşluk gösterir.
    applyDailySave(state, prices, todayStr);
    console.log('Günlük Seyir/Pozisyonlar grafikleri için dailyLog kaydı da eklendi.');

    const txLines = result.transactions
      .filter(tx => tx.action !== 'YOK')
      .map(tx => `• <b>${tx.ticker}</b>: ${tx.action} ${tx.qty} adet @${tx.price.toFixed(2)}`)
      .join('\n');
    await sendTelegramNotification(
      `✅ <b>${todayStr} rotasyonu uygulandı</b>\n\n` +
      (txLines || 'Hiçbir hisse hedef bandın dışına çıkmadı, işlem yapılmadı.') +
      `\n\nYeni toplam varlık: <b>${fmtTL(result.totalValue)}</b>` +
      (result.totalStopajPaid > 0 ? `\nKesilen stopaj: ${fmtTL(result.totalStopajPaid)}` : '')
    );
  } else {
    const totalNow = applyDailySave(state, prices, todayStr);
    console.log('Günlük kayıt eklendi. Anlık toplam varlık:', totalNow.toFixed(2), '₺');
    await sendTelegramNotification(
      `📊 <b>${todayStr} günlük kayıt eklendi</b>\n\nToplam varlık: <b>${fmtTL(totalNow)}</b>`
    );
  }

  await upstashSet(STORAGE_KEY, JSON.stringify(state));
  console.log('✓ Görev tamamlandı, veri Upstash\'e kaydedildi.');
}

main().catch(async err => {
  console.error('HATA:', err.message);
  await sendTelegramNotification(`⚠️ <b>Görev başarısız oldu</b>\n\n${err.message}`);
  process.exit(1);
});
