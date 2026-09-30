# Retro Sesler - retrosesler.com

retrosesler.com'un dosyaları: SpeakyChat **Hazır Web Paneli** (sürüm 3.6.0) ile kurulmuş bir
sohbet sitesi. Statik site: veritabanı, PHP, MySQL gerekmez. GitHub Pages'te yayında
(depo kökü, `main` dalı; `CNAME` = retrosesler.com).

**30 Eylül 2026'dan beri ANA SAYFA DOĞRUDAN SOHBET PANELİ** (Fırat: "ana sayfa direk sesli
odaların olduğu olsun"). Eskiden kökte ayrı bir giriş sayfası (`retro.css`) vardı, panel
`/sohbet/` altındaydı; panel köke taşındı, `/sohbet/` ana sayfaya yönleniyor (paylaşılmış
eski bağlantılar bozulmasın).

## Klasör

| Dosya | Ne |
|---|---|
| `index.html` | Sohbet paneli (paketin `index.html`'i) + sitenin başlığı, paylaşım bilgileri (og:) ve http→https geçişi. |
| `config.js` | Paketteki TEK düzenlenen dosya: site adı, karşılama yazısı, logo, odalar, müşteri numarası. |
| `panel.css`, `panel.js`, `speakychat.js`, `site-i18n.*`, `site-translations.js`, `speakychat-logo.png`, `images/` | Hazır Web Paneli paketi, speakychat.cam/indirmeler'deki 3.6.0 ZIP'inden değiştirilmeden. |
| `logo.svg` | Logo: elle çizilmiş piksel kaset (32 x 22 piksellik ızgara, 2 kat büyütülmüş, şeffaf zemin). Panel bunu kullanıyor. |
| `logo.png` | Aynı logonun 128 x 88 PNG'si (paylaşım önizlemesi `og:image`). |
| `favicon.svg`, `favicon.ico` | Sekme simgesi (16 x 16 kaset). |
| `sohbet/index.html` | Eski adres: ana sayfaya yönlendirme. `sohbet/KURULUM.*` paketin kurulum notu (bilgi). |

## Müşteri numarası (tek satır)

`sohbet/config.js` içinde `customerCode: ''` şimdilik boş. Boşken sohbet penceresi SpeakyChat
oda **simülasyonu** olarak açılır: üstte site sahibine yazılmış "Şablon görünümü" notu çıkar,
içerideki kişiler ve mesajlar örnektir. Bu hâliyle ziyaretçiye açılmaz.

1. retrosesler.com adına SpeakyChat müşteri hesabı açılır (alan adı `retrosesler.com`;
   `www.retrosesler.com` karşılığı kendiliğinden geçerli). Sayfadaki dört oda düğmesi için
   paket en az **4 sohbet odası** içermeli: toplantı odasız pakette oda sayısı 4, toplantılı
   pakette 5.
2. Verilen `KB` ile başlayan numara `customerCode: 'KB.........'` satırına yazılır. Başka satır
   değişmez.
3. Sohbete yönetici (admin) hesabıyla girilip odalar yeniden adlandırılır:
   `100` Lobby → **Lobi**, `101` Room 2 → **90'lar & 2000'ler**, `102` Room 3 → **Slow Köşe**,
   `103` Room 4 → **Gece Kuşları**. Düğmeler odayı numarasından bulur (`rooms[].name` odanın
   platformdaki kimliği); adı değiştirmek düğmeleri bozmaz, yalnız sohbetin kendi oda
   listesi de düğmelerle aynı görünür.

Görünüm sonradan sohbetin içindeki **Panel Ayarları**'ndan da değiştirilebilir; oraya
kaydedilen ayarlar `config.js`'in görünüm ayarlarının üzerine yazılır (müşteri numarası her
zaman `config.js`'ten gelir).

## Yayına alma (cPanel)

1. **Önce `customerCode` doldurulur.** KB numarası girilmeden `public_html`'e yüklenmez ve
   speakychat.cam/indirmeler'e örnek site olarak eklenmez. Numara gelmeden önizleme
   gerekirse site parola korumalı bir alt klasörde tutulur (cPanel › Directory Privacy).
2. `public_html` içine depodaki her şey yüklenir (`images/` ve `sohbet/` dahil); `README.md` ve
   `.git` yüklenmez.
3. SSL açılır (cPanel › SSL/TLS Status › AutoSSL) ve sertifika çıktıktan sonra
   **http → https yönlendirmesi** açılır: cPanel › Domains › retrosesler.com › *Force HTTPS
   Redirect*. Sohbet http:// ile açılan sayfada hiç açılmaz ("Sohbet yalnız https:// ile
   açılan sayfalarda çalışır"); WhatsApp gibi uygulamalar çıplak alan adını çoğu zaman
   http:// bağlantısına çeviriyor. Ana sayfa retrosesler.com'da kendisi de https'e geçer,
   ama başka bir yolla paylaşılan bağlantıyı yalnız sunucu yönlendirmesi kurtarır.
   cPanel'de o düğme yoksa `public_html/.htaccess` dosyasının başına şu eklenir:

   ```apache
   RewriteEngine On
   RewriteCond %{HTTPS} off
   RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
   ```

4. `config.js` değiştirildikten sonra tarayıcıda Ctrl+F5 ile yenilenir: panel dosyayı
   `config.js?v=3.6.0` adıyla istiyor, adres değişmediği için tarayıcı eskisini önbellekten
   verebilir.

### GitHub Pages ile yayınlanırsa

- Ayarlar › Pages › **Enforce HTTPS** işaretlenir (aynı http sorunu). 30 Eylül 2026: GitHub
  retrosesler.com için sertifika hiç çıkarmamıştı (sayfa *.github.io sertifikasıyla geliyor,
  tarayıcı https'i reddediyordu). Özel alan adı Pages ayarından boşaltılıp yeniden yazılınca
  sertifika yeniden istendi; çıkınca Enforce HTTPS açıldı.
- Pages depo kökünü olduğu gibi yayınlar; bu README de `/README.md` adresinden görünür.
- Bütün bağlantılar ve panelin logosu (`logo.svg`) göreli.

## Paket güncellenince

Yeni sürüm çıktığında speakychat.cam/indirmeler'den yeni ZIP indirilir ve paketin dosyaları
(kökteki panel dosyaları) **`config.js` DIŞINDA** yenileriyle değiştirilir; ZIP'in `index.html`'i
alınırsa başındaki başlık, og: satırları ve https geçişi yeniden eklenir. `config.js`'e
dokunulmaz. Yeni sürüm `config.js`'e yeni bir alan getirdiyse KURULUM.txt ve Panel
Tasarımcısı bunu söyler; o zaman yalnız o alan eklenir.

Logolar ve favicon paketten bağımsızdır; paket güncellemesi onlara dokunmaz.

## Bilinen

- Sohbet her zaman hesabın ilk girilecek odasında açılır (yeni hesapta listenin başı: Lobi).
  Odalar arasında sayfanın üstündeki düğmelerle geçilir.
- Yerelde denerken sayfayı `localhost` / `127.0.0.1` adıyla açmayın: panel o adlarda
  simülasyonu sitenin kendisinden ister (speakychat.cam'in yerel kopyası varsayılır) ve
  sohbet penceresi "yükleniyor" halkasında kalır. Bir ad bağlayarak açın, örneğin Edge'de
  `--host-resolver-rules="MAP retrosesler.test 127.0.0.1"` ile `http://retrosesler.test:<port>/`;
  o zaman simülasyon gerçek sitedeki gibi speakychat.cam'den gelir. (Ana sayfanın https
  geçişi yalnız retrosesler.com adında çalışır, yerel denemeyi etkilemez.)

## Metin kuralları

Kullanıcı sayısı, kuruluş yılı, adres, telefon ya da şirket unvanı yazılmaz. İletişim
gerekirse yalnız `destek@speakychat.cam`. Altta "SpeakyChat altyapısıyla" bağlantısı
(https://speakychat.cam) duruyor.
