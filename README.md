# La Prima Mery

App web instalable (PWA) para pedir ropa de fútbol retro: camisetas, pantalones y chaquetas.

**Publicada en:** https://alvarogago-lang.github.io/retro-football-wear/

## Qué hace

- **Usuarios:** ven el catálogo (filtros por tipo, texto y modelo), eligen tallas S–4XL y cantidad, piden un pedido por modelo y pagan con PayPal (simulado o PayPal Sandbox).
- **Administradores:** publican y editan modelos con fotos (se mejoran al subirlas), gestionan tipos de modelo, crean y gestionan cuentas, ven el panel de unidades por modelo y talla para encargar lotes de fabricación, registran pagos y confirman pedidos con plazo de entrega opcional.
- **Avisos:** buzón con notificaciones y copia de correos; notificaciones del sistema y cambios en tiempo real entre dispositivos.
- **Instalable** en PC (Chrome/Edge), Android e iPhone, con interfaz adaptada al móvil.

## Cómo está hecha

- Un único `index.html` con Tailwind CSS y JavaScript, sin paso de compilación.
- **Supabase** para el inicio de sesión, la base de datos (Postgres con seguridad por filas), las fotos (Storage) y el tiempo real. El esquema está en [`supabase/schema.sql`](supabase/schema.sql).
- **GitHub Pages** sirve los archivos estáticos.
- `manifest.webmanifest` + `sw.js` hacen que se pueda instalar y abrir sin conexión.

La clave de Supabase que aparece en `index.html` es la pública (*publishable*): está pensada para usarse en el navegador y las reglas de seguridad de la base de datos limitan lo que cada usuario puede ver y hacer.

## Contraseñas

- Un administrador puede crear cuentas sin contraseña: la primera vez que el usuario intenta entrar recibe un email para crearla. Cualquier administrador puede crear otros administradores.
- **Recuperación por email:** «¿Olvidaste tu contraseña?» en la pantalla de acceso.
- **Recuperación por SMS (opcional):** requiere un proveedor de SMS configurado en Supabase (Authentication → Sign In / Providers → Phone) y activar la opción en Ajustes de la app. Las cuentas necesitan teléfono.
- **Emails a todos los usuarios:** el servidor de correo incluido en Supabase solo envía a los miembros del equipo del proyecto. Para que lleguen a cualquier usuario hay que configurar un SMTP propio en Supabase (Authentication → Emails → SMTP Settings), por ejemplo Brevo o Resend, que tienen plan gratuito.

Migraciones de la base de datos, en orden: `supabase/schema.sql`, `supabase/002_contrasenas.sql`.

## Aviso de modelos nuevos

Al publicar un modelo (o con el botón 📣 de cada modelo), todos los usuarios reciben una notificación en la app y el administrador envía un email desde su propio correo: la app lo abre ya redactado con los destinatarios en copia oculta, repartidos en tandas si son muchos.

La Edge Function `supabase/functions/notify-new-model` (envío automático con Brevo) queda desplegada pero sin uso: se puede activar más adelante si se configura un proveedor de correo.

## Solicitudes de cuenta

- En la pantalla de acceso, **«Crear cuenta»** pide nombre completo, usuario, email y teléfono (todos obligatorios).
- La cuenta queda **pendiente**: no puede ver el catálogo ni pedir. Los administradores reciben una notificación y la validan o rechazan en Usuarios → Solicitudes pendientes.
- Emails: al solicitar, «Confirm sign up» (pendiente de validación + confirmar email); al validar, «Reset password» (activar y crear contraseña). Las plantillas en español están en `supabase/plantillas-email/` y solo se pueden aplicar con un SMTP propio en Supabase.

Migraciones de la base de datos, en orden: `supabase/schema.sql`, `supabase/002_contrasenas.sql`, `supabase/003_solicitudes.sql`, `supabase/004_inactividad.sql`, `supabase/005_contacto.sql`.

## Pestaña Pedidos (administrador)

Tres tablas de 10 filas con paginación y un filtro en cada columna: **Pedidos activos** (además: texto, tipo, modelo, estado y fechas), **Pedidos por usuario** (último mes, últimos 6 meses, importe y último pedido) y **Registro de pagos** (fechas, usuario y cuenta PayPal).

## Bajas por inactividad

Cada día (pg_cron, 07:00 UTC) se proponen para baja los usuarios sin pedidos en 6 meses: los administradores reciben una notificación (y copia en el buzón) y deciden en Usuarios → Propuestas de baja: **dar de baja**, **eliminar definitivamente** o **mantener** (no se vuelve a proponer en 6 meses). Cualquier usuario se puede dar de baja o eliminar en cualquier momento.

## Contacto e invitaciones

- **Usuario → pestaña Contacto:** envía consultas a los administradores y ve la conversación. **Administrador → pestaña Mensajes:** responde o marca como resuelta. Cada mensaje llega por notificación y por email.
- **Invitar a un amigo:** email con enlace a `?registro`, que abre «Crear cuenta» (máximo 10 invitaciones al día por usuario). También se puede compartir el enlace (WhatsApp, etc.).
- Los emails los envía la Edge Function `supabase/functions/send-mail` desde laprimamery@gmail.com por SMTP (puerto 465). Secreto necesario: `SMTP_PASS` (contraseña de aplicación de Google de laprimamery@gmail.com).
