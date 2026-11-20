# Fiore del frutto API

API de pruebas compatible con el frontend React publicado. Usa el esquema privado `fiore` en el proyecto Supabase `fiore-del-frutto-dev`.

La migración `sql/001_schema.sql` ya está aplicada al proyecto de pruebas. En una instalación nueva, aplícala una vez. Crea un usuario PostgreSQL con acceso de inicio de sesión que herede `fiore_api` y configura su conexión en `DATABASE_URL`. Guarda la contraseña como secreto del servicio.

Configura `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAILS` y `FRONTEND_ORIGIN` en Render. Para el frontend publicado, el origen es `https://fiore-del-frutto-react.vercel.app`. Usa Node.js 22, `npm ci` y `npm start`.

Comprueba `/api/health`, `/api/products` y `/api/store`. Para probar pedidos desde la tienda, configura Google Auth en el proyecto nuevo y autoriza el retorno `https://fiore-del-frutto-react.vercel.app/mi-cuenta`. En Vercel configura `VITE_API_URL`, `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` y vuelve a desplegar.
