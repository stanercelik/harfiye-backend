# Harfiye Backend

Harfiye kelime düellosu oyununun backend API'si.

## Teknolojiler

- **Node.js & Express**: Web sunucusu
- **Socket.IO**: Gerçek zamanlı iletişim
- **TypeScript**: Tip güvenli geliştirme
- **Cors**: Cross-origin istekleri için

## Kurulum

```bash
# Bağımlılıkları yükle
npm install

# Geliştirme modunda çalıştır
npm run dev

# Production build
npm run build
npm start
```

## Oyun Özellikleri

- ✅ Çok oyunculu destek (2-5 oyuncu)
- ✅ 5, 6 ve 7 harfli kelime desteği
- ✅ Zamanlayıcı sistemi (30-90 saniye veya sınırsız)
- ✅ Rövanş sistemi
- ✅ Türkçe kelime listesi (~15,000 kelime)
- ✅ Gerçek zamanlı oyun durumu senkronizasyonu

## Environment Variables

```env
PORT=3002  # Varsayılan port
```

## Deployment (Render)

Bu backend Render.com üzerinde deploy edilmek için optimize edilmiştir.

1. Bu repo'yu Render'a bağlayın
2. Build Command: `npm run build`
3. Start Command: `npm start`
4. Environment: Node.js

## API Endpoints

- `GET /` - Server durumu ve istatistikleri

## Socket.IO Events

### İstemci → Sunucu
- `create_room` - Yeni oda oluştur
- `join_room` - Odaya katıl
- `make_guess` - Tahmin yap
- `request_rematch` - Rövanş talep et
- `accept_rematch` - Rövanşı kabul et
- `decline_rematch` - Rövanşı reddet

### Sunucu → İstemci
- `room_created` - Oda oluşturuldu
- `room_joined` - Odaya katıldı
- `game_start` - Oyun başladı
- `update_state` - Oyun durumu güncellendi
- `game_over` - Oyun bitti
- `error` - Hata mesajı

## Kelime Listeleri

- `words_tr_5.json`: 5 harfli Türkçe kelimeler
- `words_tr_6.json`: 6 harfli Türkçe kelimeler  
- `words_tr_7.json`: 7 harfli Türkçe kelimeler

## Lisans

MIT