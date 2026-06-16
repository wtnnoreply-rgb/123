# خدمة WhatsApp (Baileys)

خدمة Node.js مستقلة لإرسال رسائل WhatsApp عبر مكتبة Baileys.

## النشر على Railway

1. **GitHub:** أنشئ مستودع جديد (مثلاً `whatsapp-service`) وارفع محتويات هذا المجلد فقط (ليس المشروع كله).
2. **Railway → New Project → Deploy from GitHub repo** → اختر المستودع.
3. **Variables** أضف:
   - `SERVICE_TOKEN` = رمز سري طويل من اختيارك (مثل: `gh_2025_xY9k...`)
4. **Volumes:** اربط Volume على المسار `/data` (لحفظ جلسة WhatsApp بعد إعادة التشغيل).
5. **Settings → Networking → Generate Domain** → احصل على رابط مثل:
   `https://123-production-a844.up.railway.app`

## ربط رقم WhatsApp

افتح في المتصفح (مع استبدال الرابط والتوكن):

```
https://123-production-a844.up.railway.app/qr
```
أرسل التوكن في Header: `Authorization: Bearer YOUR_TOKEN`

أسهل طريقة: استخدم زر "ربط واتساب" داخل لوحة الإدارة في التطبيق.

## نقاط الـ API

كلها تتطلب Header: `Authorization: Bearer SERVICE_TOKEN`

- `GET /status` → حالة الاتصال
- `GET /qr` → كود QR (data URL) لمسحه من واتساب على هاتفك
- `POST /send` body: `{ "to": "962799999999", "message": "..." }`
- `POST /logout` → فصل الرقم

## ملاحظات

- استخدم رقم WhatsApp **منفصل** (ليس الشخصي) ويُفضّل ألا يكون Business.
- بعد المسح من الهاتف (الإعدادات → الأجهزة المرتبطة → ربط جهاز) سيبقى الرقم متصلاً طالما الخدمة تعمل.
