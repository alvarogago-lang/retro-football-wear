# Retro Football Wear

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
