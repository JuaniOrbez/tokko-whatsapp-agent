# Guía de configuración

Los tres servicios se configuran de forma independiente. Podés hacerlos en
cualquier orden, pero para probar el flujo completo necesitás los tres.

Una aclaración importante sobre qué se edita dónde: `.env` es para
credenciales e infraestructura (claves de API, tokens, rutas de archivos) —
cambiarlo requiere reiniciar el servidor. Las cosas de negocio del día a
día (números de escalamiento, IDs de Tokko, el archivo de links de
Zonaprop) se editan **en caliente**, sin reiniciar nada, desde el panel
**`/admin`** — ver la última sección de esta guía.

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
     devuelve `405 Method Not Allowed` con header `Allow: GET` (confirmado en
     vivo el 2026-08-26). No es un tema de permisos de la key — soporte de
     Tokko lo confirmó directamente por chat: **la API no es bidireccional**,
     sirve para mostrar inventario y recibir consultas nuevas, pero no para
     editar un contacto existente. No hay forma de escribir esto por API,
     punto — no queda nada pendiente de reintentar acá.
     Por eso este agente no intenta escribirlo: cuando la charla deja claro
     un cambio de etapa, queda anotado en un registro propio (ver
     `src/agent/stageLog.ts`) que se ve en **`/admin/contacts`** — ahí
     alguien del equipo revisa cada contacto con su etapa sugerida y la
     aplica a mano en Tokko.
5. **IDs de operación** (venta/alquiler): confirmado en una cuenta real que
   **Venta = `operation_id: 1`**. Para Alquiler, buscá en el JSON de
   `/property/` una propiedad publicada en alquiler y fijate su
   `operations[].operation_id`. Estos IDs se cargan desde el panel
   **`/admin/config`** (sección "Tokko — operaciones"), no en `.env` — si los
   dejás vacíos, la búsqueda simplemente no filtra por tipo de operación.
6. **Etapas del workflow de Oportunidades**: se cargan desde **`/admin/config`**
   (sección "Tokko" → "Etapas del workflow de Oportunidades") — es una
   lista libre, no fija: por cada etapa cargás una **Clave** (identificador
   interno que usa el agente, sin espacios, ej. `tomar_accion`), un
   **Nombre** (lo que ve el agente para entender qué significa) y el **ID
   Tokko** real de esa cuenta. Hay filas vacías de más al final para
   agregar etapas nuevas, y para sacar una alcanza con borrarle la Clave.
   Para conseguir el ID real de cada etapa: entrá a un contacto de prueba
   en el panel de Tokko, cambiale el estado, y pedí
   `/contact/{id}/?key=...&format=json` para leer el `id` de
   `opportunity_status` en cada paso. El **ID Tokko** solo sirve como
   referencia para quien aplica el cambio a mano (ver punto anterior) — no
   se usa para escribir nada por API.

## 3. Google Drive (cuenta de servicio)

1. En [Google Cloud Console](https://console.cloud.google.com), creá (o
   reusá) un proyecto y habilitá la **Google Drive API**.
2. Creá una **cuenta de servicio** (IAM & Admin > Service Accounts).
3. Generá una **clave JSON** para esa cuenta de servicio y descargala.
   Guardala en el repo (no la subas a git) como `google-service-account.json`
   o donde prefieras, y apuntá `GOOGLE_SERVICE_ACCOUNT_FILE` a esa ruta.
4. En Google Drive, **compartí la carpeta** que contiene los folletos/planos
   con el email de la cuenta de servicio (algo como
   `nombre@proyecto.iam.gserviceaccount.com`), con permiso de **Editor** (no
   alcanza con Lector: `ensurePublicLink` en `src/drive/client.ts` necesita
   poder cambiar los permisos de cada archivo para generar el link público,
   y eso requiere Editor). Ese permiso se hereda a todo lo que haya adentro,
   así que podés organizarla con subcarpetas sin problema.
5. (Opcional) Si querés que la búsqueda se limite a esa carpeta puntual en
   vez de a todo lo que la cuenta de servicio tenga compartido, copiá el
   **ID de la carpeta** de la URL de Drive
   (`drive.google.com/drive/folders/ESTE_ID`) y cargalo en **`/admin/config`**
   (sección "Google Drive" → "Carpeta donde buscar archivos"). Busca también
   dentro de las subcarpetas. Si lo dejás vacío, no hay ningún problema:
   simplemente busca en todo lo compartido.

El agente comparte archivos poniéndolos como "cualquiera con el link puede
ver" al momento de enviarlos — si preferís no hacer eso (por ejemplo,
archivos confidenciales), hay que cambiar `ensurePublicLink` en
`src/drive/client.ts` por otro mecanismo de distribución.

### Links de Zonaprop (opcional)

Tokko no expone por API el link de la publicación en Zonaprop (ver
comentario en `findZonapropLink` de `src/drive/client.ts`) — es un dato que
genera Zonaprop, no Tokko. Si querés que el agente pueda pasarlo cuando se
lo pidan, armá un archivo de texto plano (`.txt` o `.csv`) en la misma
carpeta de Drive, con el nombre que tengas configurado en **`/admin/config`**
(sección "Google Drive" — por defecto **`Links Zonaprop`**), con una línea
por propiedad/emprendimiento:

```
LA VECINDAD Freire,https://www.zonaprop.com.ar/propiedades/clasificado/...
Otra propiedad,https://www.zonaprop.com.ar/propiedades/clasificado/...
```

Es mantenimiento manual (hay que cargar cada línea a mano), así que es
opcional — si no armás el archivo, `get_zonaprop_link` simplemente no
encuentra nada y el agente lo dice con naturalidad.

## 4. Escalamiento a un humano

El agente tiene una herramienta (`escalate_to_human`) para avisarle a
alguien del equipo por WhatsApp cuando no puede resolver una consulta. Es
un mensaje saliente más, así que usa el mismo `TWILIO_WHATSAPP_FROM` que ya
configuraste.

1. En **`/admin/config`** (sección "Equipo" — la misma lista que se usa
   para coordinar visitas, ver punto 5), cargá una fila por persona:
   **nombre** (con apellido si hay otra con el mismo nombre de pila),
   **teléfono** en formato E.164 (ej. `+5491122334455`, el único campo
   obligatorio) y **motivo** opcional (ej. "Consultas técnicas",
   "Consultas generales") — mail y calendario son para la parte de
   visitas, no hacen falta solo para escalar.
2. El motivo le sirve al agente para elegir a quién avisar: cuando escala,
   además de la pregunta del cliente elige una categoría (armada
   dinámicamente a partir de los motivos que hayas cargado, igual que las
   etapas de Tokko) y avisa solo a las personas con ese motivo exacto. Si
   dejás el motivo vacío, esa persona recibe lo que no matchee ninguna
   categoría específica — y si nadie tiene el motivo elegido (o
   directamente no cargaste motivos), avisa a todos, para que la consulta
   nunca quede sin nadie enterado.
3. **No es un grupo de WhatsApp**: la WhatsApp Business API (ni vía Twilio
   ni directo con Meta) permite mandar mensajes a un grupo por API — solo a
   números individuales, uno por uno. Cada fila de la lista es un número
   individual, no una lista separada por coma.
4. **Mientras estés en el sandbox de Twilio**: cada número que quieras que
   reciba estos avisos tiene que sumarse al sandbox igual que hiciste vos
   (mandarle `join <palabra-clave>` al número del sandbox desde ese
   WhatsApp) — si no, Twilio no le va a poder mandar el mensaje. Esto deja
   de ser necesario una vez que se pase a un número de WhatsApp productivo.

### Que la respuesta del humano vuelva al cliente

Cuando alguien del equipo responde el mensaje de alerta **citándolo**
(mantener presionado sobre el mensaje → Responder, en WhatsApp), esa
respuesta se le reenvía automáticamente al cliente que originó la consulta
— no hace falta que el humano haga nada más. Si contesta sin citar el
mensaje (por ejemplo escribiendo directo, sin usar "Responder"), el agente
igual intenta adivinar a qué consulta corresponde usando la última
pendiente para ese número — funciona bien si solo hay una consulta
esperando respuesta, pero si hay varias en simultáneo puede confundirse.
Por eso conviene acostumbrarse a citar siempre el mensaje.

Esto se maneja en memoria (`src/agent/escalation.ts`) y no depende de
Tokko para nada — las consultas pendientes se descartan solas a las 24
horas si nadie contesta.

## 5. Google Calendar (coordinar visitas y reuniones)

El agente puede consultar horarios libres y agendar una visita/reunión
directamente en el calendario de alguien del equipo, con la **misma
cuenta de servicio** que ya creaste para Drive (no hace falta crear una
nueva ni generar otra clave JSON). Cada persona tiene su propio
calendario — el agente cruza la disponibilidad de todos antes de ofrecer
un horario, y agenda en el de quien esté libre justo en ese momento.

1. En [Google Cloud Console](https://console.cloud.google.com), en el
   mismo proyecto que usaste para Drive, habilitá también la **Google
   Calendar API** (Library → buscar "Google Calendar API" → Enable). A
   veces el primer intento tira un error genérico — probá de nuevo, y si
   persiste fijate que el proyecto tenga una cuenta de facturación
   vinculada (activar la prueba gratuita alcanza, no tiene costo).
2. **Por cada persona** que quieras que reciba visitas coordinadas por el
   agente, en [Google Calendar](https://calendar.google.com) con la
   cuenta de esa persona:
   1. Creá un calendario nuevo (recomendado, así no se mezcla con el
      personal) — engranaje ⚙️ → "Crear un calendario nuevo", con su
      nombre, ej. "Visitas — Juan".
   2. Entrá a la configuración de ese calendario → "Compartir con
      determinadas personas" → agregá el email de la cuenta de servicio
      (el mismo que compartiste en Drive, algo como
      `nombre@proyecto.iam.gserviceaccount.com` — lo encontrás en el
      campo `client_email` del JSON que descargaste) con permiso **"Hacer
      cambios en los eventos"**.
   3. En esa misma pantalla, bajá hasta "Integrar calendario" y copiá el
      **ID de calendario** (termina en `@group.calendar.google.com`).
3. En `/admin/config`, sección **"Equipo"** (la misma lista del punto 4),
   completá el campo "Calendario" de esa fila con el ID de ese paso — si
   la persona ya estaba cargada por el escalamiento, sumale el
   calendario ahí mismo, no hace falta una fila aparte. Sección "Visitas
   / Reuniones": ahí se configura la duración de cada visita, el horario
   laboral (hora Argentina) y los **días de la semana** en los que se
   puede agendar (por defecto los 7 días — destildá los que no quieras
   habilitar, ej. fines de semana).

Sin nadie con calendario cargado, `check_visit_availability`/`book_visit`
simplemente le dicen al agente que no hay calendario configurado — sigue
funcionando todo lo demás con normalidad, y el agente escala a un humano
en vez de insistir con coordinar la visita él mismo.

### Avisarle a la persona asignada por WhatsApp

Apenas se agenda una visita, el agente le manda un WhatsApp a quien haya
quedado asignado (al teléfono cargado en su fila del Equipo) con los
datos del cliente, la fecha/hora y el detalle que haya dado. Es un
mensaje saliente más, usa el mismo `TWILIO_WHATSAPP_FROM` de siempre
(mientras estés en el sandbox, ese número también tiene que sumarse
mandando `join <palabra-clave>`).

### El cliente recibe el evento por WhatsApp

Apenas se agenda, el agente le manda al cliente un archivo de calendario
(`.ics`) como adjunto de WhatsApp — lo abre y se le carga solo en el
calendario que use (Google, iPhone, Outlook), sin pedirle ningún dato
extra. No se usa la invitación por mail nativa de Google Calendar: con
una cuenta de servicio sobre un Gmail personal (sin Google Workspace),
Calendar acepta agregar un invitado al evento pero **no manda** el mail
de invitación — es una limitación de la API, no un bug de acá.

El `.ics` se genera al vuelo y se sirve desde el propio servidor
(`GET /ics/:id`, ver `src/calendar/icsRouter.ts`) para que Twilio pueda
descargarlo y adjuntarlo — por eso esto necesita `PUBLIC_WEBHOOK_URL`
configurado en `.env` (el mismo que ya usás para el webhook). Sin esa
variable, la visita se agenda igual, simplemente no se manda el archivo, y
el agente no le va a decir al cliente que se lo mandó.

**Si el archivo no llega aunque `PUBLIC_WEBHOOK_URL` esté bien
configurado**: mandarlo es un paso aparte de agendar la visita en
Calendar (que sí queda hecho siempre) y puede fallar del lado de Twilio
de forma asíncrona — recién se entera el servidor un rato después, no en
el momento. Buscá en la terminal del servidor una línea
`"whatsapp.delivery_status"` con `status` en `failed` o `undelivered`
(trae `errorCode`/`errorMessage` de Twilio) cerca del horario en que se
agendó la visita — ese es el motivo real. Si no aparece ninguna línea así
pero tampoco llegó nada, revisá que `PUBLIC_WEBHOOK_URL` sea alcanzable
públicamente desde internet (no `localhost`) — Twilio necesita poder
descargar el archivo desde ahí.

> **PENDIENTE — ngrok gratis bloquea la descarga del `.ics`.** Si
> `PUBLIC_WEBHOOK_URL` apunta a un túnel de ngrok en el plan gratuito, el
> `errorCode` que vas a ver en `whatsapp.delivery_status` es `63019`
> ("Media failed to download"): ngrok le muestra a Twilio su página de
> advertencia intermedia ("You are about to visit...") en vez del
> archivo, porque Twilio no puede "aceptarla" como haría un navegador y
> nosotros no podemos mandarle un header custom a ese pedido (lo hace
> Twilio del lado de ellos). El resto de la coordinación de visitas
> funciona igual (se agenda en Calendar, se avisa al comercial); solo
> falla la entrega del archivo al cliente. Salidas, sin tocar código:
> pasar a un plan pago de ngrok, o cambiar a otro túnel sin esa pantalla
> (ej. Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:3000`,
> gratis y sin login). Para producción de verdad, mejor un dominio propio
> con hosting fijo en vez de un túnel.

### Reprogramar una visita

Si el cliente pide cambiar la fecha/hora de una visita ya confirmada en
la misma conversación, el agente mueve ESE mismo evento en el calendario
del comercial (en vez de crear uno nuevo y dejar el viejo colgado) y le
manda al cliente un `.ics` actualizado. El comercial recibe un WhatsApp
aparte avisando el cambio ("antes tal hora, ahora tal otra"). Solo se
puede reprogramar la última visita agendada con ese cliente, y el
registro se guarda en memoria del servidor — se pierde si se reinicia el
proceso entre que se agenda y se pide reprogramar (en ese caso el agente
ofrece agendar una nueva en vez de fallar en silencio).

### Pedir a alguien en particular

Si el cliente pide específicamente a alguien ("quiero que me atienda
Martín"), el agente busca ese nombre entre quienes tienen calendario
cargado (sin importar mayúsculas/acentos) y solo mira/agenda en su
calendario — si esa persona no está libre en el horario elegido, no la
reemplaza por otra sin avisar, le cuenta al cliente y propone
alternativas. **Si hay dos personas con el mismo nombre de pila**, cargá
también el apellido en el campo "Nombre" de la sección "Equipo" (ej.
"Martín Pérez" y "Martín Gómez") — si el cliente solo dice "Martín" y hay
más de uno que coincide, el agente no elige por
su cuenta: le pide que aclare cuál.

## 6. Claude (Anthropic)

1. Conseguí una API key en [console.anthropic.com](https://console.anthropic.com)
   → `ANTHROPIC_API_KEY`.

## 7. Panel de administración (`/admin`)

Todo lo que antes había que editar a mano en `.env` (y reiniciar el
servidor) para cambiar un número de teléfono o un ID de Tokko ahora se
edita desde el navegador, en caliente, sin tocar la terminal:

1. En `.env`, completá `ADMIN_PASSWORD` con una contraseña — la que
   quieras, no la reutilices de otro lado. Sin esto, `/admin` devuelve un
   error 503 en vez de quedar sin protección.
2. Con el servidor corriendo, entrá a `http://localhost:3000/admin` (o tu
   dominio + `/admin` si ya lo tenés desplegado). Te va a pedir usuario y
   contraseña en una pantalla de login (dura 7 días en el navegador;
   "Cerrar sesión" desde el panel de inicio la borra antes). El usuario es
   libre — hoy no hay distintos niveles de acceso, todos entran con la
   misma `ADMIN_PASSWORD`, pero queda guardado en la sesión para cuando se
   sumen roles más adelante.
3. Desde ahí hay varios botones (el menú principal, `/admin`, está pensado
   para poder ir sumando más):
   - **Métricas** (`/admin/metrics`): consultas por día, canal de origen,
     emprendimiento y tipología — ver más abajo.
   - **Configuración** (`/admin/config`): donde se edita todo lo que antes
     había que tocar a mano en `.env` y reiniciar el servidor — el equipo
     (nombre, teléfono, mail, calendario y motivo de escalamiento de cada
     persona), la carpeta y el archivo de links de Zonaprop en Drive, los
     IDs de Tokko (operación venta/alquiler y las etapas del workflow de
     Oportunidades — podés agregar, sacar o renombrar etapas libremente,
     no es una lista fija), y la duración/horario/días laborales para
     coordinar visitas. Al guardar, los cambios aplican al toque, sin
     reiniciar nada.
   - **Ver conversaciones** (`/admin/conversations`): historial y mapa de
     cada charla — ver más abajo.
   - **Contactos** (`/admin/contacts`): todos los clientes que escribieron,
     con la etapa de Oportunidades que el agente detectó en la charla — ver
     más abajo.
   - **Resumen de hoy** (`/admin/daily-summary`): ver más abajo.
   - **Contactar a un cliente** (`/admin/contact`): iniciar una
     conversación ahora — ver "Iniciar una conversación" más abajo.

### Contactos (`/admin/contacts`)

Como Tokko no permite actualizar la etapa de un contacto por API (ver
sección 1, punto 4), el agente anota localmente qué etapa (y qué tier, ver
"Perfilado de clientes" más abajo) le corresponde a cada cliente según
cómo viene la charla — no lo escribe en Tokko, solo lo registra.

**Lista** (`/admin/contacts`): una fila compacta por contacto — nombre,
teléfono, y los badges de tier/etapa si hay alguno anotado. Arriba hay un
buscador que filtra al toque (sin recargar la página) por nombre,
apellido, teléfono, email, propiedad/emprendimiento consultado o etapa —
alcanza con que el texto que escribas aparezca en cualquiera de esos
datos del contacto. Tocando una fila se abre su ficha.

**Ficha de contacto** (`/admin/contacts/<teléfono>`), pensada al estilo de
la ficha de un contacto en Tokko (avatar, nombre, mail, teléfono, estado):

- **Nombre** (el que llegó por WhatsApp), **tier** y **etapa** actuales
  anotados (si hay).
- **Email** — solo aparece si el cliente lo escribió en algún mensaje (no
  hay otra fuente: Tokko no expone el contacto por teléfono, ver sección
  1). Si nunca lo mandó, dice "Sin datos".
- **Teléfono / WhatsApp**.
- **Actividad**: cantidad de mensajes y rango de fechas de la charla.
- **Preguntó por**: emprendimientos y zonas que mencionó durante la
  charla (se arma solo, a partir de las búsquedas que hizo el agente).
- El motivo del tier y de la etapa, si el agente dio uno.
- Un link **"Ver conversación completa"** que lleva al detalle completo
  de esa charla (la misma vista de "Ver conversaciones").

Es la pantalla para que alguien del equipo revise cada contacto de tanto
en tanto y aplique a mano en Tokko lo que corresponda (cambiar la etapa,
priorizar según el tier, etc.).

### Perfilado de clientes (`/admin/config` → "Perfilado de clientes")

El agente también clasifica a cada cliente en uno de **4 tiers fijos**
(Tier 1 a Tier 4) según cómo viene la charla — presupuesto, urgencia,
nivel de definición, lo que sea relevante para tu negocio. A diferencia de
las etapas de Tokko, acá no se pueden agregar ni sacar filas, siempre son
4: lo único que se configura es el **nombre** de cada tier (podés
renombrarlo, ej. "Tier 1 — Prioridad alta") y sus **características en
lenguaje natural** — un texto libre que describe qué tiene que mostrar un
cliente para caer en ese tier (ej. "Ya definió presupuesto y zona
concretos, y pidió coordinar una visita"). Cuanto más concreto el texto,
mejor clasifica el agente. Un tier con el campo de características vacío
queda deshabilitado — el agente no lo tiene entre las opciones.

El agente nunca le menciona esto al cliente ni en la charla ni de ninguna
otra forma — es un dato puramente interno, que se ve en la ficha de cada
contacto en `/admin/contacts`.

### Métricas (`/admin/metrics`)

Muestra consultas nuevas por día (últimos 14 días) y, con el selector "Ver
por" de arriba, se elige qué desglose ver — Canal de origen, Emprendimiento,
Tipología, o cualquier combinación. Con exactamente dos tildadas, además de
cada una por separado se arma un cruce entre ambas (ej. cuántas
conversaciones preguntaron por "Torres del Parque" y vinieron de
Instagram). Con las tres tildadas (el default) no se arma cruce, para no
terminar con una tabla enorme — ahí quedan las tres por separado.

- **Canal**: se detecta en el primer mensaje de cada conversación. Si viene
  de un anuncio de Instagram/Facebook ("click to WhatsApp") se detecta
  automático, con los datos de referral que manda Meta y reenvía Twilio; si
  el texto menciona "Zonaprop" se cuenta como tal; el resto queda como
  "WhatsApp directo". La detección de Zonaprop es un patrón simple sobre el
  texto del primer mensaje — convendría revisarlo con casos reales, capaz
  el mensaje precargado no dice literalmente "Zonaprop".
- **Emprendimiento**: se completa la primera vez que el agente identifica
  un proyecto puntual en la charla (al usar `search_developments` o
  `get_development_details`) — si el cliente nunca preguntó por un
  emprendimiento por nombre, esa conversación no aporta datos acá.
- **Tipología**: se completa con la cantidad de ambientes cuando el cliente
  la menciona en una búsqueda de propiedades — mismo caso, no todas las
  conversaciones la tienen.

### Estilo del agente

En la sección "Estilo del agente" hay dos campos:

- **Instrucciones generales**: texto libre que se suma a las instrucciones
  base del agente (no las reemplaza) — ej. "firmá como Equipo ismo", "evitá
  emojis".
- **Tonos especiales por propiedad/emprendimiento**: una lista de "Nombre
  de propiedad/emprendimiento" → "Instrucciones de tono" (ej. "Torres del
  Parque" → "tono más formal, resaltar exclusividad"). No hay ningún
  matching automático por código: se le pasa al agente la lista entera y es
  él quien decide cuál aplica según de qué habla la conversación (ver
  `buildSystemPrompt` en `src/agent/orchestrator.ts`).

### Iniciar una conversación (el agente escribe primero)

Por defecto el agente solo responde — no puede escribirle primero a
alguien que nunca le mandó un mensaje, porque WhatsApp exige un **Content
Template aprobado por Meta** para eso (no deja mandar texto libre a quien
no inició la conversación). Para habilitar esto:

1. Creá el template en Twilio (Content Template Builder → nuevo template
   de texto, categoría **Utility**, con dos variables `{{1}}` (nombre) y
   `{{2}}` (motivo) — ej. `Hola {{1}}! Somos de ismo Propiedades. Nos
   comentaron que estás buscando {{2}}. ¿En qué te podemos ayudar?`) y
   mandalo a aprobación de WhatsApp. **Ojo**: esto probablemente no se
   apruebe/funcione mientras sigas en el sandbox de Twilio — Meta exige un
   número de WhatsApp productivo verificado para este tipo de template.
2. Una vez aprobado, copiá el **Content SID** (`HX...`) y pegalo en
   `/admin/config`, sección "Iniciar conversación", junto con el texto
   exacto del template (con `{{1}}`/`{{2}}` en el mismo orden — Twilio no
   devuelve el texto ya renderizado al mandar un template, así que este
   texto es lo que usa el agente para "recordar" qué le dijo al cliente).
3. Con eso cargado, desde el botón "Contactar a un cliente" del menú
   principal (`/admin/contact`) cualquiera con acceso al panel puede cargar
   el número, nombre y motivo de un cliente, y el agente le manda el
   mensaje y sigue la conversación
   normalmente cuando responda.

### Resumen diario

En la sección "Resumen diario" se elige la hora local (Argentina) en la
que el agente manda, por WhatsApp y a los números de "Números de
contacto", un resumen de las conversaciones del día — quién escribió, qué
buscaba, en qué quedó. Si no hubo actividad ese día, no manda nada. No
hace falta ningún servicio externo: se arma con `data/conversations.jsonl`
(ver más abajo) y un disparador interno del propio servidor (sin
`node-cron` ni nada por el estilo, un `setTimeout` que se reprograma solo
cada vez que dispara).

Además del envío automático de fin del día, el botón "Resumen de hoy" del
panel (`/admin/daily-summary`) arma el mismo resumen al toque, con la
actividad registrada hasta ese momento — sin esperar a la hora
configurada ni mandar nada por WhatsApp, solo para verlo en el navegador
cuando se quiera.

### Ver conversaciones (`/admin/conversations`)

Desde el botón "Ver conversaciones" del panel se accede a la lista de
todos los que le escribieron al agente. Al entrar a una en particular, se
arma automáticamente (con Claude) un diagrama de flujo de esa charla puntual
— qué preguntó, qué se le contestó, en qué derivó — además del historial
completo en texto debajo.

### Historial durable

Tanto el resumen diario como el diagrama de conversaciones leen de
`data/conversations.jsonl` — un registro simple (una línea de JSON por
mensaje visible, cliente o agente) separado del historial en memoria que
usa el agente para responder (ese sigue viviendo solo en RAM y se pierde
al reiniciar, como siempre). Tampoco se sube a git.

Lo que **no** se mueve a `/admin` (queda en `.env`, requiere reiniciar el
servidor si cambia): las credenciales de Twilio, Tokko, Google y
Anthropic, y la ruta del archivo de la cuenta de servicio de Google — son
secretos de infraestructura, no configuración de negocio, y exponerlos en
una pantalla sería un riesgo de seguridad innecesario.

Los valores quedan guardados en `data/settings.json` (no se sube a git,
como `.env`) — la primera vez que arranca el servidor, ese archivo se crea
solo tomando lo que ya tenías cargado en `.env` (si tenías algo), así que
no perdés la configuración que ya te andaba funcionando.

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
