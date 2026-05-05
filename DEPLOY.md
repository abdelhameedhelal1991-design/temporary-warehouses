# نشر تطبيق مخازن التخزين المؤقت أونلاين

## الاختيار الذي سنستخدمه

- قاعدة البيانات: Supabase
- الاستضافة: Render أو Railway أو أي VPS يدعم Node.js
- أمر التشغيل: `npm start`

## 1. تجهيز Supabase

1. أنشئ مشروع Supabase.
2. افتح SQL Editor.
3. انسخ محتوى ملف `supabase-schema.sql` وشغله.
4. من Project Settings > API احصل على:
   - `SUPABASE_URL`
   - `service_role key`

## 2. إعداد الاستضافة

على Render أو Railway:

- Build command: لا شيء أو `npm install`
- Start command: `npm start`
- Environment variables:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `HOST=0.0.0.0`

الاستضافة ستضيف `PORT` تلقائيًا غالبًا.

## 3. التأكد من التشغيل

افتح:

```text
https://your-domain/api/health
```

لازم يظهر:

```json
{
  "ok": true,
  "storage": "supabase"
}
```

## ملاحظة أمان

مفتاح `SUPABASE_SERVICE_ROLE_KEY` يجب أن يبقى في إعدادات السيرفر فقط، ولا يوضع داخل ملفات الواجهة.
