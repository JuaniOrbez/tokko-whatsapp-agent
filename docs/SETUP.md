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
3. Junto con la API key, Tokko debería darte acceso a la documentación
   específica de tu cuenta
   (típicamente `https://www.tokkobroker.com/api/v1/docs/?key=TU_API_KEY`).
   **Es importante que la revises** antes de producción: este scaffold
   implementa `/property/search/` y `/property/{id}/` con confianza (son los
   endpoints públicos estándar), pero los de **contacto, notas y
   oportunidades** en `src/tokko/client.ts` están marcados `VERIFICAR` — hay
   que confirmar ahí los nombres de endpoint/campos exactos porque no tuve
   forma de verificarlos sin acceso a internet al escribir el código.
4. **IDs de operación** (venta/alquiler): en Tokko cada "operation_type" es
   un ID numérico específico de tu cuenta. Para encontrarlos, lo más simple
   es pedirle a tu ejecutivo de Tokko la lista, o hacer una búsqueda de
   prueba sin filtro de operación y mirar el campo `operations[].operation_type`
   de los resultados. Completá `TOKKO_OPERATION_ID_SALE` /
   `TOKKO_OPERATION_ID_RENT` en `.env`. Si los dejás vacíos, la búsqueda
   simplemente no filtra por tipo de operación.
5. **Etapas del workflow de Oportunidades**: entrá al panel de Oportunidades
   en Tokko y anotá los IDs (o nombres, según cómo los use la API) de cada
   etapa de tu embudo. Completá `TOKKO_STAGE_NEW`, `TOKKO_STAGE_CONTACTED`,
   `TOKKO_STAGE_QUALIFIED`, `TOKKO_STAGE_VISIT_SCHEDULED`,
   `TOKKO_STAGE_NEGOTIATION`, `TOKKO_STAGE_WON`, `TOKKO_STAGE_LOST` en
   `.env`. Una etapa que quede vacía simplemente no se usa (el agente lo
   loguea y sigue sin cortar la conversación).

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
