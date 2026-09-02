# Rotasyon Defteri — Web Sürümü

Bu, artık Claude'un `window.storage`'ına değil, kendi Upstash Redis veritabanınıza
bağlanan bağımsız bir web uygulaması. Hangi cihazdan/tarayıcıdan girerseniz girin
aynı veriye ulaşırsınız — Claude mobil uygulamasındaki depolama sorunundan bağımsız.

## 1. Upstash Redis hesabı açın (ücretsiz)

1. https://console.upstash.com adresine gidin, ücretsiz hesap açın.
2. "Create Database" → isim verin (örn. `rotasyon-db`) → **Region** olarak size yakın
   bir bölge seçin (örn. Frankfurt) → oluşturun.
3. Veritabanı detay sayfasında **REST API** bölümünde şu iki değeri kopyalayın:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

Ücretsiz katman günlük 10.000 komuta kadar izin veriyor — bu uygulama için fazlasıyla yeterli.

## 2. GitHub'a yükleyin

Bu klasörü bir GitHub reposuna push edin (Render, GitHub üzerinden otomatik deploy ediyor).

```bash
cd rotasyon-web
git init
git add .
git commit -m "İlk sürüm"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADINIZ/rotasyon-defteri.git
git push -u origin main
```

## 3. Render'da deploy edin

1. https://render.com adresinde ücretsiz hesap açın (yoksa).
2. **New +** → **Web Service** → GitHub reponuzu bağlayın.
3. Render, `render.yaml` dosyasını otomatik algılar. Algılamazsa manuel ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. **Environment** sekmesinden şu değişkenleri girin:
   - `UPSTASH_REDIS_REST_URL` → Upstash'ten kopyaladığınız URL
   - `UPSTASH_REDIS_REST_TOKEN` → Upstash'ten kopyaladığınız token
   - `APP_USERNAME` → istediğiniz bir kullanıcı adı (örn. `admin`)
   - `APP_PASSWORD` → güçlü bir parola (bu, uygulamanızı halka açık internette
     koruyan tek şey — mutlaka güçlü bir şey seçin)
5. **Create Web Service**'e basın. İlk deploy birkaç dakika sürer.
6. Deploy bitince Render size `https://rotasyon-defteri-xxxx.onrender.com` gibi bir
   adres verir. O adrese girdiğinizde tarayıcı kullanıcı adı/parola soracak
   (APP_USERNAME / APP_PASSWORD).

**Not (ücretsiz katman):** Render'ın ücretsiz web servisleri 15 dakika hareketsizlik
sonrası "uyur", bir sonraki istekte ~30-50 saniye içinde uyanır. Haftalık/günlük
kullanım için sorun teşkil etmez, sadece ilk açılışta kısa bir bekleme olabilir.

## 4. Mevcut portföy verinizi yükleyin (opsiyonel, tek seferlik)

Eğer sıfırdan değil, mevcut 31 Temmuz kurulu portföyünüzle başlamak istiyorsanız:

1. `seed-data.js` dosyasını açın, içindeki rakamları **kendi gerçek verinizle**
   karşılaştırıp gerekirse düzeltin (lot sayıları, fiyatlar, PPF oranı vb.).
2. Yerel bilgisayarınızda (Node.js kurulu olmalı):
   ```bash
   cd rotasyon-web
   npm install
   UPSTASH_REDIS_REST_URL="https://xxxxx.upstash.io" \
   UPSTASH_REDIS_REST_TOKEN="xxxxxxxxxx" \
   node seed-data.js
   ```
3. Script "✓ Portföy verisi Upstash'e yüklendi" derse, Render'daki adresinizi
   açtığınızda doğrudan Panel ekranıyla karşılaşırsınız.

Bunu yapmazsanız, uygulama ilk açıldığında normal Kurulum ekranını gösterir,
sıfırdan kurabilirsiniz.

## 5. Yerelde test etmek isterseniz

```bash
cd rotasyon-web
npm install
cp .env.example .env   # sonra .env içini kendi Upstash bilgilerinizle doldurun
# .env dosyasını okumak için basit bir yöntem:
export $(cat .env | xargs)
npm start
```

Tarayıcıda `http://localhost:3000` adresini açın.

## Dosya yapısı

```
rotasyon-web/
├── server.js          # Express backend (statik sunum + /api/storage uçları)
├── package.json
├── seed-data.js        # Mevcut portföyü tek seferlik yüklemek için
├── render.yaml          # Render deploy yapılandırması
├── .env.example
└── public/
    └── index.html      # Uygulamanın tamamı (arayüz + hesaplama mantığı)
```

## Sırada ne var

Bu temel oturduktan sonra üzerine ekleyebileceklerimiz:
- Cuma 18:01 otomatik fiyat çekme + Telegram bildirimi (Render Cron Job)
- iOS TestFlight sarmalayıcısı (Capacitor ile, aynı backend'e bağlanır)
