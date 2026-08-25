# Guía de configuración

Los tres servicios se configuran de forma independiente. Podés hacerlos en
cualquier orden, pero para probar el flujo completo necesitás los tres.

## 1. WhatsApp vía Twilio

Se eligió Twilio en vez de conectar directo con Meta porque el paso de
verificación por SMS de Meta for Developers no estaba entregando código a
números argentinos (probado con dos números distintos, sin éxito) — es un
problema conocido de disponibilidad de Meta, no algo del lado del usuario.
El código quedó armado contra la API de Twilio (paquete `twilio` de npm);
si en el futuro se resuelve el problema de Meta y se quiere conectar
directo, hay que reescribir `src/whatsapp/client.ts` y `webhook.ts` contra
la Cloud API de Meta (quedó como referencia una versión anterior en el
historial de git de este repo).

**Importante — mismo número, un solo lugar a la vez:** un número de
WhatsApp solo puede estar conectado a *una* cosa: o a la app normal de
WhatsApp/WhatsApp Business (para chatear a mano desde el celular), o a la
WhatsApp Business Platform (la API — vía Twilio, Meta directo, o cualquier
otro proveedor). No se puede tener las dos cosas a la vez con el mismo
número, y esto es una regla de WhatsApp, no de Twilio. Por eso para probar
usamos el **sandbox** de Twilio (un número compartido, sin tocar ningún
número real) — la decisión de qué número usar en producción (uno nuevo
dedicado al bot, o migrar el actual) se toma después, con el agente ya
funcionando como demostración.

### Sandbox (para probar ahora, sin compromiso)

1. Registrate en [twilio.com/try-twilio](https://www.twilio.com/try-twilio).
2. En la consola, andá a **Messaging → Try it out → Send a WhatsApp
   message** (o buscá "WhatsApp Sandbox").
3. Desde tu WhatsApp personal, mandale al número del sandbox el mensaje
   `join <palabra-clave>` que te indique la consola — así tu número queda
   habilitado para probar contra el sandbox.
4. En el dashboard principal de la consola, copiá el **Account SID** y el
   **Auth Token** → `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`.
5. El número del sandbox (con formato `whatsapp:+1...`) → `TWILIO_WHATSAPP_FROM`.
6. En la config del sandbox ("Sandbox Settings"), en **"When a message
   comes in"** pegá la URL pública de tu servidor + `/webhook`
   (`https://tu-dominio/webhook`) con método `POST`. Esa misma URL va en
   `PUBLIC_WEBHOOK_URL` del `.env` (Twilio la necesita para validar la
   firma `X-Twilio-Signature`).
7. Para local, exponé el puerto con un túnel (ngrok, cloudflared) y usá esa
   URL pública tanto en Twilio como en `PUBLIC_WEBHOOK_URL`.

El sandbox tiene límites (hay que re-unirse cada tanto, mensajes con un
watermark, compartido con otros desarrolladores) — sirve solo para probar,
no para producción real.

### ⚠️ Cuenta Trial: no manda mensajes salientes — confirmado en vivo

Con la cuenta de Twilio en modo **Trial**, cualquier intento de mandar un
mensaje (con o sin Content Template) falla:

- Sin plantilla: `21654 "ContentSid Required"`.
- Con una plantilla propia (creada en Content Template Builder): `21655
  "The ContentSid is Invalid"` — y someterla a aprobación de WhatsApp pide
  un WhatsApp Sender real (verificación de negocio de Meta, justo lo que
  el sandbox debería evitar).
- Pegándole directo a `content.twilio.com` (Content API): `20003 "This
  feature is not available on a Trial account."`

La solución fue **sacar la cuenta de Trial** (Consola → botón "Upgrade",
cargar tarjeta, mínimo ~USD 20). Una vez "Active", el envío de texto libre
(`Body`, sin `ContentSid`) funcionó normalmente — no hizo falta la
plantilla para nada. Si al recibir el 21654 la respuesta de Twilio incluye
además "Primary compliance profile is not approved", esperá un minuto: el
perfil de Trust Hub (Consola → Trust Hub → Profiles) se aprueba solo al
completar el upgrade, y una vez en estado "Approved" el envío empieza a
andar. Este repo ya no depende de la plantilla (`TWILIO_CONTENT_SID` queda
vacío en `.env`), pero el código en `src/whatsapp/client.ts` la sigue
soportando por si alguna cuenta la vuelve a necesitar.

### Producción (más adelante)

Cuando el agente ya esté probado y se decida qué número usar: en la
consola de Twilio, **Messaging → Senders → WhatsApp senders**, se solicita
un número de WhatsApp productivo (uno nuevo comprado en Twilio, o migrando
uno existente — proceso guiado por Twilio, incluye verificación de negocio
de Meta). Ahí se actualiza `TWILIO_WHATSAPP_FROM` con el número real.

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
4. **Escritura — dos mecanismos distintos, confirmados en vivo:**
   - `POST /webcontact/` (documentado en
     [developers.tokkobroker.com](https://developers.tokkobroker.com), guía
     "Formulario de contacto") **funciona** — devuelve `201`. Es el mismo
     endpoint que usan los portales chicos/sitios propios para cargar
     leads. Body: `{name, phone, text, tags, properties?, developments?}`.
     Pero **no crea un Contacto**: crea una "Consulta" que aparece en el
     panel en **Consultas → Pendientes**, y hay que aprobarla a mano con el
     botón "Crear un nuevo contacto" — no existe forma de saltear ese paso
     por API. Es así para cualquier origen sin integración privilegiada
     (Zonaprop sí tiene una integración propia más profunda que crea el
     contacto directo — no está disponible para integraciones custom).
   - `PATCH`/`POST` directo contra `/contact/{id}/` (para notas o cambiar
     `opportunity_status` de un contacto ya existente) **está bloqueado**:
     devuelve el texto plano `GET` en vez de JSON. Parece un firewall/CDN
     delante de `www.tokkobroker.com` que solo deja pasar `GET` en esa
     ruta — no es (solo) un tema de permisos de la key, porque el mismo
     bloqueo aparece tanto en `/contact/{id}/` como en `POST /contact/`
     (creación directa), mientras que `/webcontact/` sí pasa. Si en algún
     momento Tokko habilita esto, `updateContactStage` en
     `src/tokko/client.ts` ya está listo para funcionar sin cambios — probá
     con:
     ```bash
     curl -i -X PATCH "https://www.tokkobroker.com/api/v1/contact/ID_DE_UN_CONTACTO/?key=TU_API_KEY&format=json" \
       -H "Content-Type: application/json" -d '{"opportunity_status": 344781}'
     ```
     Si el `HTTP/2` de la respuesta ya no es `201`/`GET` como body sino el
     contacto actualizado, avisale a quien mantenga este repo.
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

## 4. Escalamiento a un humano

El agente tiene una herramienta (`escalate_to_human`) para avisarle a
alguien del equipo por WhatsApp cuando no puede resolver una consulta. Es
un mensaje saliente más, así que usa el mismo `TWILIO_WHATSAPP_FROM` que ya
configuraste.

1. En `.env`, completá `HUMAN_ESCALATION_WHATSAPP_NUMBERS` con el/los
   número/s del equipo en formato E.164 (ej. `+5491122334455`), separados
   por coma si son varios.
2. **No es un grupo de WhatsApp**: la WhatsApp Business API (ni vía Twilio
   ni directo con Meta) permite mandar mensajes a un grupo por API — solo a
   números individuales, uno por uno. Si querés que llegue a varias
   personas, agregalas todas separadas por coma y cada una recibe el
   mensaje por separado.
3. **Mientras estés en el sandbox de Twilio**: cada número que quieras que
   reciba estos avisos tiene que sumarse al sandbox igual que hiciste vos
   (mandarle `join <palabra-clave>` al número del sandbox desde ese
   WhatsApp) — si no, Twilio no le va a poder mandar el mensaje. Esto deja
   de ser necesario una vez que se pase a un número de WhatsApp productivo.

## 5. Claude (Anthropic)

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
