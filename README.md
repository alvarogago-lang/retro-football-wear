# La Prima Mery

App web instalable (PWA) para pedir ropa de fútbol retro: camisetas, pantalones y chaquetas.

**Publicada en:** https://alvarogago-lang.github.io/retro-football-wear/

## Qué hace

- **Usuarios:** ven el catálogo (filtros por tipo, texto y modelo; fotos ampliables deslizando), eligen tallas S–4XL y cantidad y envían una solicitud por modelo. El pago se hace fuera de la app (ver «Solicitudes y pago»).
- **Administradores:** publican y editan modelos con fotos (se mejoran al subirlas), gestionan tipos de modelo, crean y gestionan cuentas, ven el panel de unidades por modelo y talla para encargar lotes de fabricación, aprueban solicitudes y validan pagos con fecha de entrega.
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

Tres tablas de 10 filas con paginación y un filtro en cada columna: **Pedidos activos** (estado y acciones Aprobar / Validar pago), **Pedidos por usuario** (solo pedidos con pago confirmado: último mes, últimos 6 meses, importe y último pedido) y **Registro de solicitudes y confirmación de pago** (fecha, usuario, fecha de aprobación de la solicitud, fecha de aprobación del pago e importe; «Pendiente» si falta).

## Bajas por inactividad

Cada día (pg_cron, 07:00 UTC) se proponen para baja los usuarios sin pedidos en 6 meses: los administradores reciben una notificación (y copia en el buzón) y deciden en Usuarios → Propuestas de baja: **dar de baja**, **eliminar definitivamente** o **mantener** (no se vuelve a proponer en 6 meses). Cualquier usuario se puede dar de baja o eliminar en cualquier momento.

## Contacto e invitaciones

- **Buzón (campana) → Mensajes:** junto a Notificaciones y Correo. El administrador ve todas las conversaciones (abiertas/todas), responde, marca como resuelta o inicia una nueva; el usuario ve las suyas y responde. El usuario también abre consultas desde la pestaña **Contacto**. Cada mensaje llega por notificación y por email.
- **Invitar a un amigo:** email con enlace a `?registro`, que abre «Crear cuenta» (máximo 10 invitaciones al día por usuario). También se puede compartir el enlace (WhatsApp, etc.).
- Los emails los envía la Edge Function `supabase/functions/send-mail` desde laprimamery@gmail.com por SMTP (puerto 465). Secreto necesario: `GMAIL_APP_PASSWORD` (contraseña de aplicación de Google de laprimamery@gmail.com; no sirve la contraseña normal).

## Ofertas

En Modelos, el botón **Oferta** (debajo de Editar) activa o desactiva una oferta por modelo: **descuento %**, **por unidades** (lleva N y paga M, p. ej. 3x2) o **tiempo limitado** (descuento con cuenta atrás en días u horas, que se desactiva sola al terminar). En el catálogo los modelos en oferta salen los primeros, con una etiqueta sobre la foto y el precio rebajado. Cada pedido guarda la oferta con la que se hizo, así que su precio no cambia después.

## Solicitudes y pago (fuera de la app)

1. **Solicitado:** el usuario envía la solicitud. Aviso en la app a los administradores y email al usuario, a los administradores y a laprimamery@gmail.com.
2. **Aprobado · pendiente de pago:** el administrador la aprueba (Pedidos → Aprobar). El usuario recibe notificación y email con el texto fijo: depósito por PayPal a **daniordo191119@icloud.com** e importe. Desde aquí el usuario ya no puede cambiar ni cancelar la solicitud.
3. **Pago comunicado:** el usuario pulsa en Mis pedidos «Ya he pagado: solicitar confirmación del pago» (lo cambia el servidor, en send-mail) y se avisa a los administradores.
4. **Pago confirmado:** el administrador comprueba el pago y lo valida (Pedidos → Validar pago) indicando la fecha de entrega; el usuario recibe notificación y email.

La cuenta de PayPal y el texto están en `PAYPAL_ACCOUNT` / `APPROVAL_TEXT` de `index.html` y de `supabase/functions/send-mail/index.ts`. La Edge Function `paypal` y la tabla `payments` quedan sin uso.

## Código QR

«Invitar a un amigo» e «Instalar app» muestran un QR (librería qrcode-generator) que lleva a la app; el de la invitación abre directamente «Crear cuenta».

## Emails automáticos (desde laprimamery@gmail.com)

- **Modelo nuevo** y **oferta activada o cambiada** → a todos los usuarios activos (copia oculta, tandas de 50) + notificación en la app.
- **Solicitud**, **aprobación**, **pago comunicado** y **pago validado**: ver «Solicitudes y pago».
- **Mensajes**: el administrador puede iniciar una conversación (Buzón → Mensajes → Nueva conversación). Cada mensaje llega por la app y por email al usuario y a los administradores, con copia oculta a laprimamery@gmail.com.
