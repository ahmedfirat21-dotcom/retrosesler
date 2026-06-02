const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEED_FILE = path.join(DATA_DIR, 'timeline_seed.json');

// Real decade-specific databases for high-fidelity generation
const musicDatabase = {
    // 60s
    sixties: [
        { song: "Dağlar Dağlar", artist: "Barış Manço", year: 1969 },
        { song: "Niksarın Fidanları", artist: "Cem Karaca", year: 1969 },
        { song: "Resimdeki Gözyaşları", artist: "Cem Karaca", year: 1968 },
        { song: "Anadolu Yumruğu", artist: "Moğollar", year: 1968 },
        { song: "İki Yabancı", artist: "Ajda Pekkan", year: 1967 },
        { song: "Gökyüzü", artist: "Zeki Müren", year: 1966 },
        { song: "Kızılcıklar Oldu mu", artist: "Barış Manço", year: 1966 },
        { song: "Ağlama Duvarı", artist: "Erkin Koray", year: 1967 },
        { song: "Aşk Oyunu", artist: "Ajda Pekkan", year: 1968 },
        { song: "Kahverengi Gözlerin", artist: "Zeki Müren", year: 1965 },
        { song: "Yalnızlar Rıhtımı", artist: "Alpay", year: 1969 },
        { song: "Samanyolu", artist: "Berkant", year: 1967 },
        { song: "Buruk Acı", artist: "Adnan Şenses", year: 1969 },
        { song: "Her Yerde Kar Var", artist: "Salvatore Adamo / Fecri Ebcioğlu", year: 1965 },
        { song: "Deniz Üstü Köpürür", artist: "Cem Karaca", year: 1969 },
        { song: "Karadır Kaşların", artist: "Ruhi Su", year: 1965 },
        { song: "Altın Mikrofon", artist: "Mavi Işıklar", year: 1966 },
        { song: "Yesterday", artist: "The Beatles", year: 1965 },
        { song: "Satisfaction", artist: "The Rolling Stones", year: 1965 },
        { song: "Hey Jude", artist: "The Beatles", year: 1968 },
        { song: "Suspicious Minds", artist: "Elvis Presley", year: 1969 }
    ],
    // 70s
    seventies: [
        { song: "Nick The Chopper", artist: "Barış Manço", year: 1979 },
        { song: "Namus Belası", artist: "Cem Karaca", year: 1974 },
        { song: "Tamirci Çırağı", artist: "Cem Karaca", year: 1975 },
        { song: "Fesuphanallah", artist: "Erkin Koray", year: 1974 },
        { song: "Estarabim", artist: "Erkin Koray", year: 1975 },
        { song: "Şaşkın", artist: "Erkin Koray", year: 1974 },
        { song: "Anlasana", artist: "İlhan İrem", year: 1975 },
        { song: "Yaz Gazeteci Yaz", artist: "Selda Bağcan", year: 1976 },
        { song: "Güller ve Dudaklar", artist: "İlhan İrem", year: 1977 },
        { song: "Çöpçüler", artist: "Erkin Koray", year: 1979 },
        { song: "Öyle Sarhoş Olsam ki", artist: "Tanju Okan", year: 1972 },
        { song: "Kadınım", artist: "Tanju Okan", year: 1974 },
        { song: "Melankoli", artist: "Nükhet Duru", year: 1978 },
        { song: "Beni Benimle Bırak", artist: "Nükhet Duru", year: 1976 },
        { song: "Sarı Çizmeli Mehmet Ağa", artist: "Barış Manço", year: 1979 },
        { song: "Gesi Bağları", artist: "Selda Bağcan", year: 1976 },
        { song: "İşte Gidiyorum Çeşm-i Siyahım", artist: "Edip Akbayram", year: 1973 },
        { song: "Aldırma Gönül", artist: "Edip Akbayram", year: 1977 },
        { song: "Boşver Boşver Arkadaş", artist: "İlhan İrem", year: 1974 },
        { song: "Yalan", artist: "Yeliz", year: 1976 },
        { song: "Stairway to Heaven", artist: "Led Zeppelin", year: 1971 },
        { song: "Bohemian Rhapsody", artist: "Queen", year: 1975 },
        { song: "Hotel California", artist: "Eagles", year: 1976 },
        { song: "Stayin' Alive", artist: "Bee Gees", year: 1977 },
        { song: "I Will Survive", artist: "Gloria Gaynor", year: 1978 }
    ],
    // 80s
    eighties: [
        { song: "Dönence", artist: "Barış Manço", year: 1981 },
        { song: "Arkadaşım Eşek", artist: "Barış Manço", year: 1981 },
        { song: "Firuze", artist: "Sezen Aksu", year: 1982 },
        { song: "Sen Ağlama", artist: "Sezen Aksu", year: 1984 },
        { song: "Git", artist: "Sezen Aksu", year: 1986 },
        { song: "Belalım", artist: "Sezen Aksu", year: 1989 },
        { song: "Ele Güne Karşı", artist: "MFÖ", year: 1984 },
        { song: "Deli Deli", artist: "MFÖ", year: 1986 },
        { song: "Güllerin İçinden", artist: "MFÖ", year: 1984 },
        { song: "Sude", artist: "MFÖ", year: 1989 },
        { song: "Akdeniz Akdeniz", artist: "Yeni Türkü", year: 1983 },
        { song: "Fırtına", artist: "Yeni Türkü", year: 1988 },
        { song: "Telli Telli", artist: "Yeni Türkü", year: 1987 },
        { song: "Geceler", artist: "Nilüfer", year: 1986 },
        { song: "Esmer Günler", artist: "Nilüfer", year: 1988 },
        { song: "Tek Başına", artist: "Ayten Alpman", year: 1984 },
        { song: "Beni Kategori Dışı Tut", artist: "Sezen Aksu", year: 1989 },
        { song: "Domates Biber Patlıcan", artist: "Barış Manço", year: 1989 },
        { song: "Billie Jean", artist: "Michael Jackson", year: 1982 },
        { song: "Beat It", artist: "Michael Jackson", year: 1982 },
        { song: "Like a Virgin", artist: "Madonna", year: 1984 },
        { song: "Sweet Child O' Mine", artist: "Guns N' Roses", year: 1987 },
        { song: "Take On Me", artist: "a-ha", year: 1985 },
        { song: "Another One Bites the Dust", artist: "Queen", year: 1980 }
    ],
    // 90s
    nineties: [
        { song: "Gülümse", artist: "Sezen Aksu", year: 1991 },
        { song: "Hadi Bakalım", artist: "Sezen Aksu", year: 1991 },
        { song: "Abone", artist: "Yonca Evcimik", year: 1991 },
        { song: "Kıl Oldum", artist: "Tarkan", year: 1992 },
        { song: "Vazgeçemem", artist: "Tarkan", year: 1994 },
        { song: "Şıkıdım (Hepsi Senin mi?)", artist: "Tarkan", year: 1994 },
        { song: "Şımarık", artist: "Tarkan", year: 1997 },
        { song: "Şıkıdım", artist: "Tarkan", year: 1997 },
        { song: "Bu Kız Beni Görmeli", artist: "Mustafa Sandal", year: 1994 },
        { song: "Araba", artist: "Mustafa Sandal", year: 1996 },
        { song: "Aya Benzer", artist: "Mustafa Sandal", year: 1998 },
        { song: "Sakin Ol", artist: "Sertab Erener", year: 1992 },
        { song: "Lal", artist: "Sertab Erener", year: 1994 },
        { song: "Yaparım Bilirsin", artist: "Kenan Doğulu", year: 1993 },
        { song: "Kurşun Adres Sormaz Ki", artist: "Kenan Doğulu", year: 1994 },
        { song: "Her Gece", artist: "Mirkelam", year: 1995 },
        { song: "Kadın", artist: "Şebnem Ferah", year: 1996 },
        { song: "Vazgeçtim Dünyadan", artist: "Şebnem Ferah", year: 1996 },
        { song: "Holigan", artist: "Athena", year: 1998 },
        { song: "Köprüaltı", artist: "Duman", year: 1999 },
        { song: "Hal Hal", artist: "Barış Manço", year: 1990 },
        { song: "Smells Like Teen Spirit", artist: "Nirvana", year: 1991 },
        { song: "I Will Always Love You", artist: "Whitney Houston", year: 1992 },
        { song: "Black or White", artist: "Michael Jackson", year: 1991 },
        { song: "Losing My Religion", artist: "R.E.M.", year: 1991 },
        { song: "Zombie", artist: "The Cranberries", year: 1994 },
        { song: "Barbie Girl", artist: "Aqua", year: 1997 }
    ],
    // 2000s
    twothousands: [
        { song: "Yalanın Batsın", artist: "Hande Yener", year: 2000 },
        { song: "Sen Yoluna Ben Yoluma", artist: "Hande Yener", year: 2002 },
        { song: "Kırmızı", artist: "Hande Yener", year: 2004 },
        { song: "Kuzu Kuzu", artist: "Tarkan", year: 2001 },
        { song: "Dudu", artist: "Tarkan", year: 2003 },
        { song: "Bir Derdim Var", artist: "Mor ve Ötesi", year: 2004 },
        { song: "Cambaz", artist: "Mor ve Ötesi", year: 2004 },
        { song: "Bir Kadın Çizeceksin", artist: "maNga", year: 2004 },
        { song: "Cevapsız Sorular", artist: "maNga", year: 2009 },
        { song: "Everyway That I Can", artist: "Sertab Erener", year: 2003 },
        { song: "Yerli Plaka", artist: "Ceza", year: 2006 },
        { song: "Neyim Var Ki", artist: "Ceza ft. Sagopa Kajmer", year: 2004 },
        { song: "Aşkı Bulamam Ben", artist: "Murat Boz", year: 2006 },
        { song: "Maximum", artist: "Murat Boz", year: 2006 },
        { song: "Ellerine Sağlık", artist: "Yalın", year: 2004 },
        { song: "Aşk Oyunu", artist: "Yalın", year: 2004 },
        { song: "Belki Alışman Lazım", artist: "Duman", year: 2002 },
        { song: "Senden Daha Güzel", artist: "Duman", year: 2009 },
        { song: "Dursun Zaman", artist: "maNga ft. Göksel", year: 2006 },
        { song: "Shake It Up Şekerim", artist: "Kenan Doğulu", year: 2007 },
        { song: "Dum Tek Tek", artist: "Hadise", year: 2009 },
        { song: "We Will Rock You", artist: "Five ft. Queen", year: 2000 },
        { song: "In the End", artist: "Linkin Park", year: 2001 },
        { song: "Yeah!", artist: "Usher", year: 2004 },
        { song: "Toxic", artist: "Britney Spears", year: 2003 },
        { song: "Hips Don't Lie", artist: "Shakira", year: 2006 },
        { song: "Poker Face", artist: "Lady Gaga", year: 2008 }
    ]
};

const moviesDatabase = {
    sixties: [
        { title: "Susuz Yaz", director: "Metin Erksan (Altın Ayı Ödüllü)" },
        { title: "Sevmek Zamanı", director: "Metin Erksan (Kült Başyapıt)" },
        { title: "Vesikalı Yarim", director: "Lütfi Ömer Akad" },
        { title: "Turist Ömer", director: "Hulki Saner (Sadri Alışık Klasikleri)" },
        { title: "Gurbet Kuşları", director: "Halit Refiğ" },
        { title: "Karanlıkta Uyananlar", director: "Ertem Göreç" },
        { title: "Haremde Dört Kadın", director: "Halit Refiğ" },
        { title: "The Good, the Bad and the Ugly", director: "Sergio Leone" },
        { title: "Psycho", director: "Alfred Hitchcock" },
        { title: "2001: A Space Odyssey", director: "Stanley Kubrick" }
    ],
    seventies: [
        { title: "Hababam Sınıfı", director: "Ertem Eğilmez (Efsane Sınıf Başlıyor)" },
        { title: "Selvi Boylum Al Yazmalım", director: "Atıf Yılmaz (Kadir İnanır & Türkan Şoray)" },
        { title: "Canım Kardeşim", director: "Ertem Eğilmez (Duygusal Başyapıt)" },
        { title: "Tosun Paşa", director: "Kartal Tibet (Kemal Sunal & Şener Şen)" },
        { title: "Süt Kardeşler", director: "Ertem Eğilmez (Gulyabani Efsanesi)" },
        { title: "Kapıcılar Kralı", director: "Zeki Ökten (Altın Portakallı)" },
        { title: "Çöpçüler Kralı", director: "Zeki Ökten" },
        { title: "Neşeli Günler", director: "Orhan Aksoy (Adile Naşit & Münir Özkul)" },
        { title: "Sürü", director: "Zeki Ökten / Yılmaz Güney" },
        { title: "Maden", director: "Yavuz Özkan" },
        { title: "The Godfather", director: "Francis Ford Coppola" },
        { title: "Star Wars: A New Hope", director: "George Lucas" },
        { title: "Jaws", director: "Steven Spielberg" },
        { title: "Taxi Driver", director: "Martin Scorsese" }
    ],
    eighties: [
        { title: "Yol", director: "Şerif Gören / Yılmaz Güney (Cannes Altın Palmiye)" },
        { title: "Muhsin Bey", director: "Yavuz Turgul (Şener Şen & Uğur Yücel)" },
        { title: "Selamsız Bandosu", director: "Nesli Çölgeçen" },
        { title: "Çiçek Abbas", director: "Sinan Çetin (İlyas Salman & Şener Şen)" },
        { title: "Züğürt Ağa", director: "Nesli Çölgeçen" },
        { title: "Şalvar Davası", director: "Kartal Tibet" },
        { title: "Namuslu", director: "Ertem Eğilmez" },
        { title: "Karılar Koğuşu", director: "Halit Refiğ" },
        { title: "Anayurt Oteli", director: "Ömer Kavur" },
        { title: "The Shining", director: "Stanley Kubrick" },
        { title: "Back to the Future", director: "Robert Zemeckis" },
        { title: "Blade Runner", director: "Ridley Scott" },
        { title: "Scarface", director: "Brian De Palma" }
    ],
    nineties: [
        { title: "Eşkıya", director: "Yavuz Turgul (Türk Sinemasını Yeniden Dirilten Efsane)" },
        { title: "Ağır Roman", director: "Mustafa Altıoklar (Kült Mahalle Dramı)" },
        { title: "Kahpe Bizans", director: "Gani Müjde (Nostaljik Bizans Komedisi)" },
        { title: "Propaganda", director: "Sinan Çetin (Kemal Sunal'ın Son Filmi)" },
        { title: "Masumiyet", director: "Zeki Demirkubuz (Haluk Bilginer Şovu)" },
        { title: "Tabutta Rövaşata", director: "Derviş Zaim" },
        { title: "İstanbul Kanatlarımın Altında", director: "Mustafa Altıoklar" },
        { title: "Gelinlik Kız", director: "Atıf Yılmaz" },
        { title: "Titanic", director: "James Cameron" },
        { title: "The Matrix", director: "Lana & Lilly Wachowski" },
        { title: "Pulp Fiction", director: "Quentin Tarantino" },
        { title: "Fight Club", director: "David Fincher" }
    ],
    twothousands: [
        { title: "Vizontele", director: "Yılmaz Erdoğan & Ömer Faruk Sorak" },
        { title: "G.O.R.A.", director: "Ömer Faruk Sorak (Cem Yılmaz Efsanesi)" },
        { title: "Babam ve Oğlum", director: "Çağan Irmak (Ağlatan Efsane Dram)" },
        { title: "Organize İşler", director: "Yılmaz Erdoğan" },
        { title: "Hokkabaz", director: "Cem Yılmaz & Ali Taner Baltacı" },
        { title: "Neredesin Firuze", director: "Ezel Akay (Renkli Müzikal)" },
        { title: "Hababam Sınıfı Üç Buçuk", director: "Kartal Tibet" },
        { title: "Recep İvedik", director: "Togan Gökbakar (Kırılan Gişe Rekorları)" },
        { title: "Yahşi Batı", director: "Ömer Faruk Sorak (Cem Yılmaz Vahşi Batıda)" },
        { title: "Nefes: Vatan Sağolsun", director: "Levent Semerci" },
        { title: "The Lord of the Rings: The Fellowship of the Ring", director: "Peter Jackson" },
        { title: "The Dark Knight", director: "Christopher Nolan" },
        { title: "Avatar", director: "James Cameron" },
        { title: "Inception", director: "Christopher Nolan" }
    ]
};

const tvDatabase = {
    sixties: [
        { title: "TRT Ankara Deneme Yayınları", channel: "TRT (İlk TV yayını, 1968)" },
        { title: "Radyo Tiyatrosu", channel: "TRT Radyoları (Mahallenin ortak eğlencesi)" },
        { title: "Arkası Yarın", channel: "TRT Radyoları" },
        { title: "Uzay Yolu (Star Trek)", channel: "Yabancı TV kanalları / TRT altyapısı" }
    ],
    seventies: [
        { title: "Kaynanalar", channel: "TRT (İlk yerli sitcom dizisi)" },
        { title: "Aşk-ı Memnu (1975)", channel: "TRT (İlk Türk edebiyat uyarlaması dizi)" },
        { title: "Hababam Sınıfı Belgeselleri", channel: "TRT" },
        { title: "Uykudan Önce", channel: "TRT (Adile Naşit Efsanesi)" },
        { title: "Bonanza", channel: "TRT (Kovboy Kuşağı)" }
    ],
    eighties: [
        { title: "Bizimkiler (1989)", channel: "TRT / Show TV (Türkiye'nin en uzun soluklu apartman dizisi)" },
        { title: "Perihan Abla", channel: "TRT (Perran Kutman & Şevket Altuğ)" },
        { title: "Çalıkuşu", channel: "TRT (Aydan Şener Efsanesi)" },
        { title: "Dallas", channel: "TRT (Tüm sokakları boşaltan efsane ithal pembe dizi)" },
        { title: "Uzay Yolu (Star Trek: The Next Generation)", channel: "TRT" },
        { title: "Görünmez Adam", channel: "TRT" }
    ],
    nineties: [
        { title: "Süper Baba", channel: "ATV (Şevket Altuğ, Süper Baba Fiko)" },
        { title: "İkinci Bahar", channel: "ATV (Türkan Şoray & Şener Şen)" },
        { title: "Sıdıka", channel: "Show TV (Kült Karikatür Uyarlaması Komedi)" },
        { title: "Yılan Hikayesi", channel: "Kanal D (Memoli & Zeyno Efsanesi)" },
        { title: "Deli Yürek", channel: "Show TV (Kenan İmirzalıoğlu, Miroğlu Yasaları)" },
        { title: "Mahallenin Muhtarları", channel: "Kanal D / ATV" },
        { title: "Ruhsar", channel: "Kanal D (Mazhar & Ruhsar)" },
        { title: "Bizimkiler", channel: "TRT / Show TV / Star TV" }
    ],
    twothousands: [
        { title: "Avrupa Yakası", channel: "ATV (Gülse Birsel Efsane Sitcom'u)" },
        { title: "Kurtlar Vadisi", channel: "Show TV / Kanal D (Polat Alemdar ve Konsey)" },
        { title: "Ezel", channel: "Show TV / ATV (Kenan İmirzalıoğlu & Tuncel Kurtiz)" },
        { title: "Aşk-ı Memnu", channel: "Kanal D (Bihter & Behlül Çılgınlığı)" },
        { title: "Asmalı Konak", channel: "ATV (Kapadokya Efsanesi, Nurgül Yeşilçay & Özcan Deniz)" },
        { title: "Yaprak Dökümü", channel: "Kanal D (Ali Rıza Bey ve Ailesi)" },
        { title: "Cennet Mahallesi", channel: "Show TV (Ferhat ile Sultan)" },
        { title: "Sihirli Annem", channel: "Kanal D / Star TV" },
        { title: "Çocuklar Duymasın", channel: "TGRT / ATV / Star TV" }
    ]
};

const gamesDatabase = {
    sixties: [
        { title: "Pinball (Tilt Oyunları)", platform: "Atari Salonları / Jetonlu Kabinler" },
        { title: "Spacewar!", platform: "DEC PDP-1" },
        { title: "Space Travel", platform: "Multics / Unix" }
    ],
    seventies: [
        { title: "Pong", platform: "Atari Ev Konsolu / Jetonlu Kabinler" },
        { title: "Space Invaders", platform: "Jetonlu Kabinler / Atari 2600" },
        { title: "Asteroids", platform: "Kabin / Atari" },
        { title: "Breakout", platform: "Atari Arcade Kabin" }
    ],
    eighties: [
        { title: "Pac-Man", platform: "Arcade Kabin / Atari 2600" },
        { title: "Donkey Kong", platform: "Arcade Kabin / NES" },
        { title: "Tetris", platform: "Game Boy / PC Klasik" },
        { title: "Super Mario Bros", platform: "NES (Kara Kutu Micro Genius)" },
        { title: "The Legend of Zelda", platform: "NES" },
        { title: "Street Fighter", platform: "Arcade Jetonlu Kabin" },
        { title: "Prince of Persia", platform: "MS-DOS / Amiga" }
    ],
    nineties: [
        { title: "Doom", platform: "MS-DOS (İlk 3D FPS Efsanesi)" },
        { title: "Street Fighter II", platform: "Arcade Kabin (Aduket Dönemi!) / SNES" },
        { title: "Mortal Kombat", platform: "Arcade / Sega Genesis / PC" },
        { title: "FIFA 98: Road to World Cup", platform: "PC / PlayStation 1" },
        { title: "Half-Life", platform: "PC Windows (İnternet Kafe Dönemi Başlıyor)" },
        { title: "Counter-Strike 1.0", platform: "PC Modu (Kafe Klasikleri)" },
        { title: "Age of Empires", platform: "PC Windows (Strateji Efsanesi)" },
        { title: "Tomb Raider", platform: "PlayStation 1 / PC (Lara Croft)" }
    ],
    twothousands: [
        { title: "GTA: Vice City", platform: "PC / PlayStation 2 (Tommy Vercetti Efsanesi)" },
        { title: "GTA: San Andreas", platform: "PC / PS2 (CJ ve Los Santos)" },
        { title: "Counter-Strike 1.6", platform: "PC Windows (İnternet Kafelerin Kralı)" },
        { title: "World of Warcraft", platform: "PC MMORPG" },
        { title: "Need for Speed: Underground 2", platform: "PC / PS2 (Modifiye ve Rider on the Storm)" },
        { title: "Call of Duty 2", platform: "PC Windows (2. Dünya Savaşı Efsanesi)" },
        { title: "PES 6 (Pro Evolution Soccer 2006)", platform: "PlayStation 2 / PC (Adriano 99 Şut!)" },
        { title: "Knight Online", platform: "PC MMORPG (Sabahlanan Kafe Geceleri)" },
        { title: "Metin2", platform: "PC MMORPG (Dolunay Kılıcı Dönemi!)" }
    ]
};

// Generates highly accurate local/global news per year
function generateStaticNewsForYear(year) {
    const turkey = [];
    const world = [];

    // Fallbacks just in case
    turkey.push({ title: `${year} yılında Türkiye'de kültürel ve sosyal alanda önemli adımlar atıldı.` });
    turkey.push({ title: `${year} yılında yerli sanayi yatırımları ve kalkınma planları mecliste konuşuldu.` });
    turkey.push({ title: `${year} yılında Türk sporu ve futbol liginde heyecanlı zirve mücadeleleri yaşandı.` });

    world.push({ title: `${year} yılında küresel çapta bilimsel keşifler ve teknolojik yenilikler yapıldı.` });
    world.push({ title: `${year} yılında dünya siyasetinde yeni diplomatik adımlar ve anlaşmalar imzalandı.` });

    // Specific famous events by year (High Fidelity database)
    if (year === 1999) {
        turkey[0] = { title: "17 Ağustos 1999: Merkez üssü Gölcük olan 7.4 büyüklüğündeki Marmara Depremi büyük yıkıma sebep oldu." };
        turkey[1] = { title: "Bülent Ecevit başbakanlığında DSP-MHP-ANAP koalisyon hükümeti (57. Hükümet) kuruldu." };
        turkey[2] = { title: "Galatasaray futbol takımı UEFA Kupası yolculuğunda çeyrek finale doğru emin adımlarla ilerledi." };
        world[0] = { title: "1 Ocak 1999: Avrupa ortak para birimi Euro resmi olarak (hesap birimi olarak) yürürlüğe girdi." };
        world[1] = { title: "Dünya genelinde Milenyum Hatalı (Y2K) bilgisayar krizine karşı geniş güvenlik önlemleri alındı." };
    } else if (year === 2000) {
        turkey[0] = { title: "17 Mayıs 2000: Galatasaray, Arsenal'i penaltılarda yenerek UEFA Kupası'nı kazandı; Türkiye sokaklara döküldü." };
        turkey[1] = { title: "Ahmet Necdet Sezer, Türkiye Cumhuriyeti'nin 10. Cumhurbaşkanı olarak seçildi ve göreve başladı." };
        turkey[2] = { title: "2000 Milenyum kutlamaları tüm Türkiye genelinde konserler ve havai fişek gösterileriyle kutlandı." };
        world[0] = { title: "Yeni binyıla (Milenyum) dünya çapında büyük kutlamalar ve teknoloji iyimserliği ile girildi." };
        world[1] = { title: "Sydney Olimpiyat Oyunları görkemli bir törenle açıldı ve büyük rekabetlere ev sahipliği yaptı." };
    } else if (year === 2001) {
        turkey[0] = { title: "Şubat 2001: Anayasa kitapçığı fırlatma krizi sonrası Türkiye Cumhuriyeti tarihinin en ağır ekonomik krizlerinden biri yaşandı." };
        turkey[1] = { title: "Kemal Derviş, ekonomiyi düzeltmek üzere güçlü yetkilerle Ekonomiden Sorumlu Devlet Bakanlığına getirildi." };
        turkey[2] = { title: "Tarkan, 'Kuzu Kuzu' single'ını çıkararak müzik listelerini salladı ve büyük bir pop rüzgarı başlattı." };
        world[0] = { title: "11 Eylül 2001: New York'taki İkiz Kulelere ve Pentagon'a terör saldırıları düzenlendi; dünya tarihi değişti." };
        world[1] = { title: "ABD ordusu terörle mücadele kapsamında Afganistan'a askeri harekat başlattı." };
    } else if (year === 2002) {
        turkey[0] = { title: "Haziran 2002: A Milli Futbol Takımımız, Dünya Kupası'nda dünya 3.sü olarak tarihi bir başarı elde etti." };
        turkey[1] = { title: "3 Kasım 2002: Erken genel seçimlerde AK Parti tek başına iktidara geldi, yeni bir siyasi dönem başladı." };
        turkey[2] = { title: "Asmalı Konak dizisi Kapadokya'da çekilmeye başladı ve reyting rekorları kırarak turizm patlaması yarattı." };
        world[0] = { title: "1 Ocak 2002: Euro banknot ve madeni paraları resmi olarak 12 Avrupa ülkesinde tedavüle girdi." };
        world[1] = { title: "Kuzey Kore, nükleer reaktörlerini yeniden aktif hale getireceğini duyurarak dünyayı alarma geçirdi." };
    } else if (year === 2003) {
        turkey[0] = { title: "24 Mayıs 2003: Sertab Erener, 'Everyway That I Can' şarkısıyla Eurovision Şarkı Yarışması'nda Türkiye'ye ilk birinciliğini kazandı." };
        turkey[1] = { title: "Recep Tayyip Erdoğan, Siirt milletvekili ara seçimiyle meclise girerek Başbakanlık koltuğuna oturdu." };
        turkey[2] = { title: "Kurtlar Vadisi dizisi Show TV ekranlarında başlayarak derin devlet ve mafya temasıyla ekranları kilitledi." };
        world[0] = { title: "Mart 2003: ABD liderliğindeki koalisyon güçleri Irak'ı işgal etti ve Bağdat düştü." };
        world[1] = { title: "Çin Halk Cumhuriyeti, uzaya ilk insanlı uzay aracı olan Shenzhou 5'i başarıyla fırlattı." };
    } else if (year === 2004) {
        turkey[0] = { title: "TRT, yerel dillerde (Kürtçe, Boşnakça, Arapça vb.) televizyon ve radyo yayınlarına resmi olarak başladı." };
        turkey[1] = { title: "Avrupa Yakası dizisi ATV ekranlarında yayına girdi ve efsaneleşecek karakterleriyle sitcom devrini başlattı." };
        turkey[2] = { title: "Galatasaray'ın efsane stadı Ali Sami Yen yenilenerek maçlara açıldı, taraftar coşkusu arttı." };
        world[0] = { title: "4 Şubat 2004: Mark Zuckerberg tarafından Harvard Üniversitesi'nde Facebook kuruldu ve sosyal medya çağı başladı." };
        world[1] = { title: "Aralık 2004: Hint Okyanusu'nda meydana gelen 9.1 büyüklüğündeki deprem ve tsunami felaketinde 230 bin kişi öldü." };
    } else if (year === 2005) {
        turkey[0] = { title: "1 Ocak 2005: Türk Lirası'ndan altı sıfır atılarak Yeni Türk Lirası (YTL) banknotları tedavüle girdi." };
        turkey[1] = { title: "Çağan Irmak'ın yönettiği 'Babam ve Oğlum' filmi sinemalarda fırtına kopardı ve milyonları ağlattı." };
        turkey[2] = { title: "Orhan Pamuk, yaptığı açıklamalar ve yazdığı kitaplar nedeniyle dava edilerek dünya gündemine oturdu." };
        world[0] = { title: "Kasım 2005: Angela Merkel, Almanya'nın ilk kadın şansölyesi (başbakanı) olarak göreve başladı." };
        world[1] = { title: "Video paylaşım platformu YouTube kuruldu ve internet dünyasında video devrimi yaşandı." };
    } else if (year === 2006) {
        turkey[0] = { title: "12 Ekim 2006: Türk yazar Orhan Pamuk, Nobel Edebiyat Ödülü'nü kazanarak bu ödülü alan ilk Türk oldu." };
        turkey[1] = { title: "Bakü-Tiflis-Ceyhan Petrol Boru Hattı (BTC) resmi törenle açılarak ilk petrol sevkiyatı yapıldı." };
        turkey[2] = { title: "Rap sanatçısı Ceza, 'Yerli Plaka' albümünü çıkararak Türkçe Rap müziği ana akıma taşıdı." };
        world[0] = { title: "Plüton, Uluslararası Astronomi Birliği kararıyla gezegen sınıfından çıkarılarak 'cüce gezegen' ilan edildi." };
        world[1] = { title: "İtalya, Dünya Kupası finalinde Fransa'yı penaltılarla yenerek dünya şampiyonu oldu (Zidane kafası gündem oldu)." };
    } else if (year === 2007) {
        turkey[0] = { title: "27 Nisan 2007: Genelkurmay Başkanlığı internet sitesine cumhurbaşkanlığı seçimleri hakkında 'e-muhtıra' yayınlandı." };
        turkey[1] = { title: "Kenan Doğulu, Finlandiya'daki Eurovision'da 'Shake It Up Şekerim' şarkısıyla Türkiye'yi temsil ederek 4. oldu." };
        turkey[2] = { title: "22 Temmuz 2007 genel seçimlerinde AK Parti %46.6 oy oranıyla yeniden iktidar oldu; Abdullah Gül cumhurbaşkanı seçildi." };
        world[0] = { title: "9 Ocak 2007: Apple CEO'su Steve Jobs, akıllı telefon devrimini başlatan ilk iPhone modelini tanıttı." };
        world[1] = { title: "Küresel iklim değişikliğine karşı dünya çapında milyonlarca insanın katıldığı çevre protestoları düzenlendi." };
    } else if (year === 2008) {
        turkey[0] = { title: "Haziran 2008: A Milli Futbol Takımımız, Euro 2008 şampiyonasında muhteşem geri dönüşlerle yarı finale yükseldi." };
        turkey[1] = { title: "Aşk-ı Memnu dizisi Kanal D ekranlarında başlayarak Bihter-Behlül aşkıyla tüm Türkiye'yi ekran başına kilitledi." };
        turkey[2] = { title: "Cumhuriyet tarihinin en büyük soruşturmalarından Ergenekon davası kapsamında gözaltılar başladı." };
        world[0] = { title: "Eylül 2008: ABD'li yatırım bankası Lehman Brothers iflas etti ve dünya çapında küresel finansal kriz başladı." };
        world[1] = { title: "Barack Obama, ABD tarihinin ilk siyahi başkanı olarak seçimleri kazandı." };
    } else if (year === 2009) {
        turkey[0] = { title: "TRT Şeş (TRT 6) kanalı Kürtçe yayın hayatına başladı ve TRT tarihinde büyük bir reform gerçekleştirildi." };
        turkey[1] = { title: "Hadise, Eurovision'da 'Düm Tek Tek' şarkısıyla büyük beğeni toplayarak Türkiye'ye 4.lük kazandı." };
        turkey[2] = { title: "Başrollerini Kenan İmirzalıoğlu ve Tuncel Kurtiz'in paylaştığı intikam temalı Ezel dizisi Show TV'de başladı." };
        world[0] = { title: "25 Haziran 2009: Pop müziğin efsane kralı Michael Jackson, Los Angeles'taki evinde hayatını kaybetti; dünya yasa boğuldu." };
        world[1] = { title: "Dünya Sağlık Örgütü (WHO), H1N1 (Domuz Gribi) salgınını küresel pandemi ilan etti." };
    } else if (year === 2010) {
        turkey[0] = { title: "12 Eylül 2010: Türkiye genelinde yapılan anayasa değişikliği referandumu %58 'Evet' oyuyla kabul edildi." };
        turkey[1] = { title: "A Milli Basketbol Takımımız (12 Dev Adam), Türkiye'de düzenlenen Dünya Şampiyonası'nda gümüş madalya alarak 2. oldu." };
        turkey[2] = { title: "Türk pop şarkıcısı Tarkan, 'Sevdanın Son Vuruşu' teklisini çıkararak müzik listelerini alt üst etti." };
        world[0] = { title: "Ekim 2010: Fotoğraf paylaşım uygulaması Instagram, iPhone kullanıcıları için App Store'da yayınlandı." };
        world[1] = { title: "Aralık 2010: Tunus'ta Muhammed Buazizi'nin kendini yakmasıyla Arap Baharı protesto gösterileri ve devrimler serisi başladı." };
    } else if (year === 1990) {
        turkey[0] = { title: "Türkiye'nin ilk özel televizyon kanalı olan 'Magic Box Star 1' (Star TV) Almanya üzerinden test yayınına başladı." };
        world[0] = { title: "Doğu ve Batı Almanya, Berlin Duvarı'nın yıkılışından bir yıl sonra resmi olarak birleşti." };
        world[1] = { title: "Tim Berners-Lee, World Wide Web (WWW) sisteminin ilk başarılı iletişimini gerçekleştirdi." };
    } else if (year === 1980) {
        turkey[0] = { title: "12 Eylül 1980: Türk Silahlı Kuvvetleri, emir-komuta zinciri içinde askeri darbe gerçekleştirerek meclisi kapattı." };
        world[0] = { title: "İran ve Irak arasında 8 yıl sürecek olan kanlı sınır ve nüfuz savaşı resmen başladı." };
    } else if (year === 1974) {
        turkey[0] = { title: "20 Temmuz 1974: Türk Silahlı Kuvvetleri, Kıbrıs'taki Türkleri korumak amacıyla Kıbrıs Barış Harekatı'nı başlattı." };
        world[0] = { title: "ABD Başkanı Richard Nixon, Watergate skandalı sebebiyle istifa eden ilk ABD başkanı oldu." };
    } else if (year === 1968) {
        turkey[0] = { title: "31 Ocak 1968: TRT televizyon yayınları Ankara'da Mithatpaşa Stüdyosu'nda deneme yayınlarıyla başladı." };
        world[0] = { title: "Fransa'da 1968 Mayıs olayları patlak verdi; öğrenci protestoları ve grevler ülkeyi felç etti." };
    }

    return { turkey, world };
}

// Generate the seed entries for a specific year
function generateYearSeed(year) {
    const decade = Math.floor(year / 10) * 10;
    
    // Choose appropriate databases based on decade
    let musicList = [];
    let moviesList = [];
    let tvList = [];
    let gamesList = [];

    if (decade === 1960) {
        musicList = musicDatabase.sixties;
        moviesList = moviesDatabase.sixties;
        tvList = tvDatabase.sixties;
        gamesList = gamesDatabase.sixties;
    } else if (decade === 1970) {
        musicList = musicDatabase.seventies;
        moviesList = moviesDatabase.seventies;
        tvList = tvDatabase.seventies;
        gamesList = gamesDatabase.seventies;
    } else if (decade === 1980) {
        musicList = musicDatabase.eighties;
        moviesList = moviesDatabase.eighties;
        tvList = tvDatabase.eighties;
        gamesList = gamesDatabase.eighties;
    } else if (decade === 1990) {
        musicList = musicDatabase.nineties;
        moviesList = moviesDatabase.nineties;
        tvList = tvDatabase.nineties;
        gamesList = gamesDatabase.nineties;
    } else { // 2000s
        musicList = musicDatabase.twothousands;
        moviesList = moviesDatabase.twothousands;
        tvList = tvDatabase.twothousands;
        gamesList = gamesDatabase.twothousands;
    }

    // Filter year-specific if possible, or randomize/shuffle to select rich diversity
    const shuffle = (array) => [...array].sort(() => 0.5 - Math.random());

    const selectForYear = (list, count, currentYear) => {
        // Prioritize exact year matches
        let matches = list.filter(item => item.year === currentYear);
        if (matches.length < count) {
            // Fill with other items from the decade
            const others = shuffle(list.filter(item => item.year !== currentYear));
            matches = [...matches, ...others];
        }
        return matches.slice(0, count).map(x => ({ ...x }));
    };

    // Selected data sets
    const music = selectForYear(musicList, 16, year).map(m => { delete m.year; return m; });
    const movies = selectForYear(moviesList, 10, year);
    const tv = selectForYear(tvList, 10, year);
    const games = selectForYear(gamesList, 10, year);
    
    // News
    const news = generateStaticNewsForYear(year);

    return {
        music,
        movies,
        tv,
        games,
        world_news: news.world,
        turkey_news: news.turkey
    };
}

function main() {
    console.log('=== SEED GENERATOR: BUILDING STATIC TIMELINE DATABASE ===');
    
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const seedData = {};
    const years = Array.from({length: 51}, (_, i) => 2010 - i); // 2010 down to 1960

    for (const year of years) {
        seedData[year] = generateYearSeed(year);
    }

    // Save to timeline_seed.json
    fs.writeFileSync(SEED_FILE, JSON.stringify(seedData, null, 2), 'utf8');
    console.log(`Successfully compiled timeline seed file with ${years.length} years of data at:`);
    console.log(SEED_FILE);
    
    process.exit(0);
}

main();
