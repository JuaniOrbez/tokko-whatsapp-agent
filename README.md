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
        ├─ tokkoClient.ensureContact()      → crea/busca el contacto en Tokko
        ├─ tokkoClient.ensureOpportunity()  → crea/busca su oportunidad
        ├─ tokkoClient.addNote()            → registra el mensaje entrante
        └─ loop agente (Claude + tools) ────┐
                                             │
   ┌─────────────────────────────────────────┘
   │  Claude decide qué herramienta llamar en cada paso:
   ▼
  search_properties / get_property_details  → src/tokko/client.ts
  share_file                                 → src/drive/client.ts + WhatsApp
  update_opportunity_stage                   → src/tokko/client.ts
  save_lead_notes                            → src/tokko/client.ts
        │
        ▼
  respuesta final → src/whatsapp/client.ts → WhatsApp
```

Cada mensaje entrante primero asegura que exista el contacto y la
oportunidad en Tokko (determinístico, no depende del modelo), y registra el
mensaje como nota. Después Claude (Claude Opus 5, vía la API de Anthropic)
conduce la conversación con acceso a herramientas para buscar propiedades,
compartir archivos de Drive y actualizar el CRM — así decide con criterio
cuándo mover la oportunidad de etapa o guardar un dato relevante, en vez de
seguir reglas rígidas.

## Antes de arrancar

**Este repo es un scaffold funcional, no un integración ya probada en
producción.** Tres piezas dependen de credenciales y datos que solo vos
podés conseguir, y que no fue posible verificar sin acceso a internet al
escribir este código:

1. **WhatsApp Business Cloud API** — necesitás crear la app en Meta.
2. **Tokko** — la búsqueda de propiedades (`/property/search/`,
   `/property/{id}/`) usa los endpoints públicos y estables de la API de
   Tokko. Los de **contacto, notas y oportunidades** (`src/tokko/client.ts`,
   marcados `VERIFICAR`) siguen la convención REST general de Tokko pero
   **hay que confirmar los nombres exactos de endpoint y campos contra la
   documentación de tu cuenta** (con tu API key, en
   `https://www.tokkobroker.com/api/v1/docs/` o pidiéndosela a tu ejecutivo
   de cuenta de Tokko) antes de ir a producción.
3. **Google Drive** — cuenta de servicio con acceso de lectura a la carpeta
   donde están los folletos/planos.

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
    client.ts               búsqueda de propiedades, contactos, notas, oportunidades
  drive/
    client.ts                búsqueda y compartido de archivos
  agent/
    tools.ts                 herramientas que Claude puede usar
    orchestrator.ts          loop del agente por cada mensaje entrante
    sessionStore.ts           historial de conversación en memoria
```

## Limitaciones conocidas / próximos pasos

- El historial de conversación vive en memoria del proceso — se pierde si el
  servidor se reinicia. Las notas en Tokko quedan como registro durable;
  para volumen alto conviene mover el historial a Redis o una base de datos.
- Solo se procesan mensajes de texto entrantes. Agregar soporte para audio
  (transcribir) o imágenes es una extensión natural si hace falta.
- El mapeo de IDs de operación (venta/alquiler) y de etapas del workflow de
  oportunidades se configura por variables de entorno porque son específicos
  de cada cuenta de Tokko (ver `docs/SETUP.md`).
- No hay tests automatizados todavía.
