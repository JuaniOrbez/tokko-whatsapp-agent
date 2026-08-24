# tokko-whatsapp-agent

Agente que atiende el WhatsApp Business de la inmobiliaria: lee las consultas
entrantes, responde usando información real de Tokko (propiedades) y
comparte archivos guardados en Google Drive. Cada lead nuevo queda cargado
en Tokko como una Consulta pendiente de aprobación — el mismo flujo manual
que ya usás para Zonaprop y el resto de los canales, salvo que Zonaprop
tiene una integración propia más profunda que crea el contacto de una (no
replicable desde la API pública).

## Cómo funciona

```
WhatsApp Business (vía Twilio)
        │  webhook (mensaje entrante)
        ▼
  src/whatsapp/webhook.ts  ── responde 200 rápido, procesa en background
        ▼
  src/agent/orchestrator.ts
        ├─ tokkoClient.findContactByPhone()  → ¿el contacto ya existe? (lectura)
        ├─ tokkoClient.submitInquiry()       → si es nuevo: crea una Consulta en Tokko (best-effort)
        └─ loop agente (Claude + tools) ────┐
                                             │
   ┌─────────────────────────────────────────┘
   │  Claude decide qué herramienta llamar en cada paso:
   ▼
  search_properties / get_property_details  → src/tokko/client.ts (lectura)
  share_file                                 → src/drive/client.ts + WhatsApp
  update_opportunity_stage                   → src/tokko/client.ts (solo si Tokko habilita escritura)
  save_lead_notes                            → src/tokko/client.ts (nueva Consulta, best-effort)
        │
        ▼
  respuesta final → src/whatsapp/client.ts → WhatsApp
```

Cada mensaje entrante primero revisa (lectura, siempre funciona) si el
número ya es un contacto conocido en Tokko. Si es la primera vez, manda la
consulta a Tokko — esto es **best-effort**: si falla, se loguea y la
conversación sigue igual, porque lo que nunca puede fallar es responderle
al cliente. Después Claude (Claude Opus 5, vía la API de Anthropic) conduce
la conversación con acceso a herramientas para buscar propiedades y
compartir archivos de Drive, y decide con criterio cuándo vale la pena
dejar un dato relevante registrado en Tokko.

En esta cuenta de Tokko no existe un recurso "Oportunidad" separado: el
estado del embudo vive directo en el campo `opportunity_status` de cada
contacto ya aprobado.

## Cómo funciona el lado de Tokko (importante, leer antes de asumir nada)

Verificado en vivo contra una cuenta real (no es un supuesto):

- **Lectura de propiedades y contactos**: funciona sin problemas
  (`/property/`, `/contact/`).
- **Crear un lead nuevo**: funciona vía `POST /webcontact/` (el mismo
  endpoint que usan los portales chicos/sitios propios) — pero **no crea un
  Contacto directamente**. Crea una "Consulta" que aparece en el panel de
  Tokko en **Consultas → Pendientes**, y alguien del equipo la tiene que
  aprobar a mano con el botón "Crear un nuevo contacto". No hay forma de
  saltear ese paso por API — es una decisión de producto de Tokko para
  mantener la calidad del CRM, y aplica también a cualquier consulta que no
  venga de un portal con integración privilegiada (Zonaprop sí tiene una,
  el resto no).
- **Actualizar un contacto ya existente** (`PATCH`/`POST` sobre
  `/contact/{id}/`, para notas o cambiar la etapa de Oportunidad): está
  **bloqueado** — devuelve el texto plano `GET` en vez de un JSON, algo que
  parece un firewall/CDN delante de `www.tokkobroker.com` que solo deja
  pasar `GET` en esa ruta. `save_lead_notes` esquiva esto mandando una
  Consulta nueva (mismo mecanismo que crear el lead) en vez de editar el
  contacto in-place; `update_opportunity_stage` no tiene forma de esquivarlo
  y queda sin efecto hasta que Tokko lo habilite.

## Antes de arrancar

1. **WhatsApp vía Twilio** — se eligió Twilio en vez de conectar directo
   con Meta porque la verificación por SMS de Meta for Developers no le
   estaba entregando código a números argentinos (probado con dos números).
   Falta activar el sandbox de Twilio para probar (ver `docs/SETUP.md`).
2. **Tokko** — ver la sección de arriba. La API key ya está probada y
   funcionando para lectura y para crear consultas nuevas.
3. **Google Drive** — todavía no configurada, necesitás la cuenta de
   servicio (ver `docs/SETUP.md`).

Ver la guía paso a paso en [`docs/SETUP.md`](docs/SETUP.md).

## Desarrollo local

```bash
npm install
cp .env.example .env   # completar credenciales
npm run dev             # levanta el server con recarga automática
```

El webhook de WhatsApp necesita una URL pública HTTPS. Para probar en local
podés exponer el puerto con una herramienta de túnel (ngrok, cloudflared,
etc.) y usar esa URL al configurar el webhook en Meta.

```bash
npm run typecheck   # chequeo de tipos
npm run build        # compila a dist/
npm start             # corre dist/index.js (producción)
```

## Estructura

```
src/
  config.ts              validación de variables de entorno
  logger.ts
  index.ts                servidor Express
  whatsapp/
    client.ts              enviar texto / documentos / marcar leído
    webhook.ts              verificación + recepción de mensajes
  tokko/
    client.ts               búsqueda de propiedades/contactos, alta de consultas, etapa de oportunidad
  drive/
    client.ts                búsqueda y compartido de archivos
  agent/
    tools.ts                 herramientas que Claude puede usar
    orchestrator.ts          loop del agente por cada mensaje entrante
    sessionStore.ts           historial de conversación + dedupe de consultas enviadas
```

## Limitaciones conocidas / próximos pasos

- Cada lead nuevo por WhatsApp cae en **Consultas → Pendientes** de Tokko,
  igual que la mayoría de tus otros canales — necesita que alguien lo
  apruebe a mano. No es un bug, es cómo funciona la API pública de Tokko.
- `update_opportunity_stage` no tiene efecto hasta que Tokko habilite
  escritura sobre `/contact/{id}/` para esta cuenta.
- El historial de conversación y el "ya mandé la consulta de este número"
  viven en memoria del proceso — se pierden si el servidor se reinicia. En
  el peor caso se manda una consulta de más a Tokko, no es grave; para
  volumen alto conviene mover esto a Redis o una base de datos.
- Solo se procesan mensajes de texto entrantes. Agregar soporte para audio
  (transcribir) o imágenes es una extensión natural si hace falta.
- El mapeo de IDs de operación (venta/alquiler) y de etapas del workflow de
  oportunidades se configura por variables de entorno porque son específicos
  de cada cuenta de Tokko (ver `docs/SETUP.md`).
- No hay tests automatizados todavía.
