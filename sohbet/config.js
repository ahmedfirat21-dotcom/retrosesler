// SpeakyChat Hazır Web Paneli 3.6.0 - yalnızca herkese açık site ayarları.
// Retro Sesler (retrosesler.com) için hazırlandı. Buraya şifre, API anahtarı veya yönetici bilgisi yazmayın.
//
// MÜŞTERİ NUMARASI: retrosesler.com adına SpeakyChat hesabı açılınca verilen KB numarasını aşağıdaki
// customerCode satırına yazın (örnek biçim: 'KB123456789'); başka hiçbir satır değişmez.
// Boş kaldıkça sohbet penceresi SpeakyChat oda SİMÜLASYONU olarak açılır (kişiler ve mesajlar örnektir),
// bu yüzden site numara girilmeden yayına alınmaz.
//
// ODALAR: name alanı odanın platformdaki KİMLİĞİDİR, düğmedeki yazı label'dır. Yeni açılan hesapta
// sohbet odaları 100'den başlayarak sırayla numaralanır (100 = "Lobby", 101 = "Room 2", 102 = "Room 3",
// 103 = "Room 4"). Numara oda adı değiştirilince de aynı kalır; odaları sohbet içindeki yönetim
// panelinden Lobi, 90'lar & 2000'ler, Slow Köşe, Gece Kuşları diye yeniden adlandırın ki sohbetin kendi
// oda listesi de düğmelerle aynı görünsün. Aşağıdaki dört düğme için paket en az 4 SOHBET odası
// içermeli: toplantı odasız pakette oda sayısı 4, toplantılı pakette 5. Paket daha küçükse fazla satırı silin.
//
// LOGO: göreli yol (sohbet/ klasörünün bir üstündeki logo.svg). Site kökte de alt klasörde de
// yayınlansa doğru dosyayı bulur.
window.SpeakyPanelConfig = {
    customerCode: '',
    siteName: 'Retro Sesler',
    welcome: 'Eski usul sohbet odası: sesli, görüntülü, yazılı. Misafir girişi serbest.',
    logo: '../logo.svg',
    roomTitle: 'Odalar',
    roomLayout: 'grid',
    roomColumns: 4,
    roomAlign: 'center',
    roomSize: 'medium',
    roomPosition: 'top',
    theme: 'klasik',
    // Sayfa zemini: sitenin masaüstü rengi (panelin varsayılan leylak-mavi degradesi yerine).
    pageColor: '#66727f',
    headColor: '',
    accentColor: '',
    rooms: [
        { name: '100', label: 'Lobi', color: '#505f72', shape: 'square' },
        { name: '101', label: "90'lar & 2000'ler", color: '#354b88', shape: 'square' },
        { name: '102', label: 'Slow Köşe', color: '#8b7ab5', shape: 'square' },
        { name: '103', label: 'Gece Kuşları', color: '#0a246a', shape: 'square' }
    ]
};
