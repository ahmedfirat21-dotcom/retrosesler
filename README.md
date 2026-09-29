# Retro Sesler - retrosesler.com

retrosesler.com'un dosyaları: SpeakyChat **Hazır Web Paneli** (sürüm 3.6.0) ile kurulmuş bir
sohbet sitesi. Statik site: veritabanı, PHP, MySQL gerekmez.

## Klasör

| Dosya | Ne |
|---|---|
| `index.html`, `retro.css` | Giriş sayfası ("Retro Sesler" penceresi). Dış kütüphane ve yazı tipi dosyası yok. |
| `logo.svg` | Logo: elle çizilmiş piksel kaset (32 x 22 piksellik ızgara, 2 kat büyütülmüş, şeffaf zemin). Panel de bunu kullanıyor. |
| `logo.png` | Aynı logonun 128 x 88 PNG'si (paylaşım önizlemesi `og:image`, PNG isteyen yerler). |
| `favicon.svg` | 16 x 16 küçük kaset (giriş sayfasının sekme simgesi). |
| `favicon.ico` | Aynı kasetin 16 ve 32 piksellik ICO'su. Paket sayfası (`/sohbet/`) simge bağlantısı içermiyor; tarayıcı kökteki `/favicon.ico`'yu kullanır. |
| `sohbet/` | Hazır Web Paneli paketi, speakychat.cam/indirmeler'deki 3.6.0 ZIP'inden değiştirilmeden alındı. |
| `sohbet/config.js` | Paketteki TEK düzenlenen dosya: site adı, karşılama yazısı, logo, odalar, müşteri numarası. |

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
2. `public_html` içine şunlar yüklenir: `index.html`, `retro.css`, `logo.svg`, `logo.png`,
   `favicon.svg`, `favicon.ico` ve `sohbet/` klasörünün tamamı (`images/` dahil). `README.md` ve `.git`
   yüklenmez.
3. SSL açılır (cPanel › SSL/TLS Status › AutoSSL) ve sertifika çıktıktan sonra
   **http → https yönlendirmesi** açılır: cPanel › Domains › retrosesler.com › *Force HTTPS
   Redirect*. Sohbet http:// ile açılan sayfada hiç açılmaz ("Sohbet yalnız https:// ile
   açılan sayfalarda çalışır"); WhatsApp gibi uygulamalar çıplak alan adını çoğu zaman
   http:// bağlantısına çeviriyor. Giriş sayfası retrosesler.com'da kendisi de https'e geçer,
   ama doğrudan paylaşılan `/sohbet/` bağlantısını yalnız sunucu yönlendirmesi kurtarır.
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

- Ayarlar › Pages › **Enforce HTTPS** işaretlenir (aynı http sorunu).
- Pages depo kökünü olduğu gibi yayınlar; bu README de `/README.md` adresinden görünür.
- Site bir alt yolda (`kullanici.github.io/retrosesler/`) da çalışır: bütün bağlantılar ve
  panelin logosu (`../logo.svg`) göreli.

## Paket güncellenince

Yeni sürüm çıktığında speakychat.cam/indirmeler'den yeni ZIP indirilir ve `sohbet/`
klasöründe **`config.js` DIŞINDAKİ** bütün dosyalar yenileriyle değiştirilir. `config.js`'e
dokunulmaz. Yeni sürüm `config.js`'e yeni bir alan getirdiyse KURULUM.txt ve Panel
Tasarımcısı bunu söyler; o zaman yalnız o alan eklenir.

Giriş sayfası (`index.html`, `retro.css`, logolar) paketten bağımsızdır; paket güncellemesi
onlara dokunmaz.

## Bilinen

- Sohbet her zaman hesabın ilk girilecek odasında açılır (yeni hesapta listenin başı: Lobi).
  Paket adresten oda okumuyor; bu yüzden giriş sayfasındaki oda listesi bilgi amaçlı, satırlar
  bağlantı değil. Odalar arasında sohbet sayfasının üstündeki düğmelerle geçilir.
- Panel sayfasında (`/sohbet/`) giriş sayfasına dönen bir bağlantı yok: paketin böyle bir
  ayarı yok ve paket dosyaları değiştirilmiyor. Ziyaretçi tarayıcının geri tuşuyla döner.
- Yerelde denerken sayfayı `localhost` / `127.0.0.1` adıyla açmayın: panel o adlarda
  simülasyonu sitenin kendisinden ister (speakychat.cam'in yerel kopyası varsayılır) ve
  sohbet penceresi "yükleniyor" halkasında kalır. Bir ad bağlayarak açın, örneğin Edge'de
  `--host-resolver-rules="MAP retrosesler.test 127.0.0.1"` ile `http://retrosesler.test:<port>/`;
  o zaman simülasyon gerçek sitedeki gibi speakychat.cam'den gelir. (Giriş sayfasının https
  geçişi yalnız retrosesler.com adında çalışır, yerel denemeyi etkilemez.)

## Metin kuralları

Kullanıcı sayısı, kuruluş yılı, adres, telefon ya da şirket unvanı yazılmaz. İletişim
gerekirse yalnız `destek@speakychat.cam`. Altta "SpeakyChat altyapısıyla" bağlantısı
(https://speakychat.cam) duruyor.
