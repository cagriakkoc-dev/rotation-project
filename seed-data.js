// Claude artifact'ından "Dışa Aktar" ile aldığınız portföy JSON'unu Upstash Redis'e yükler.
//
// Kullanım:
// 1. Uygulamada Kurulum sekmesi -> "JSON'u Göster" -> "Panoya Kopyala".
// 2. Kopyaladığınız metni aşağıdaki EXPORTED_JSON değişkenine yapıştırın
//    (backtick'ler arasına, olduğu gibi).
// 3. Terminalde:
//    UPSTASH_REDIS_REST_URL="https://xxxxx.upstash.io" \
//    UPSTASH_REDIS_REST_TOKEN="xxxxxxxxxx" \
//    node seed-data.js

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('UPSTASH_REDIS_REST_URL ve UPSTASH_REDIS_REST_TOKEN ortam değişkenlerini tanımlayın.');
  process.exit(1);
}

// ↓↓↓ Buraya, uygulamadan kopyaladığınız TAM JSON'u yapıştırın ↓↓↓
const EXPORTED_JSON = `
{
  "initialized": true,
  "cash": 0,
  "positions": {},
  "lastPrices": {}
}
`;
// ↑↑↑ Yukarıdaki örnek/boş veriyi kendi kopyaladığınız JSON ile değiştirin ↑↑↑

let state;
try {
  state = JSON.parse(EXPORTED_JSON);
} catch (e) {
  console.error('JSON ayrıştırılamadı. EXPORTED_JSON değişkenine tam ve geçerli JSON yapıştırdığınızdan emin olun.');
  console.error(e.message);
  process.exit(1);
}

if (!state.initialized || !state.positions || Object.keys(state.positions).length === 0) {
  console.error('Bu JSON boş/örnek görünüyor. Uygulamadan gerçek "Dışa Aktar" verinizi yapıştırdığınızdan emin olun.');
  process.exit(1);
}

async function main() {
  const url = UPSTASH_URL + '/set/' + encodeURIComponent('rotasyon:state') + '/' + encodeURIComponent(JSON.stringify(state));
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN } });
  if (!res.ok) {
    console.error('Yükleme başarısız:', res.status, await res.text());
    process.exit(1);
  }
  const stockValue = Object.keys(state.positions).reduce((s, t) => s + state.positions[t] * (state.lastPrices[t] || 0), 0);
  const totalValue = state.cash + stockValue;
  console.log('✓ Portföy verisi Upstash\'e yüklendi. Toplam varlık: ' + totalValue.toFixed(2) + ' TL');
  console.log('  Kuruluş tarihi: ' + (state.history && state.history[0] ? state.history[0].date : '—'));
  console.log('  Rotasyon kaydı sayısı: ' + (state.history ? state.history.length : 0));
}
main();
