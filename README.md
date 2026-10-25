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
