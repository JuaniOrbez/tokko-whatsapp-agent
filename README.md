# tokko-whatsapp-agent

Agente que atiende el WhatsApp Business de la inmobiliaria: lee las consultas
entrantes, responde usando información real de Tokko (propiedades), comparte
archivos guardados en Google Drive, y mantiene al día el CRM de Tokko —
crea el contacto, le agrega notas de la conversación y actualiza su estado
en el workflow de Oportunidades.

## Cómo funciona

```
WhatsApp Business (Meta Cloud API)
        │  webhook (mensaje entrante)
        ▼
  src/whatsapp/webhook.ts  ── responde 200 rápido, procesa en background
        ▼
  src/agent/orchestrator.ts
        ├─ tokkoClient.ensureContact()  → crea/busca el contacto en Tokko (best-effort)
        ├─ tokkoClient.addNote()        → registra el mensaje entrante (best-effort)
        └─ loop agente (Claude + tools) ────┐
                                             │
   ┌─────────────────────────────────────────┘
   │  Claude decide qué herramienta llamar en cada paso:
   ▼
  search_properties / get_property_details  → src/tokko/client.ts
  share_file                                 → src/drive/client.ts + WhatsApp
  update_opportunity_stage                   → src/tokko/client.ts (contact.opportunity_status)
  save_lead_notes                            → src/tokko/client.ts
        │
        ▼
  respuesta final → src/whatsapp/client.ts → WhatsApp
```

Cada mensaje entrante primero intenta asegurar que exista el contacto en
Tokko y registra el mensaje como nota — esto es **best-effort**: si falla
(ver limitación de permisos más abajo), se loguea y la conversación sigue
igual, porque lo que nunca puede fallar es responderle al cliente. Después
Claude (Claude Opus 5, vía la API de Anthropic) conduce la conversación con
acceso a herramientas para buscar propiedades, compartir archivos de Drive
y actualizar el CRM — así decide con criterio cuándo mover la etapa de
Oportunidad o guardar un dato relevante, en vez de seguir reglas rígidas.

En esta cuenta de Tokko no existe un recurso "Oportunidad" separado: el
estado del embudo vive directo en el campo `opportunity_status` de cada
contacto.

## Antes de arrancar

**Este repo es un scaffold verificado en vivo contra una cuenta real de
Tokko, pero con una limitación real pendiente de resolver:**

1. **WhatsApp Business Cloud API** — todavía no configurada, necesitás
   crear la app en Meta (ver `docs/SETUP.md`).
2. **Tokko** — `/property/` y `/contact/` (listados) están confirmados en
   vivo: funcionan y traen los campos que usa este agente. **La API key
   actual es de solo lectura** — confirmamos que `PATCH`/`POST` contra
   `/contact/{id}/` son rechazados. Esto significa que, hasta que Tokko
   habilite permisos de escritura para la cuenta, el agente puede **buscar
   propiedades y contactos pero no crear/actualizar nada** (se salta esa
   parte silenciosamente, sin afectar la respuesta al cliente). Ver
   `docs/SETUP.md` para el paso exacto de qué pedirle a Tokko.
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
    client.ts               búsqueda de propiedades/contactos, notas, etapa de oportunidad
  drive/
    client.ts                búsqueda y compartido de archivos
  agent/
    tools.ts                 herramientas que Claude puede usar
    orchestrator.ts          loop del agente por cada mensaje entrante
    sessionStore.ts           historial de conversación en memoria
```

## Limitaciones conocidas / próximos pasos

- **La API key de Tokko es de solo lectura** (confirmado en vivo) — hasta
  que se habiliten permisos de escritura, el agente no puede crear
  contactos, agregar notas ni cambiar la etapa de oportunidad. Ver
  `docs/SETUP.md` → sección Tokko.
- `addNote` (`/contact/{id}/note/`) tampoco está confirmado como endpoint
  real, más allá del problema de permisos — puede que Tokko no exponga
  notas de seguimiento por API v1.
- El historial de conversación vive en memoria del proceso — se pierde si el
  servidor se reinicia. Las notas en Tokko (una vez que la escritura esté
  habilitada) quedan como registro durable; para volumen alto conviene mover
  el historial a Redis o una base de datos.
- Solo se procesan mensajes de texto entrantes. Agregar soporte para audio
  (transcribir) o imágenes es una extensión natural si hace falta.
- El mapeo de IDs de operación (venta/alquiler) y de etapas del workflow de
  oportunidades se configura por variables de entorno porque son específicos
  de cada cuenta de Tokko (ver `docs/SETUP.md`).
- No hay tests automatizados todavía.
