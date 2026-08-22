# Guía de configuración

Los tres servicios se configuran de forma independiente. Podés hacerlos en
cualquier orden, pero para probar el flujo completo necesitás los tres.

## 1. WhatsApp Business Cloud API (Meta)

1. Entrá a [developers.facebook.com](https://developers.facebook.com) con la
   cuenta de Facebook/Meta de la empresa y creá una **app de tipo "Business"**.
2. Agregá el producto **WhatsApp** a la app.
3. En **WhatsApp > API Setup** vas a encontrar:
   - Un **número de teléfono de prueba** (para desarrollo, gratis, con
     destinatarios limitados a números que agregues a la lista de prueba), o
     tu propio número de WhatsApp Business verificado para producción.
   - El **Phone Number ID** → va en `WHATSAPP_PHONE_NUMBER_ID`.
   - Un **token de acceso temporal** (24hs, para probar) o generá uno
     permanente creando un **System User** en Business Settings con permiso
     `whatsapp_business_messaging` → va en `WHATSAPP_ACCESS_TOKEN`.
4. Inventá un valor cualquiera (una contraseña larga) para
   `WHATSAPP_VERIFY_TOKEN` — lo vas a pegar en dos lugares: acá y en la
   configuración del webhook en el paso siguiente.
5. En **WhatsApp > Configuration**, configurá el **Webhook**:
   - URL: `https://tu-dominio-publico/webhook`
   - Verify token: el mismo valor de `WHATSAPP_VERIFY_TOKEN`.
   - Suscribite al campo `messages`.
6. (Recomendado) En **App Settings > Basic**, copiá el **App Secret** →
   `WHATSAPP_APP_SECRET`, así el servidor valida que los webhooks realmente
   vienen de Meta.
7. Para producción necesitás pasar por la verificación de negocio de Meta
   (Business Verification) y usar un token permanente — el token temporal
   de prueba expira a las 24hs.

## 2. Tokko Broker

1. Entrá al panel de Tokko con un usuario administrador.
2. Buscá la sección de **API** (según el plan puede estar en Configuración
   general, o hay que pedírsela al ejecutivo de cuenta de Tokko). Ahí vas a
   encontrar tu **API Key** → `TOKKO_API_KEY`.
3. `https://www.tokkobroker.com/api/v1/docs/?key=TU_API_KEY` **no existe**
   (lo probamos, da 404) — no hay documentación pública autoservicio. Lo que
   sí verificamos en vivo contra una cuenta real:
   - `/property/` (listado paginado) funciona y trae todos los campos que
     usa este agente (`operations`, `photos`, `location`, `room_amount`,
     `public_url`, etc.) — es el que usa `tokkoClient.searchProperties`,
     filtrando en el servidor Node.
   - `/property/search/` **exige** un parámetro `data`, pero no logramos
     determinar el formato exacto que espera sin la documentación de la
     cuenta — por eso el cliente no lo usa.
   - **`/contact/`** (listado) también funciona igual — y ahí encontramos
     que **no existe un recurso "Oportunidad" separado**: el estado del
     embudo vive en el campo `opportunity_status` de cada contacto
     (`{id, name, color, is_closed_status}`).
4. **⚠️ La API key es de solo lectura — confirmado en vivo.** Probamos
   `PATCH` y `POST` contra `/contact/{id}/` y ambos devuelven una respuesta
   de error (el texto `GET`), o sea que con esta key **no se puede crear
   contactos, agregar notas ni cambiar el estado de oportunidad por API**.
   Solo funciona la lectura (buscar propiedades y contactos). El agente ya
   está armado para tolerar esto — si la escritura falla, sigue respondiendo
   la consulta igual y solo se salta la parte de CRM, logueando una
   advertencia — pero para que el CRM funcione de punta a punta necesitás
   **escribirle a tu ejecutivo de cuenta de Tokko (o a soporte) y pedirles
   explícitamente que habiliten permisos de escritura en la API v1** para
   crear/actualizar contactos. Volvé a probar con el mismo `curl` de abajo
   una vez que te confirmen que lo activaron:
   ```bash
   curl -X PATCH "https://www.tokkobroker.com/api/v1/contact/ID_DE_UN_CONTACTO/?key=TU_API_KEY&format=json" \
     -H "Content-Type: application/json" -d '{"opportunity_status": 344781}'
   ```
   Si devuelve el contacto actualizado (no el texto `GET`), ya podés
   desmarcar esta limitación.
5. **IDs de operación** (venta/alquiler): confirmado en una cuenta real que
   **Venta = `operation_id: 1`**. Para Alquiler, buscá en el JSON de
   `/property/` una propiedad publicada en alquiler y fijate su
   `operations[].operation_id`. Completá `TOKKO_OPERATION_ID_SALE` (podés
   usar `1` como punto de partida) y `TOKKO_OPERATION_ID_RENT` en `.env`. Si
   los dejás vacíos, la búsqueda simplemente no filtra por tipo de operación.
6. **Etapas del workflow de Oportunidades**: confirmadas en vivo contra el
   panel de Oportunidades. Completá en `.env` (ver `.env.example` para los
   nombres de variable): Aun no fueron Contactados, Sin Seguimiento,
   Contactar, Primer Contacto hecho, Volver a Contactar, Evolucionando,
   Tomar Accion (estado por defecto de todo contacto nuevo), Congelado y
   Cerrado. Si tu cuenta tiene etapas distintas a estas, repetí el proceso:
   entrá a un contacto de prueba en el panel, cambiale el estado, y pedí
   `/contact/{id}/?key=...&format=json` para leer el `id` de
   `opportunity_status` en cada paso.

## 3. Google Drive (cuenta de servicio)

1. En [Google Cloud Console](https://console.cloud.google.com), creá (o
   reusá) un proyecto y habilitá la **Google Drive API**.
2. Creá una **cuenta de servicio** (IAM & Admin > Service Accounts).
3. Generá una **clave JSON** para esa cuenta de servicio y descargala.
   Guardala en el repo (no la subas a git) como `google-service-account.json`
   o donde prefieras, y apuntá `GOOGLE_SERVICE_ACCOUNT_FILE` a esa ruta.
4. En Google Drive, **compartí la carpeta** que contiene los folletos/planos
   con el email de la cuenta de servicio (algo como
   `nombre@proyecto.iam.gserviceaccount.com`), con permiso de **Lector**.
5. Copiá el **ID de la carpeta** (de la URL de Drive,
   `drive.google.com/drive/folders/ESTE_ID`) → `GOOGLE_DRIVE_FOLDER_ID`.

El agente comparte archivos poniéndolos como "cualquiera con el link puede
ver" al momento de enviarlos — si preferís no hacer eso (por ejemplo,
archivos confidenciales), hay que cambiar `ensurePublicLink` en
`src/drive/client.ts` por otro mecanismo de distribución.

## 4. Claude (Anthropic)

1. Conseguí una API key en [console.anthropic.com](https://console.anthropic.com)
   → `ANTHROPIC_API_KEY`.

## Dónde alojar el servidor

Este proyecto es un servidor Node/Express normal — se puede desplegar en
cualquier plataforma que corra Node.js con una URL HTTPS pública (Render,
Railway, Fly.io, una VM propia con un proxy inverso, etc.). Los únicos
requisitos:

- Node.js 18+.
- Variables de entorno del `.env.example` cargadas de forma segura (no en
  el repo).
- El archivo JSON de la cuenta de servicio de Google disponible en el
  filesystem del servidor (o adaptar `GOOGLE_SERVICE_ACCOUNT_FILE` para leer
  credenciales desde una variable de entorno, si la plataforma no permite
  subir archivos).
