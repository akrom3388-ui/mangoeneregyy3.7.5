# Mango Monitor v3.7.5

Tuya issiqlik nasosi monitori — **faqat mustaqil (serversiz) rejim**. Hamma narsa telefonda ishlaydi.

## v3.7.5 da nima o'zgardi
- **Avto → «Taymer bilan o'chirish»** (ob-havoga bog'liq emas): nasos yoqilganidan **6 / 12 / 18 / 24 soat** (yoki o'zingiz yozgan soat) keyin yoki **belgilangan vaqtda (har kuni)** nasos o'chiriladi. Bu **fon (Kotlin) kodida** ishlaydi, ilova yopiq bo'lsa ham (fon kuzatuvi ishlab turgan bo'lsa). Joriy seans uchun taxminiy o'chish vaqti ko'rsatiladi.
- **Ob-havo bo'yicha avtomatik yoqish**: standart chegara **−3 °C**; tashqi harorat shunga tushganda nasos o'chiq bo'lsa, o'zi yoqiladi (ham fonda). Saqlangan eski «3» qiymat bir marta −3 ga almashtiriladi.
- Eski «Ob-havo bo'yicha defrost» kartasi olib tashlandi.
- **Fon kuzatuvi ogohlantirishi** (Asosiy ekran tepasida): batareya cheklovi yoqiq bo'lsa yoki fon kuzatuvi uzilgan bo'lsa chiqadi; «Cheklovsiz ishlashga ruxsat» va «Avtostart sozlamasi» tugmalari bor (Xiaomi/Huawei/Oppo/Vivo/Samsung).
- **Seans boshlanishi «~»** bilan ko'rsatiladi, agar fon kuzatuvi uzilib, nasos yonishi o'sha paytda sezilmagan bo'lsa.

## v3.7.4 da nima o'zgardi
1. **Sozlama**: hamma bo'limlar yig'ilgan (bosilsa ochiladi, holati eslab qolinadi).
2. **Avto**: hamma bo'limlar yig'ilgan; yangi **"Ob-havo bo'yicha defrost (taymer bilan)"**: tashqi harorat ≤ belgilangan qiymat (standart −2 °C) bo'lsa defrost avtomatik yoqiladi; taymer uni **belgilangan soatdan keyin** yoki **belgilangan vaqtda** o'chiradi (yoki o'rniga nasosni o'chirish mumkin); qayta yoqish oralig'i sozlanadi. Nasosda yoziladigan `defrost` DP bo'lishi kerak. Ilova ishlab turganda bajariladi.
3. **Boshqaruv**: «Ish rejimi» kartasi butunlay olib tashlandi.
4. **Statistika**: «Seanslar: oxirgi va undan oldingi 5 ta» kartasi (davrga bog'liq emas).
5. **Asosiy ekran**: «⚙ Sozlash» tugmasi: har bir blokni (holat, harorat, quvvat, seans, bugun jadvali, grafiklar, davr tugmalari) yoqish/o'chirish (filtr) va ▲▼ bilan joyini o'zgartirish; ko'rsatkichlar (kartochkalar) ro'yxatini ochib, har birini alohida yashirish va ko'chirish. «Standart holat» tugmasi bor.

## v3.7 da nima o'zgardi
- **Telegram kanal orqali yangilash.** Yangi APK ni kanalga tashlab pin qilasiz; ilova (ochiq yoki fon tekshiruvida) buni topadi, **to'liq ekranli «Yangi versiya chiqdi» oynasi** chiqadi va yangilanmaguncha ilova ishlamaydi. «Yangilash» → ilova ichida yuklaydi → Android o'rnatish tasdig'i → eskisi o'chirilmay ustidan yangilanadi (ma'lumotlar saqlanadi). «Telegramda ochish» tugmasi kanalni ochadi. Fon bildirishnomasi ham keladi (ovozsiz). Sozlamada «Yangilanishni tekshirish» tugmasi bor.
- **v3.7.2:** bot tokeni va kanal APK ichiga qotirilgan (`update-channel.properties`), ilovada o'zgartirib bo'lmaydi; kanal ID va @nom ketma-ket sinaladi.
- **Doimiy imzo kaliti** (`android/app/mango-update.jks`): barcha build'lar shu kalit bilan imzolanadi, shuning uchun yangi APK eskisining ustiga o'rnatiladi. **Bu faylni yo'qotmang va begonalarga bermang.**
- **APK nomi versiya bilan**: `MangoMonitor-3.7.0.apk`. Versiya endi faqat `android/app/build.gradle` dagi `versionCode/versionName` da.

### Telegram yangilanishini sozlash (build'dan oldin, bir marta)
1. `android/app/update-channel.properties` faylini oching va `TG_BOT_TOKEN=` dan keyin bot tokenini yozing (`TG_CHAT_ID` ichida kanal ID si turibdi). Commit qiling. **Repozitoriy Private bo'lsin.**
2. Token va kanal **APK ichiga qotiriladi**: ilovada ularni o'zgartiradigan joy yo'q. (Muqobil: GitHub secret `TG_BOT_TOKEN` / variable `TG_CHAT_ID`, ular fayldan ustun.)
3. Kanalda bot **admin** bo'lsin, lekin keraksiz ruxsatlarni (xabar yuborish, o'chirish, a'zo qo'shish) o'chirib qo'ying: bot faqat pin qilingan xabarni o'qiydi. Token APK dan ajratib olinishi mumkin, shuning uchun bu bot faqat yangilanish uchun bo'lsin va boshqa joyda ishlatilmasin.
4. **Yangi versiya chiqarish:** `app/build.gradle` da `versionCode` +1, `versionName` ni oshiring → GitHub'ga yuklang → Actions tugagach Artifacts'dan `MangoMonitor-X.Y.Z.apk` ni oling → kanalga **fayl (hujjat) sifatida** yuboring, izohiga versiyani yozing (masalan `v3.8.0`; izohda «ixtiyoriy» bo'lsa majburiy emas) → xabarni **pin qiling**.
5. Telefonlarda: Sozlama → **Yangilanishni tekshirish**. «Yangi versiya yo'q» — kanal ulangan, lekin kanalda yangi pin qilingan APK yo'q.
- Cheklovlar: Android o'rnatish tasdig'ini har safar so'raydi (jimgina o'rnatib bo'lmaydi); birinchi yangilashda «Noma'lum ilovalarni o'rnatish» ruxsati so'raladi; bot orqali yuklash 20 MB gacha; tokenni APK ichidan ajratib olish mumkin, shuning uchun faqat yangilanish uchun alohida bot ishlating. Telefon yangilanmaguncha UI to'xtaydi, lekin fon kuzatuvi (tarixga yozish) davom etadi.

## v3.6 da nima o'zgardi
- **"Server bilan" rejimi to'liq olib tashlandi** (ro'yxatdan o'tish, taklif kodlari, oila a'zolari, Alisa, `server/` papkasi).
- **"Ish rejimi" tanlash ekrani olib tashlandi**: til → Smart Life/kalit ulash → uy → qurilma → quvvat → tayyor.
- **APK versiyasi** (`v3.6.0`) har doim eng tepada, ogohlantirish (🔔) tugmasi yonida ko'rinib turadi.
- Eski server rejimidan yangilangan foydalanuvchi: ilova Tuya ulanishini so'raydi (server ma'lumotlari ko'chmaydi).

## v3.5 da nima o'zgardi
1. **Oxirgi seans xarajati.** Nasos yoqilgandan (Yoniq) o'chirilgunga qadar bo'lgan davr — *seans*. Asosiy ekranda "Oxirgi seans" kartasi: boshlanish/tugash vaqti, davomiyligi, kWh, **so'm** va kompressor daqiqasi. Xarajat pog'onali tarif bo'yicha hisoblanadi (seansning har soatdagi ulushi shu soat narxiga ko'paytiriladi).
2. **Statistika → Batafsil:** endi uch ko'rinish: **Soatlar** (har bir soat: kWh, so'm, kompressor daqiqasi, Hz, tashqi harorat — kun/hafta/oy uchun), **Kunlar/Oylar** va **Seanslar** (har bir seans alohida, pastida jami). Jadval ichida aylantiriladi, sarlavha tepada qotib turadi.
3. **Grafiklar har 10 soniyada o'zi yangilanadi** (harorat, quvvat kW, kompressor Hz). Oxirgi qismi 10 soniyalik jonli nuqtalar bilan chiziladi (ilova ochiq turganda xotirada yig'iladi).
4. **Qurilma parametrlari:** 25 kW → kompressor **4100 Vt**. Qolganlari shu nisbatda: 18 kW = 2950, 30 kW = 4920, 35 kW = 5740 Vt. Yangi **"Quvvat (kW)"** maydoni: istalgan kW ni yozing (masalan 22) — kompressor, nasos, ventilyator va oqim shu nisbatda o'zi hisoblanib maydonlarda ko'rinadi. Eski (v3.4) sozlamalar bir marta avtomatik yangilanadi (qo'lda o'zgartirgan qiymatlaringiz saqlanadi).
5. **Issiqlik quvvati (taxmin) har 2 soniyada** yangilanadi (COP, quvvat, tok va ΔT ham). Sahifa qayta chizilmaydi — faqat raqamlar almashadi. Server rejimida jonli so'rov oralig'i 2 s (`LIVE_POLL_SEC`, standart 2) — faqat ilova ochiq paytda.
6. **Boshqaruv:** "Isitish turi" kartasi olib tashlandi, o'rniga **Rejimlar** (Isitish / Sovutish / Avto / Issiq suv ...). Nasosda rejim DP si topilmasa, shu kartadagi ro'yxatdan tanlanadi.
7. **"Isitish mavsumi" kartasi olib tashlandi** (statistikadan).
8. **Gistogrammalar:** ustunga bosilsa shu ustunning o'z ma'lumoti chiqadi (kWh, so'm, kompressor, Hz, tashqi harorat, COP, ishga tushish, defrost). Gistogramma ko'rsatkichini almashtirish mumkin: kWh / so'm / kompressor.
9. **Zoom:** harorat, kVt va Hz grafiklarida ＋ − ◀ ▶ tugmalari va ikki barmoq bilan yaqinlashtirish.
10. **Bildirishnomalar ovozsiz** (ovoz ham, tebranish ham yo'q). Android kanal sozlamasini keyin o'zgartirib bo'lmagani uchun yangi kanal (`mm_alerts_quiet`) yaratiladi, eskisi o'chiriladi.
11. **Pog'onali tarif jadvali** yoqilganda yig'ilgan ("svernut") holda turadi — Sozlama ichida joy egallamaydi; ochish uchun bosiladi.
12. **Bildirishnomalar sozlamasi** (Sozlama ichida, yig'ilgan holda): yuqori paneldagi doimiy bildirishnomani va kelgan ogohlantirishlarni alohida yoqish/o'chirish.

13. **Smart Life orqali ulanish (Access ID / Secret kerak emas, server kerak emas).** Birinchi ekranda ikki yo'l: *Smart Life (oson)* va *Developer kalitlari*. Oson yo'lda: Smart Life → Men → Sozlamalar → Hisob va xavfsizlik → **User Code** ni yozasiz → ilova QR chiqaradi → uni Smart Life bilan skanerlaysiz (telefon bitta bo'lsa «Rasmga saqlash» tugmasi, so'ng Smart Life skanerida galereyadan tanlang). Ulangach nasos **ro'yxatdan tanlanadi** (Device ID yozish shart emas). Bu Tuya'ning «qurilma ulashish» tizimi (Home Assistant ham shuni ishlatadi); login-parol so'ralmaydi, parolingiz ilovaga umuman berilmaydi. Rasmiy Tuya Cloud kaliti emas, shuning uchun Tuya uni o'zgartirsa ishlamay qolishi mumkin; kerak bo'lsa «Developer kalitlari» yo'li saqlanib qolgan.

Sinov holati: Smart Life ulanishining shifrlash/imzo qismi rasmiy `tuya-device-sharing-sdk` bilan bayt-ma-bayt solishtirildi va Kotlin kodi soxta shlyuzga qarshi to'liq oqim (QR, kirish, qurilmalar, holat, buyruq, token yangilash) bilan sinaldi; **haqiqiy Tuya serveri va haqiqiy telefon bilan hali sinalmagan**. Telegram yangilash: yuklash/versiya mantiqi soxta Telegram serveriga qarshi sinaldi, Android kodi `android.jar` ga qarshi kompilyatsiya qilindi; **haqiqiy bot, Gradle build va telefonda o'rnatish hali sinalmagan**. Interfeys, hisob-kitob va mustaqil rejim dvigateli jsdom muhitida soxta Tuya bilan sinab ko'rildi (seanslar, soat/seans jadvali, gistogramma, zoom, kW hisobi, migratsiya, 4 til). **Android (Kotlin) qismi bu muhitda kompilyatsiya qilinmagan** (faqat `Poller.kt` va `MainActivity.kt` da bildirishnoma kanali o'zgargan). Pinch-zoom haqiqiy telefonda sinalmagan. Birinchi GitHub Actions build'da xato chiqsa, logini yuboring.

## Eng tez yo'l: APK olish
1. GitHub'da repozitoriy yarating, shu arxivdagi hamma narsani (`.github/`, `android/`) yuklang. **Actions** → build tugagach **Artifacts → MangoMonitor** dan APK ni oling. (Batafsil: `GITHUB_ORNATISH.md`.)
2. Ilova: til → **Smart Life (oson)** (User Code + QR) yoki **Developer kalitlari** → uy → qurilmani ro'yxatdan tanlash → quvvat → tayyor.
3. Sarf hisobi to'g'ri bo'lishi uchun **doimiy bildirishnoma yoqiq turishi** va (Xiaomi/Huawei/Oppo) batareya cheklovi o'chirilgan bo'lishi kerak (Sozlama'da tugma bor).

## Imzolangan (release) APK
1. Keystore: `keytool -genkeypair -v -keystore mango-release.jks -alias mango -keyalg RSA -keysize 2048 -validity 10000`. **Keystore ni yo'qotmang.**
2. GitHub → Settings → Secrets and variables → Actions: `KEYSTORE_B64` (`base64 -w0 mango-release.jks`), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`. Shundan keyin build `app-release.apk` ham beradi va keyingi versiyalar ustidan yangilanadi.
3. Mahalliy: `gradle assembleRelease bundleRelease` (`keystore.properties.example` ni `keystore.properties` ga nusxalang).

## Muhim cheklovlar
- Orqa fon (ilova yopiq) kuzatuvi Android'ning batareya tejash qoidalariga bog'liq; telefon sozlamalarida Mango Monitor'ga cheklovsiz ishlashga ruxsat bering.
- Smart Life (User Code + QR) usuli rasmiy Tuya Cloud kaliti emas, Tuya o'zgartirsa ishlamay qolishi mumkin; shunda "Developer kalitlari" usulidan foydalaning.
- Ma'lumotlar (tarix, sozlamalar) faqat shu telefonda saqlanadi; ilovani o'chirsangiz yo'qoladi.
- Telefondagi yangi `Smart Life` ulanishi va Android (Kotlin) qismi haqiqiy telefonda birinchi marta sinaladi; xato chiqsa GitHub Actions logini yuboring.
