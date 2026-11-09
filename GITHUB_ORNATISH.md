# GitHub orqali o'rnatish (APK olish)

Telefoningizga APK ni GitHub o'zi yig'ib beradi. Kompyuterga Android Studio o'rnatish shart emas.

## 1. Repozitoriy yaratish (bir marta)
1. https://github.com ga kiring (hisob yo'q bo'lsa — Sign up).
2. Yuqori o'ngda **+ → New repository**. Nomi: `mango-monitor`. **Private** tanlang. **Create repository**.

## 2. Fayllarni yuklash
Zip faylni kompyuterda **ochib (Extract)** oling. Ichida `.github`, `android`, `README.md` bo'ladi.

**Brauzer orqali (eng oson):**
1. Yangi repozitoriy sahifasida **uploading an existing file** havolasini bosing.
2. Zip ichidagi **hamma narsani** (papkalarni ham) oynaga sudrab tashlang. `.github` papkasi yashirin bo'lishi mumkin: Windows Explorer'da *Ko'rish → Yashirin elementlar*, Mac'da `Cmd+Shift+.` bosing.
3. Pastda **Commit changes** (branch: `main`).

> Agar `.github/workflows/build.yml` yuklanmasa, Actions ishlamaydi. Yuklangach repozitoriyda `.github/workflows/build.yml` yo'li ko'rinishini tekshiring.

**Yoki git buyruqlari bilan:**
```bash
cd MangoMonitor_v3_7_5          # zip ochilgan papka
git init -b main
git add -A
git commit -m "Mango Monitor v3.7"
git remote add origin https://github.com/SIZNING_LOGIN/mango-monitor.git
git push -u origin main
```

## 3. APK ni yig'ish
1. Repozitoriyda **Actions** bo'limiga o'ting. `main` ga yuklaganingizda **Android build** o'zi boshlanadi (yoki chapdan *Android build → Run workflow*).
2. Yashil ✓ chiqquncha kuting (~5–10 daqiqa). Qizil ✗ bo'lsa — logni ochib, xato matnini menga yuboring.
3. Tugagan build'ni oching → pastda **Artifacts → MangoMonitor** ni yuklab oling (zip). Ichida `app-debug.apk`.

## 4. Telefonga o'rnatish
1. APK ni telefonga o'tkazing, ustiga bosing, **\"Noma'lum manbalardan o'rnatishga ruxsat\"** bering.
2. **Eski versiya haqida:** debug APK boshqa paket nomi bilan (`uz.mango.monitor.debug`) o'rnatiladi, eski ilovani ustidan yangilamaydi — ikkalasi yonma-yon turadi, **ma'lumotlar (Tuya kalitlari, tarix) ko'chmaydi**. Kalitlarni qaytadan kiriting, keyin eskisini o'chirishingiz mumkin.
3. **Ma'lumotlar saqlanib yangilanishi uchun** imzolangan (release) build kerak: bir marta keystore yarating va GitHub'da *Settings → Secrets and variables → Actions* ga 4 ta secret qo'shing: `KEYSTORE_B64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` (batafsil: README.md, \"Ilovani yig'ish\"). Shundan keyin build `app-release.apk` ham beradi va keyingi versiyalar ustidan yangilanadi. **Keystore faylini yo'qotmang.**
4. Ilovada: til → **Smart Life (oson)**: User Code yozing, QR ni Smart Life bilan skanerlang, nasosni ro'yxatdan tanlang. (Eski usul: «Developer kalitlari» — Access ID/Secret/Region.) Batareya cheklovini o'chiring (Sozlama'da tugma bor).

## 5. Keyingi yangilanishlar
Yangi versiyada o'zgargan fayllarni repozitoriyga qayta yuklang (Add file → Upload files, bir xil nomlilar almashadi) — Actions yangi APK yig'adi.

## Telegram orqali yangilash (qisqacha)
1. Build'dan oldin `android/app/update-channel.properties` faylida `TG_BOT_TOKEN=` dan keyin bot tokenini yozing (GitHub'da faylni oching → qalam belgisi → Commit). Repozitoriy **Private** bo'lsin.
2. Yangi versiya: `android/app/build.gradle` da `versionCode` +1, `versionName` oshiring → yuklang → Artifacts'dan `MangoMonitor-X.Y.Z.apk` → kanalga **fayl** qilib yuboring, izohiga `vX.Y.Z` yozing → **pin qiling**.
3. Telefonlarda ilova avtomatik topadi va yangilashni majburlaydi.
